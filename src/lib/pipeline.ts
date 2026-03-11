import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────
interface ApifyProfile {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  profileUrl?: string;
  profile_url?: string; // Some actors use underscore
  publicIdentifier?: string;
  // Support for apimaestro output format
  reactor?: {
    name?: string;
    headline?: string;
    profileUrl?: string;
    profile_url?: string;
    photoUrl?: string;
  };
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

export interface PipelineEvent {
  type: "step" | "error" | "done";
  message: string;
  data?: Record<string, unknown>;
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
    profile.reactor?.name ||
    (profile.firstName || profile.lastName
      ? `${profile.firstName || ""} ${profile.lastName || ""}`.trim()
      : "Unknown Name");
  const headline = profile.headline || profile.reactor?.headline || "";
  const profileUrl =
    profile.profileUrl ||
    profile.profile_url ||
    profile.reactor?.profileUrl ||
    profile.reactor?.profile_url ||
    "";

  const company = parsed?.company || "";
  const jobTitle = parsed?.jobTitle || headline || "";
  let email: string | null = null;

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
      /* timeout — continue */
    }
  }

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
      /* timeout — continue */
    }
  }

  return {
    full_name: fullName,
    linkedin_url:
      profileUrl ||
      (profile.publicIdentifier
        ? `https://linkedin.com/in/${profile.publicIdentifier}`
        : ""),
    headline: headline,
    job_title: jobTitle,
    company,
    email,
    status: "completed",
  };
}

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

// ─── Main Pipeline (streaming via callback) ───────────────────────────

export async function runPipeline(
  postUrl: string,
  userId: string,
  onEvent: (event: PipelineEvent) => void
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // ── Env check ──────────────────────────────────────────────────────
  const missingVars: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missingVars.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingVars.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.APIFY_API_TOKEN) missingVars.push("APIFY_API_TOKEN");
  if (!process.env.GEMINI_API_KEY) missingVars.push("GEMINI_API_KEY");

  if (missingVars.length > 0) {
    onEvent({
      type: "error",
      message: `Missing environment variables: ${missingVars.join(", ")}. Set them in Vercel → Settings → Environment Variables.`,
    });
    return;
  }

  // ── Step 1: Apify ──────────────────────────────────────────────────
  onEvent({ type: "step", message: "🔍 Step 1/4 — Scraping LinkedIn post reactions with Apify..." });

  const apifyToken = process.env.APIFY_API_TOKEN;
  let profiles: ApifyProfile[] = [];

  try {
    // Switch to a high-quality, free-credit-friendly actor (No Rental Fee)
    const actorId = "apimaestro~linkedin-post-reactions";
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}&waitForFinish=90`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          post_urls: [postUrl],
          limit: 100 
        }),
      }
    );

    if (!runRes.ok) {
      const errorData = await runRes.json();
      throw new Error(errorData.error?.message || `Apify API returned ${runRes.status}`);
    }

    const runData = await runRes.json();
    const datasetId = runData.data.defaultDatasetId;

    // Fetch the results
    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`
    );
    
    if (!itemsRes.ok) {
      throw new Error("Failed to fetch results from Apify dataset");
    }

    profiles = await itemsRes.json();
    onEvent({
      type: "step",
      message: `✅ Apify found ${profiles.length} reactor${profiles.length !== 1 ? "s" : ""}`,
      data: { count: profiles.length },
    });
  } catch (error: any) {
    const msg = error?.message || String(error);
    onEvent({
      type: "error",
      message: `❌ Apify scraping failed: ${msg}. Check if your APIFY_API_TOKEN is valid and the LinkedIn URL is a post URL.`,
      data: { errorDetail: msg },
    });
    return;
  }

  if (profiles.length === 0) {
    onEvent({ type: "done", message: "⚠️ No reactors found on this post. Try a different post URL.", data: { leadsProcessed: 0 } });
    return;
  }

  // ── Step 2: Gemini ────────────────────────────────────────────────
  onEvent({ type: "step", message: "🤖 Step 2/4 — Parsing job titles with Gemini AI..." });

  const parsedTitles: Map<number, ParsedTitle> = new Map();
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const headlines = profiles
      .map((p, i) => `${i + 1}. "${p.headline || p.reactor?.headline || "N/A"}"`)
      .join("\n");

    const result = await model.generateContent(
      `Goal: Extract professional details from LinkedIn headlines.
Input: A list of headlines.
Task: For each headline, extract the "Job Title" and the "Company Name".
Output: Return a JSON array where each element has: {"index": <number>, "jobTitle": "<string>", "company": "<string>"}.

Rules:
1. If the company is mentioned with "@", "at", or " - ", extract it.
2. If company is not found, use an empty string.
3. Return ONLY the valid JSON array. No text before or after.

Headlines:
${headlines}`
    );

    const text = result.response.text();
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed: { index: number; jobTitle: string; company: string }[] = JSON.parse(jsonStr);

    parsed.forEach((item) => {
      parsedTitles.set(item.index - 1, { jobTitle: item.jobTitle, company: item.company });
    });
    onEvent({ type: "step", message: `✅ Gemini parsed ${parsedTitles.size} job titles` });
  } catch (error: any) {
    onEvent({ type: "step", message: `⚠️ Gemini parsing failed (${error?.message}), continuing without parsed titles...` });
  }

  // ── Step 3: Email Enrichment ──────────────────────────────────────
  onEvent({ type: "step", message: `📧 Step 3/4 — Enriching ${profiles.length} leads with emails (Apollo + Hunter)...` });

  const enrichmentTasks = profiles.map(
    (profile, i) => () => enrichSingleProfile(profile, parsedTitles.get(i))
  );
  const enrichedLeads = await parallelLimit(enrichmentTasks, 5);

  const emailCount = enrichedLeads.filter((l) => l.email).length;
  onEvent({
    type: "step",
    message: `✅ Enriched ${enrichedLeads.length} leads — ${emailCount} email${emailCount !== 1 ? "s" : ""} found`,
  });

  // ── Step 4: Save to Supabase ──────────────────────────────────────
  onEvent({ type: "step", message: "💾 Step 4/4 — Saving leads to database..." });

  const leadsToInsert = enrichedLeads.map((lead) => ({
    user_id: userId,
    source_url: postUrl,
    ...lead,
  }));

  const { error: insertError } = await supabase
    .from("scraped_leads")
    .insert(leadsToInsert);

  if (insertError) {
    onEvent({
      type: "error",
      message: `❌ Database save failed: ${insertError.message}. Check your Supabase table schema and service_role key.`,
      data: { errorDetail: insertError.message, code: insertError.code },
    });
    return;
  }

  onEvent({
    type: "done",
    message: `🎉 Done! ${enrichedLeads.length} leads extracted and saved (${emailCount} with emails).`,
    data: { leadsProcessed: enrichedLeads.length, emailsFound: emailCount },
  });
}
