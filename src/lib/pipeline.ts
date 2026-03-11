import { ApifyClient } from "apify-client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────
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

export interface PipelineResult {
  success: boolean;
  leadsProcessed: number;
  error?: string;
  steps: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

  // Try Apollo
  if (fullName && company && process.env.APOLLO_API_KEY) {
    try {
      const nameParts = fullName.split(" ");
      const res = await fetchWithTimeout(
        "https://api.apollo.io/v1/people/match",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": process.env.APOLLO_API_KEY!,
          },
          body: JSON.stringify({
            first_name: nameParts[0] || "",
            last_name: nameParts.slice(1).join(" ") || "",
            organization_name: company,
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        email = data.person?.email || null;
      }
    } catch {
      // timeout or error — continue
    }
  }

  // Fallback: Hunter
  if (!email && fullName && company && process.env.HUNTER_API_KEY) {
    try {
      const nameParts = fullName.split(" ");
      const domain = company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
      const res = await fetchWithTimeout(
        `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(nameParts[0] || "")}&last_name=${encodeURIComponent(nameParts.slice(1).join(" ") || "")}&api_key=${process.env.HUNTER_API_KEY}`
      );
      if (res.ok) {
        const data = await res.json();
        email = data.data?.email || null;
      }
    } catch {
      // timeout or error — continue
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

// Run N promises with concurrency limit
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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return results;
}

// ─── Main Pipeline ────────────────────────────────────────────────────

export async function runPipeline(
  postUrl: string,
  userId: string
): Promise<PipelineResult> {
  const steps: string[] = [];
  const supabase = getSupabaseAdmin();

  // ── Step 1: Apify — scrape post reactions ──────────────────────────
  steps.push("Starting Apify scrape...");
  const apify = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  let profiles: ApifyProfile[] = [];

  try {
    const run = await apify
      .actor("curious_coder/linkedin-post-reactions-scraper")
      .call({ postUrl, maxItems: 100 }, { waitSecs: 90 });

    const { items } = await apify.dataset(run.defaultDatasetId).listItems();
    profiles = items as unknown as ApifyProfile[];
    steps.push(`Apify returned ${profiles.length} profiles`);
  } catch (error: any) {
    steps.push(`Apify failed: ${error?.message}`);
    return { success: false, leadsProcessed: 0, error: `Apify failed: ${error?.message}`, steps };
  }

  if (profiles.length === 0) {
    steps.push("No profiles found for this post");
    return { success: true, leadsProcessed: 0, steps };
  }

  // ── Step 2: Gemini — parse job titles (single batch) ───────────────
  steps.push("Parsing headlines with Gemini...");
  const parsedTitles: Map<number, ParsedTitle> = new Map();

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const headlines = profiles
      .map((p, i) => `${i + 1}. "${p.headline || "N/A"}"`)
      .join("\n");

    const result = await model.generateContent(
      `Extract the job title and company name from each LinkedIn headline below.
Return a JSON array where each element has: {"index": <number>, "jobTitle": "<string>", "company": "<string>"}.
If you cannot determine a field, use an empty string.
Return ONLY the JSON array, no markdown, no explanation.

Headlines:
${headlines}`
    );

    const text = result.response.text();
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed: { index: number; jobTitle: string; company: string }[] = JSON.parse(jsonStr);

    parsed.forEach((item) => {
      parsedTitles.set(item.index - 1, { jobTitle: item.jobTitle, company: item.company });
    });
    steps.push(`Gemini parsed ${parsedTitles.size} titles`);
  } catch (error: any) {
    steps.push(`Gemini parsing failed (continuing): ${error?.message}`);
  }

  // ── Step 3: Enrich with emails — 5 concurrent ─────────────────────
  steps.push(`Enriching ${profiles.length} leads (parallel)...`);
  const enrichmentTasks = profiles.map(
    (profile, i) => () => enrichSingleProfile(profile, parsedTitles.get(i))
  );
  const enrichedLeads = await parallelLimit(enrichmentTasks, 5);

  const emailCount = enrichedLeads.filter((l) => l.email).length;
  steps.push(`Enriched ${enrichedLeads.length} leads (${emailCount} emails found)`);

  // ── Step 4: Save to Supabase ───────────────────────────────────────
  steps.push("Saving to database...");
  const leadsToInsert = enrichedLeads.map((lead) => ({
    user_id: userId,
    source_url: postUrl,
    ...lead,
  }));

  const { error: insertError } = await supabase
    .from("scraped_leads")
    .insert(leadsToInsert);

  if (insertError) {
    steps.push(`Database insert failed: ${insertError.message}`);
    return { success: false, leadsProcessed: 0, error: insertError.message, steps };
  }

  steps.push("Pipeline complete!");
  return { success: true, leadsProcessed: enrichedLeads.length, steps };
}
