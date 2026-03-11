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
  companyUrl?: string; // Deep Dive extracted
  companyDomain?: string; // Domain Hunt extracted
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
  maxRetries = 1, // Reduced for speed
  delay = 1000,
  shouldRetry429 = false // Don't retry 429 by default for speed
): Promise<Response> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, 8000); // 8s timeout
      if (res.status === 429 && shouldRetry429 && i < maxRetries) {
        await new Promise((r) => setTimeout(r, delay * Math.pow(2, i)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (i === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ─── Apify Generic Runner ──────────────────────────────────────────────
async function runApifyActor(
  actorId: string,
  payload: Record<string, any>,
  timeoutSecs = 30
): Promise<any[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return [];

  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}&waitForFinish=${timeoutSecs}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!runRes.ok) return [];

    const runData = await runRes.json();
    if (runData.data?.status !== "SUCCEEDED" || runData.error) return [];

    const datasetId = runData.data.defaultDatasetId;
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`);
    if (!itemsRes.ok) return [];

    return await itemsRes.json();
  } catch (error) {
    console.error(`Apify actor ${actorId} failed:`, error);
    return [];
  }
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

// ─── AI Parsing: Groq → Gemini → OpenAI → Regex ──────────────────

function buildPrompt(headlines: string): string {
  return `Goal: Extract the true "Job Title" and true "Company Name" from LinkedIn headlines.
Input: A numbered list of raw LinkedIn headlines.
Task: Analyze the headline to strictly isolate their primary Job Title and their Employer (Company).
Output: Return a JSON object with a "results" key containing an array. Each element MUST have: {"index": <number>, "jobTitle": "<string>", "company": "<string>"}.

CRITICAL RULES:
1. The "index" MUST exactly match the number in the input list.
2. DO NOT just copy the entire headline into the jobTitle. Extract ONLY the specific role (e.g., "Founder", "Software Engineer", "CEO").
3. DO NOT confuse general statements for a company. If the headline is "Helping startups grow" or "Researcher", the company is MISSING. Set company to "".
4. Look for indicators like "@", "at", " | ", or " - " to find the true company.
5. If you cannot confidently detect a real company name, leave "company" blank. This prevents downstream API errors.

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

async function parseWithGroq(prompt: string): Promise<string> {
  const model = "llama-3.3-70b-versatile";
  const res = await retryFetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    },
    0 // 0 retries, fail fast
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Groq returned ${res.status}: ${errData.error?.message || "Quota/Error"}`);
  }
  
  const data = await res.json();
  return data.choices[0].message.content;
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
  // Use v1beta and gemini-2.0-flash as primary for speed/availability
  const model = "gemini-2.0-flash";
  const version = "v1beta"; 
  
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
      },
      0 // 0 retries, fail fast
    );

    if (res.ok) {
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    }
    
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Gemini returned ${res.status}: ${errData.error?.message || "Quota/Error"}`);
  } catch (err: any) {
    throw err;
  }
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
      let domain = parsed?.companyDomain || "";
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

      if (cleanCompany && !domain) {
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

  // ── Step 2: Waterfall Deep Dive (Apify Profiles → AI Parsing) ───────────────────
  onEvent({ type: "step", message: "🤖 Step 2/4 — Deep Dive: Extracting True Experience & Companies..." });

  const parsedTitles: Map<number, ParsedTitle> = new Map();
  let deepDiveUsed = false;
  
  const validUrls = profiles.map(p => p.linkedinUrl).filter(url => url && url.startsWith("http"));
  if (validUrls.length > 0 && process.env.APIFY_API_TOKEN) {
      onEvent({ type: "step", message: "⚙️ Attempting HarvestAPI Profile Scraper..." });
      // We pass both 'urls' and 'profileUrls' as different actors use different input keys
      let deepItems = await runApifyActor("harvestapi~linkedin-profile-scraper", { urls: validUrls, profileUrls: validUrls }, 30);
      
      if (deepItems.length === 0) {
          onEvent({ type: "step", message: "⚙️ HarvestAPI empty/failed. Attempting dev_fusion Profile Scraper..." });
          deepItems = await runApifyActor("dev_fusion~linkedin-profile-scraper", { profileUrls: validUrls }, 30);
      }
      
      if (deepItems.length > 0) {
          deepDiveUsed = true;
          profiles.forEach((p, i) => {
              const matched = deepItems.find(d => 
                  d.linkedinUrl === p.linkedinUrl || 
                  d.url === p.linkedinUrl || 
                  d.profileUrl === p.linkedinUrl || 
                  (d.publicIdentifier && p.linkedinUrl.includes(d.publicIdentifier))
              );
              if (matched) {
                  const company = matched.company || matched.companyName || matched.experiences?.[0]?.company || matched.experience?.[0]?.companyName || "";
                  const jobTitle = matched.jobTitle || matched.headline || matched.experiences?.[0]?.title || matched.experience?.[0]?.title || "";
                  const companyUrl = matched.companyUrl || matched.experiences?.[0]?.companyUrl || matched.experience?.[0]?.companyUrl || "";
                  if (company || jobTitle) {
                      parsedTitles.set(i, { jobTitle, company, companyUrl });
                  }
              }
          });
      }
  }

  // Fallback to AI Parser if Apify failed or incomplete
  let aiUsed = deepDiveUsed ? "Apify Deep Dive" : "none";
  
  if (!deepDiveUsed || parsedTitles.size < profiles.length) {
      if (deepDiveUsed) {
          onEvent({ type: "step", message: "⚠️ Apify Deep Dive incomplete. Firing AI Inference Fallback..." });
      } else {
          onEvent({ type: "step", message: "⚠️ Apify actors not rented or failed. Firing fast AI Inference Fallback..." });
      }

      const headlines = profiles
        .map((p, i) => `${i}. "${p.headline || "N/A"}"`)
        .join("\n");
      const prompt = buildPrompt(headlines);

      // Tier 1: Groq
  if (process.env.GROQ_API_KEY) {
    try {
      const text = await parseWithGroq(prompt);
      const parsed = extractParsedArray(text);
      parsed.forEach((item) => {
        if (item.index !== undefined) {
          parsedTitles.set(item.index, { jobTitle: item.jobTitle, company: item.company });
        }
      });
      aiUsed = "Groq";
      onEvent({ type: "step", message: `✅ Groq parsed ${parsedTitles.size} job titles` });
    } catch (err: any) {
      onEvent({ 
        type: "step", 
        message: `⚠️ Groq failed (${err?.message}). Trying Gemini...` 
      });
    }
  }

  // Tier 2: Gemini
  if (parsedTitles.size === 0 && process.env.GEMINI_API_KEY) {
    try {
      const text = await parseWithGemini(prompt);
      const parsed = extractParsedArray(text);
      parsed.forEach((item) => {
        if (item.index !== undefined) parsedTitles.set(item.index, { jobTitle: item.jobTitle, company: item.company });
      });
      aiUsed = "Gemini";
      onEvent({ type: "step", message: `✅ Gemini parsed ${parsedTitles.size} job titles` });
    } catch (err: any) {
      const isQuota = err?.message?.includes("429") || err?.message?.includes("quota") || err?.message?.includes("403");
      onEvent({ 
        type: "step", 
        message: `⚠️ Gemini failed (${isQuota ? "Quota exceeded" : err?.message}). Trying OpenAI...` 
      });
    }
  }

  // Tier 3: OpenAI
  if (parsedTitles.size === 0 && process.env.OPENAI_API_KEY) {
    try {
      const text = await parseWithOpenAI(prompt);
      const parsed = extractParsedArray(text);
      parsed.forEach((item) => {
        if (item.index !== undefined) parsedTitles.set(item.index, { jobTitle: item.jobTitle, company: item.company });
      });
      aiUsed = "OpenAI";
      onEvent({ type: "step", message: `✅ OpenAI parsed ${parsedTitles.size} job titles` });
    } catch (err: any) {
      const isQuota = err?.message?.includes("429") || err?.message?.includes("quota");
      onEvent({ 
        type: "step", 
        message: `⚠️ OpenAI failed (${isQuota ? "429: Likely Billing/Quota issue" : err?.message}). Using regex fallback...` 
      });
    }
  }

  // Tier 4: Regex fallback
  if (parsedTitles.size === 0) {
    profiles.forEach((p, i) => {
      if (p.headline) parsedTitles.set(i, fallbackRegexParse(p.headline));
    });
    aiUsed = "Regex";
    onEvent({ type: "step", message: `✅ Regex extracted ${parsedTitles.size} titles from headlines` });
  }
  
  } // END of if (!deepDiveUsed || parsedTitles.size < profiles.length)

  // ── Step 2.5: Waterfall Domain Hunt (Apify Companies) ───────────────────
  // If the Deep Dive found company LinkedIn URLs, pass them to curious_coder to get the actual websites
  const companyUrlsToHunt = Array.from(parsedTitles.values())
    .map(pt => pt.companyUrl)
    .filter(url => url && url.startsWith("http"));

  if (companyUrlsToHunt.length > 0 && process.env.APIFY_API_TOKEN) {
      onEvent({ type: "step", message: `🏢 Step 2.5/4 — Domain Hunt: Resolving ${companyUrlsToHunt.length} Company URLs via Apify...` });
      const companyItems = await runApifyActor("curious_coder~linkedin-company-scraper", { urls: companyUrlsToHunt }, 30);
      
      if (companyItems.length > 0) {
          // Map the domains back to the parsedTitles
          companyItems.forEach(item => {
              if (item.url && item.website) {
                  // Find all matching parsedTitles and inject the domain
                  parsedTitles.forEach(pt => {
                      if (pt.companyUrl === item.url || (item.publicIdentifier && pt.companyUrl?.includes(item.publicIdentifier))) {
                          pt.companyDomain = item.website;
                      }
                  });
              }
          });
      }
  }

  // ── Step 3: Email Enrichment ──────────────────────────────────────
  onEvent({ type: "step", message: `📧 Step 3/4 — Enriching ${profiles.length} leads with emails (Apollo via LinkedIn URL + Hunter)...` });

  const enrichmentTasks = profiles.map(
    (profile, i) => () => enrichSingleProfile(profile, parsedTitles.get(i))
  );
  const enrichedLeads = await parallelLimit(enrichmentTasks, 10); // Increased concurrency

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
