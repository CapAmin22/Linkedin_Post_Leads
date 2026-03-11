import { createClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────
interface NormalizedProfile {
  fullName: string;
  headline: string;
  linkedinUrl: string;
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

async function retryFetch(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  delay = 2000
): Promise<Response> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, 15000);
      if (res.status === 429 && i < maxRetries) {
        await new Promise((r) => setTimeout(r, delay * Math.pow(2, i)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (i === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
  throw lastError;
}

// ─── Apify Data Normalizer ────────────────────────────────────────────
// The apimaestro actor returns: { reaction_type, reactor: { name, headline, profile_url } }
// Other actors might return flat: { fullName, headline, profileUrl }
// This function handles both and returns a clean, flat array.

function normalizeProfiles(
  rawItems: Record<string, any>[],
  onEvent: (event: PipelineEvent) => void
): NormalizedProfile[] {
  // Log the first raw item for diagnostics
  if (rawItems.length > 0) {
    const keys = Object.keys(rawItems[0]);
    const hasReactor = "reactor" in rawItems[0];
    onEvent({
      type: "step",
      message: `📋 Raw data shape: [${keys.join(", ")}]${hasReactor ? " (nested reactor format)" : " (flat format)"}`,
    });
  }

  return rawItems
    .map((item) => {
      const reactor = item.reactor || {};

      const fullName =
        item.fullName ||
        reactor.name ||
        item.name ||
        (item.firstName || item.lastName
          ? `${item.firstName || ""} ${item.lastName || ""}`.trim()
          : "");

      const headline =
        item.headline || reactor.headline || reactor.position || "";

      const linkedinUrl =
        item.profileUrl ||
        item.profile_url ||
        reactor.profileUrl ||
        reactor.profile_url ||
        reactor.url ||
        (item.publicIdentifier
          ? `https://linkedin.com/in/${item.publicIdentifier}`
          : "");

      return { fullName, headline, linkedinUrl };
    })
    .filter((p) => p.fullName || p.headline); // Skip empty entries
}

// ─── Regex Fallback Parser ────────────────────────────────────────────

function fallbackRegexParse(headline: string): ParsedTitle {
  // "Software Engineer at Google"
  const atMatch = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) return { jobTitle: atMatch[1].trim(), company: atMatch[2].trim() };

  // "Product Manager | Meta"
  const pipeMatch = headline.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { jobTitle: pipeMatch[1].trim(), company: pipeMatch[2].trim() };

  // "CEO - Acme Corp"
  const dashMatch = headline.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) return { jobTitle: dashMatch[1].trim(), company: dashMatch[2].trim() };

  // "Founder, TechStartup"
  const commaMatch = headline.match(/^(.+?),\s+(.+)$/);
  if (commaMatch) return { jobTitle: commaMatch[1].trim(), company: commaMatch[2].trim() };

  return { jobTitle: headline, company: "" };
}

// ─── AI Parsing: OpenAI → Gemini → Regex ──────────────────────────────

function buildPrompt(headlines: string): string {
  return `Goal: Extract professional details from LinkedIn headlines.
Input: A list of headlines.
Task: For each headline, extract the "Job Title" and the "Company Name".
Output: Return a JSON object with a "results" key containing an array where each element has: {"index": <number>, "jobTitle": "<string>", "company": "<string>"}.

Rules:
1. If the company is mentioned with "@", "at", " | ", " - ", or ",", extract it.
2. If company is not found, use an empty string.
3. Return ONLY valid JSON. No text outside the JSON.

Headlines:
${headlines}`;
}

function extractParsedArray(text: string): { index: number; jobTitle: string; company: string }[] {
  const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const rawJson = JSON.parse(jsonStr);

  if (Array.isArray(rawJson)) return rawJson;

  // OpenAI json_object mode wraps in an object
  for (const key of Object.keys(rawJson)) {
    if (Array.isArray(rawJson[key])) return rawJson[key];
  }

  return [];
}

async function parseWithOpenAI(prompt: string): Promise<string> {
  const res = await retryFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function parseWithGemini(prompt: string): Promise<string> {
  // Try multiple model identifiers and versions to avoid 404s
  const models = ["gemini-2.0-flash", "gemini-flash-latest"];
  const versions = ["v1", "v1beta"];
  let lastError: any;

  for (const model of models) {
    for (const version of versions) {
      try {
        const res = await retryFetch(
          `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, responseMimeType: "application/json" },
            }),
          }
        );

        if (res.ok) {
          const data = await res.json();
          return data.candidates[0].content.parts[0].text;
        }
        
        const errData = await res.json().catch(() => ({}));
        lastError = new Error(`Gemini ${model} (${version}) returned ${res.status}: ${errData.error?.message || "Unknown error"}`);
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}

// ─── Email Enrichment ─────────────────────────────────────────────────

// Track Apollo status to avoid repeated 403s on free plans
let apolloDisabled = false;

async function enrichSingleProfile(
  profile: NormalizedProfile,
  parsed: ParsedTitle | undefined
): Promise<EnrichedLead> {
  const { fullName, headline, linkedinUrl } = profile;
  const company = parsed?.company || "";
  const jobTitle = parsed?.jobTitle || headline || "";
  let email: string | null = null;

  // Strategy 1: Apollo via LinkedIn URL (no company needed!)
  if (linkedinUrl && process.env.APOLLO_API_KEY && !apolloDisabled) {
    try {
      const res = await fetchWithTimeout(
        "https://api.apollo.io/v1/people/match",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "X-Api-Key": process.env.APOLLO_API_KEY!,
          },
          body: JSON.stringify({ linkedin_url: linkedinUrl }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        email = data.person?.email || null;
      } else if (res.status === 403) {
        apolloDisabled = true; // Stop trying Apollo Match on free keys
      }
    } catch {
      /* timeout */
    }
  }

  // Strategy 2: Apollo via name + company
  if (!email && fullName && company && process.env.APOLLO_API_KEY) {
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
      /* timeout */
    }
  }

  // Strategy 3: Hunter via name + domain (with Domain Search fallback)
  if (!email && fullName && company && process.env.HUNTER_API_KEY) {
    try {
      const nameParts = fullName.split(" ");
      let domain = "";
      // Clean messy company names (Pro Level)
      // Remove common marketing noise like "Helping...", "🚀", "Scaling..."
      let cleanCompany = company
        .split(/[|,-]/)[0] // Take first part if regex failed to isolate
        .replace(/helping.*/i, "")
        .replace(/scaling.*/i, "")
        .replace(/building.*/i, "")
        .replace(/[^\w\s]/g, "") // Remove emojis/special chars
        .trim();

      if (!cleanCompany && company) cleanCompany = company.split(" ")[0]; // Use first word as last resort

      if (cleanCompany) {
        // Hunter Domain Search
        const dsRes = await fetchWithTimeout(
          `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(cleanCompany)}&api_key=${process.env.HUNTER_API_KEY}`
        );
        if (dsRes.ok) {
          const dsData = await dsRes.json();
          domain = dsData.data?.domain || "";
        }
      }

      if (domain) {
        const res = await fetchWithTimeout(
          `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(nameParts[0] || "")}&last_name=${encodeURIComponent(nameParts.slice(1).join(" ") || "")}&api_key=${process.env.HUNTER_API_KEY}`
        );
        if (res.ok) {
          const data = await res.json();
          email = data.data?.email || null;
        }
      }
    } catch {
      /* timeout */
    }
  }

  return {
    full_name: fullName || "Unknown",
    linkedin_url: linkedinUrl,
    headline,
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

// ─── Main Pipeline ────────────────────────────────────────────────────

export async function runPipeline(
  postUrl: string,
  userId: string,
  onEvent: (event: PipelineEvent) => void
): Promise<void> {
  const supabase = getSupabaseAdmin();
  apolloDisabled = false; // Reset for each new run

  // ── Env check (require at least ONE AI key) ────────────────────────
  const missingVars: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missingVars.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingVars.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.APIFY_API_TOKEN) missingVars.push("APIFY_API_TOKEN");
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    missingVars.push("OPENAI_API_KEY or GEMINI_API_KEY (at least one required)");
  }

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

  let rawItems: Record<string, any>[] = [];
  try {
    const actorId = "apimaestro~linkedin-post-reactions";
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}&waitForFinish=90`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_urls: [postUrl], limit: 100 }),
      }
    );

    if (!runRes.ok) {
      const errorData = await runRes.json();
      throw new Error(errorData.error?.message || `Apify API returned ${runRes.status}`);
    }

    const runData = await runRes.json();
    const datasetId = runData.data.defaultDatasetId;

    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`
    );

    if (!itemsRes.ok) throw new Error("Failed to fetch results from Apify dataset");

    rawItems = await itemsRes.json();
  } catch (error: any) {
    onEvent({
      type: "error",
      message: `❌ Apify scraping failed: ${error?.message}. Check APIFY_API_TOKEN and URL.`,
    });
    return;
  }

  // Normalize the raw data into a clean, flat structure
  const profiles = normalizeProfiles(rawItems, onEvent);

  onEvent({
    type: "step",
    message: `✅ Apify found ${profiles.length} reactor${profiles.length !== 1 ? "s" : ""} (sample: "${profiles[0]?.fullName || "?"}" — "${profiles[0]?.headline?.slice(0, 50) || "?"}...")`,
  });

  if (profiles.length === 0) {
    onEvent({ type: "done", message: "⚠️ No reactors found. Try a different post URL.", data: { leadsProcessed: 0 } });
    return;
  }

  // ── Step 2: AI Parsing (OpenAI → Gemini → Regex) ───────────────────
  onEvent({ type: "step", message: "🤖 Step 2/4 — Parsing job titles (OpenAI → Gemini → Regex)..." });

  const parsedTitles: Map<number, ParsedTitle> = new Map();
  const headlines = profiles
    .map((p, i) => `${i + 1}. "${p.headline || "N/A"}"`)
    .join("\n");
  const prompt = buildPrompt(headlines);

  let aiUsed = "none";

  // Tier 1: OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const text = await parseWithOpenAI(prompt);
      const parsed = extractParsedArray(text);
      parsed.forEach((item) => parsedTitles.set(item.index - 1, { jobTitle: item.jobTitle, company: item.company }));
      aiUsed = "OpenAI";
      onEvent({ type: "step", message: `✅ OpenAI parsed ${parsedTitles.size} job titles` });
    } catch (err: any) {
      const isQuota = err?.message?.includes("429") || err?.message?.includes("quota");
      onEvent({ 
        type: "step", 
        message: `⚠️ OpenAI failed (${isQuota ? "429: Likely Billing/Quota issue" : err?.message}). Trying Gemini...` 
      });
    }
  }

  // Tier 2: Gemini
  if (parsedTitles.size === 0 && process.env.GEMINI_API_KEY) {
    try {
      const text = await parseWithGemini(prompt);
      const parsed = extractParsedArray(text);
      parsed.forEach((item) => parsedTitles.set(item.index - 1, { jobTitle: item.jobTitle, company: item.company }));
      aiUsed = "Gemini";
      onEvent({ type: "step", message: `✅ Gemini parsed ${parsedTitles.size} job titles` });
    } catch (err: any) {
      const isQuota = err?.message?.includes("429") || err?.message?.includes("quota");
      onEvent({ 
        type: "step", 
        message: `⚠️ Gemini failed (${isQuota ? "429: Quota exceeded" : err?.message}). Using regex fallback...` 
      });
    }
  }

  // Tier 3: Regex fallback
  if (parsedTitles.size === 0) {
    profiles.forEach((p, i) => {
      if (p.headline) parsedTitles.set(i, fallbackRegexParse(p.headline));
    });
    aiUsed = "Regex";
    onEvent({ type: "step", message: `✅ Regex extracted ${parsedTitles.size} titles from headlines` });
  }

  // ── Step 3: Email Enrichment ──────────────────────────────────────
  onEvent({ type: "step", message: `📧 Step 3/4 — Enriching ${profiles.length} leads with emails (Apollo via LinkedIn URL + Hunter)...` });

  const enrichmentTasks = profiles.map(
    (profile, i) => () => enrichSingleProfile(profile, parsedTitles.get(i))
  );
  const enrichedLeads = await parallelLimit(enrichmentTasks, 5);

  const emailCount = enrichedLeads.filter((l) => l.email).length;
  const urlCount = enrichedLeads.filter((l) => l.linkedin_url).length;
  const companyCount = enrichedLeads.filter((l) => l.company).length;
  onEvent({
    type: "step",
    message: `✅ Enriched ${enrichedLeads.length} leads — ${emailCount} email${emailCount !== 1 ? "s" : ""}, ${urlCount} LinkedIn URLs, ${companyCount} companies (AI: ${aiUsed})`,
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
      message: `❌ Database save failed: ${insertError.message}. Check your Supabase table schema.`,
      data: { errorDetail: insertError.message, code: insertError.code },
    });
    return;
  }

  onEvent({
    type: "done",
    message: `🎉 Done! ${enrichedLeads.length} leads saved (${emailCount} emails, ${urlCount} URLs, ${companyCount} companies). AI used: ${aiUsed}`,
    data: { leadsProcessed: enrichedLeads.length, emailsFound: emailCount },
  });
}
