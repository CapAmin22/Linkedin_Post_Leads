import { task, logger } from "@trigger.dev/sdk/v3";
import { ApifyClient } from "apify-client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

// Types
interface ApifyProfile {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  profileUrl?: string;
  publicIdentifier?: string;
}

interface ParsedTitle {
  jobTitle: string;
  company: string;
}

interface EnrichedLead {
  full_name: string;
  linkedin_url: string;
  headline: string;
  job_title: string;
  company: string;
  email: string | null;
  status: string;
}

// Initialize clients (these read env vars at task execution time in Trigger.dev runtime)
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getApifyClient() {
  return new ApifyClient({ token: process.env.APIFY_API_TOKEN });
}

function getGeminiModel() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

// Helper: fetch with timeout (default 10s)
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Helper: process enrichment for a single profile in parallel
async function enrichSingleProfile(
  profile: ApifyProfile,
  parsed: ParsedTitle | undefined
): Promise<EnrichedLead> {
  const fullName =
    profile.fullName ||
    `${profile.firstName || ""} ${profile.lastName || ""}`.trim();
  const company = parsed?.company || "";
  const jobTitle = parsed?.jobTitle || profile.headline || "";

  let email: string | null = null;

  // Try Apollo first
  if (fullName && company && process.env.APOLLO_API_KEY) {
    try {
      const nameParts = fullName.split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const apolloRes = await fetchWithTimeout(
        "https://api.apollo.io/v1/people/match",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": process.env.APOLLO_API_KEY!,
          },
          body: JSON.stringify({
            first_name: firstName,
            last_name: lastName,
            organization_name: company,
          }),
        },
        8000 // 8s timeout per Apollo call
      );

      if (apolloRes.ok) {
        const apolloData = await apolloRes.json();
        email = apolloData.person?.email || null;
      }
    } catch {
      // Silently continue — timeout or network error
    }
  }

  // Fallback to Hunter
  if (!email && fullName && company && process.env.HUNTER_API_KEY) {
    try {
      const nameParts = fullName.split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const domain =
        company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";

      const hunterRes = await fetchWithTimeout(
        `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(
          domain
        )}&first_name=${encodeURIComponent(
          firstName
        )}&last_name=${encodeURIComponent(
          lastName
        )}&api_key=${process.env.HUNTER_API_KEY}`,
        {},
        8000
      );

      if (hunterRes.ok) {
        const hunterData = await hunterRes.json();
        email = hunterData.data?.email || null;
      }
    } catch {
      // Silently continue
    }
  }

  return {
    full_name: fullName,
    linkedin_url:
      profile.profileUrl ||
      (profile.publicIdentifier
        ? `https://linkedin.com/in/${profile.publicIdentifier}`
        : ""),
    headline: profile.headline || "",
    job_title: jobTitle,
    company,
    email,
    status: "completed",
  };
}

// Helper: run promises with concurrency limit
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Main task ────────────────────────────────────────────────────────
export const scrapeLeadsTask = task({
  id: "scrape-leads",
  maxDuration: 300, // 5 minutes max (was 10 — should be plenty now)
  retry: {
    maxAttempts: 2,
  },
  run: async (payload: { url: string; userId: string }) => {
    const { url, userId } = payload;
    const supabase = getSupabase();

    logger.info("Starting lead scraping pipeline", { url, userId });

    // ── Step 1: Apify — Extract post likers ──────────────────────────
    logger.info("Step 1: Calling Apify to extract post reactors");
    const apify = getApifyClient();

    let profiles: ApifyProfile[] = [];
    try {
      const run = await apify
        .actor("curious_coder/linkedin-post-reactions-scraper")
        .call(
          { postUrl: url, maxItems: 100 },
          { waitSecs: 120 } // Wait up to 2 min for Apify to finish
        );

      const { items } = await apify
        .dataset(run.defaultDatasetId)
        .listItems();
      profiles = items as unknown as ApifyProfile[];
      logger.info(`Apify returned ${profiles.length} profiles`);
    } catch (error) {
      logger.error("Apify extraction failed", { error });
      await supabase.from("scraped_leads").insert({
        user_id: userId,
        source_url: url,
        status: "failed",
        full_name: "PIPELINE_ERROR",
        linkedin_url: "",
        headline: `Apify extraction failed: ${error}`,
        job_title: "",
        company: "",
      });
      throw error;
    }

    if (profiles.length === 0) {
      logger.warn("No profiles found for this post");
      return { leadsProcessed: 0 };
    }

    // ── Step 2: Gemini — Parse job titles (single batch for ≤100) ────
    logger.info("Step 2: Parsing job titles with Gemini");
    const model = getGeminiModel();
    const parsedTitles: Map<number, ParsedTitle> = new Map();

    // Send all headlines in one batch (up to 100 is fine for Gemini)
    const headlines = profiles
      .map((p, idx) => `${idx + 1}. "${p.headline || "N/A"}"`)
      .join("\n");

    try {
      const prompt = `Extract the job title and company name from each LinkedIn headline below.
Return a JSON array where each element has: {"index": <number>, "jobTitle": "<string>", "company": "<string>"}.
If you cannot determine a field, use an empty string.
Return ONLY the JSON array, no markdown, no explanation.

Headlines:
${headlines}`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();

      const jsonStr = text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed: { index: number; jobTitle: string; company: string }[] =
        JSON.parse(jsonStr);

      parsed.forEach((item) => {
        parsedTitles.set(item.index - 1, {
          jobTitle: item.jobTitle,
          company: item.company,
        });
      });
      logger.info(`Gemini parsed ${parsedTitles.size} titles`);
    } catch (error) {
      logger.warn("Gemini parsing failed, continuing without parsed titles", {
        error,
      });
    }

    // ── Step 3: Enrich with emails — PARALLEL (5 concurrent) ─────────
    logger.info(
      `Step 3: Enriching ${profiles.length} leads (5 concurrent)`
    );

    const enrichmentTasks = profiles.map(
      (profile, i) => () => enrichSingleProfile(profile, parsedTitles.get(i))
    );

    const enrichedLeads = await parallelLimit(enrichmentTasks, 5);
    logger.info(`Enriched ${enrichedLeads.length} leads`);

    // ── Step 4: Save to Supabase (single batch for ≤100) ─────────────
    logger.info("Step 4: Saving leads to Supabase");
    const leadsToInsert = enrichedLeads.map((lead) => ({
      user_id: userId,
      source_url: url,
      ...lead,
    }));

    const { error: insertError } = await supabase
      .from("scraped_leads")
      .insert(leadsToInsert);

    if (insertError) {
      logger.error("Failed to insert leads", { error: insertError });
      throw insertError;
    }

    logger.info("Pipeline completed successfully", {
      totalLeads: enrichedLeads.length,
    });

    return { leadsProcessed: enrichedLeads.length };
  },
});
