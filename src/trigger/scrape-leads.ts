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

// ─── Main task ────────────────────────────────────────────────────────
export const scrapeLeadsTask = task({
  id: "scrape-leads",
  maxDuration: 600, // 10 minutes max
  retry: {
    maxAttempts: 2,
  },
  run: async (payload: { url: string; userId: string }) => {
    const { url, userId } = payload;
    const supabase = getSupabase();

    logger.info("Starting lead scraping pipeline", { url, userId });

    // ── Step 1: Apify — Extract post likers ──────────────────────────
    logger.info("Step 1: Calling Apify to extract post likers");
    const apify = getApifyClient();

    let profiles: ApifyProfile[] = [];
    try {
      const run = await apify.actor("curious_coder/linkedin-post-reactions-scraper").call({
        postUrl: url,
        maxItems: 100,
      });

      const { items } = await apify.dataset(run.defaultDatasetId).listItems();
      profiles = items as unknown as ApifyProfile[];
      logger.info(`Apify returned ${profiles.length} profiles`);
    } catch (error) {
      logger.error("Apify extraction failed", { error });
      // Insert a failed status record
      await supabase.from("scraped_leads").insert({
        user_id: userId,
        job_id: payload.url,
        source_url: url,
        status: "failed",
      });
      throw error;
    }

    if (profiles.length === 0) {
      logger.warn("No profiles found for this post");
      return { leadsProcessed: 0 };
    }

    // ── Step 2: Gemini — Parse job titles ────────────────────────────
    logger.info("Step 2: Parsing job titles with Gemini");
    const model = getGeminiModel();
    const parsedTitles: Map<number, ParsedTitle> = new Map();

    // Batch process headlines — send up to 20 at a time
    const batchSize = 20;
    for (let i = 0; i < profiles.length; i += batchSize) {
      const batch = profiles.slice(i, i + batchSize);
      const headlines = batch
        .map((p, idx) => `${i + idx + 1}. "${p.headline || "N/A"}"`)
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

        // Parse the JSON response — handle potential markdown wrapping
        const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed: { index: number; jobTitle: string; company: string }[] =
          JSON.parse(jsonStr);

        parsed.forEach((item) => {
          parsedTitles.set(item.index - 1, {
            jobTitle: item.jobTitle,
            company: item.company,
          });
        });
      } catch (error) {
        logger.warn(`Gemini parsing failed for batch starting at ${i}`, { error });
        // Continue with unparsed titles for this batch
      }
    }

    logger.info(`Gemini parsed ${parsedTitles.size} titles`);

    // ── Step 3: Apollo — Enrich with emails ──────────────────────────
    logger.info("Step 3: Enriching leads with Apollo");
    const enrichedLeads: EnrichedLead[] = [];

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const parsed = parsedTitles.get(i);
      const fullName =
        profile.fullName ||
        `${profile.firstName || ""} ${profile.lastName || ""}`.trim();
      const company = parsed?.company || "";
      const jobTitle = parsed?.jobTitle || profile.headline || "";

      let email: string | null = null;

      if (fullName && company && process.env.APOLLO_API_KEY) {
        try {
          const nameParts = fullName.split(" ");
          const firstName = nameParts[0] || "";
          const lastName = nameParts.slice(1).join(" ") || "";

          const apolloRes = await fetch(
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
            }
          );

          if (apolloRes.ok) {
            const apolloData = await apolloRes.json();
            email = apolloData.person?.email || null;
          }
        } catch (error) {
          logger.warn(`Apollo enrichment failed for ${fullName}`, { error });
        }
      }

      // Fallback to Hunter if Apollo fails to find an email or is not configured
      if (!email && fullName && company && process.env.HUNTER_API_KEY) {
        try {
          const nameParts = fullName.split(" ");
          const firstName = nameParts[0] || "";
          const lastName = nameParts.slice(1).join(" ") || "";

          // We'll roughly "guess" the domain from the company name by removing spaces to improve Hunter accuracy
          const domain = company.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";

          const hunterRes = await fetch(
            `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(
              domain
            )}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(
              lastName
            )}&api_key=${process.env.HUNTER_API_KEY}`
          );

          if (hunterRes.ok) {
            const hunterData = await hunterRes.json();
            email = hunterData.data?.email || null;
          }
        } catch (error) {
          logger.warn(`Hunter enrichment failed for ${fullName}`, { error });
        }
      }

      enrichedLeads.push({
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
        status: email ? "completed" : "completed",
      });
    }

    logger.info(`Enriched ${enrichedLeads.length} leads`);

    // ── Step 4: Save to Supabase ─────────────────────────────────────
    logger.info("Step 4: Saving leads to Supabase");
    const leadsToInsert = enrichedLeads.map((lead) => ({
      user_id: userId,
      job_id: undefined, // will be set below
      source_url: url,
      ...lead,
    }));

    // Batch insert in chunks of 50
    const insertBatchSize = 50;
    for (let i = 0; i < leadsToInsert.length; i += insertBatchSize) {
      const batch = leadsToInsert.slice(i, i + insertBatchSize);
      const { error } = await supabase.from("scraped_leads").insert(batch);

      if (error) {
        logger.error(`Failed to insert batch starting at ${i}`, { error });
        throw error;
      }
    }

    logger.info("Pipeline completed successfully", {
      totalLeads: enrichedLeads.length,
    });

    return { leadsProcessed: enrichedLeads.length };
  },
});
