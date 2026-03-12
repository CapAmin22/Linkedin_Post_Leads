import { createClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────
interface NormalizedProfile {
  fullName: string;
  headline: string;
  linkedinUrl: string;
  email?: string; // may come pre-filled from scraper
}

interface ParsedTitle {
  jobTitle: string;
  company: string;
  companyUrl?: string;
  companyDomain?: string;
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
  maxRetries = 1,
  delay = 1000,
  shouldRetry429 = false
): Promise<Response> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, 8000);
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

// ─── Scraper Service ──────────────────────────────────────────────────
// Calls the Python Selenium+Scrapy microservice.

function scraperBase(): string {
  return (process.env.SCRAPER_SERVICE_URL || "").replace(/\/$/, "");
}

async function callScraper(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs: number
): Promise<any> {
  const url = `${scraperBase()}${endpoint}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Scraper ${endpoint} → ${res.status}`);
  }
  return res.json();
}

// ─── Profile Normalizer ───────────────────────────────────────────────

function normalizeProfiles(
  rawItems: Record<string, any>[],
  onEvent: (event: PipelineEvent) => void
): NormalizedProfile[] {
  if (rawItems.length > 0) {
    onEvent({
      type: "step",
      message: `📋 Data shape: [${Object.keys(rawItems[0]).join(", ")}]`,
    });
  }

  return rawItems
    .map((item) => ({
      fullName: (
        item.fullName || item.name ||
        `${item.firstName || ""} ${item.lastName || ""}`.trim()
      ).trim(),
      headline: item.headline || item.position || "",
      linkedinUrl: (
        item.profileUrl || item.profile_url || item.linkedinUrl || item.url ||
        (item.publicIdentifier ? `https://linkedin.com/in/${item.publicIdentifier}` : "")
      ).split("?")[0],
      email: item.email || undefined,
    }))
    .filter((p) => p.fullName || p.headline);
}

// ─── Regex Fallback Parser ────────────────────────────────────────────

function fallbackRegexParse(headline: string): ParsedTitle {
  const atMatch = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) return { jobTitle: atMatch[1].trim(), company: atMatch[2].trim() };
  const pipeMatch = headline.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) return { jobTitle: pipeMatch[1].trim(), company: pipeMatch[2].trim() };
  const dashMatch = headline.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) return { jobTitle: dashMatch[1].trim(), company: dashMatch[2].trim() };
  const commaMatch = headline.match(/^(.+?),\s+(.+)$/);
  if (commaMatch) return { jobTitle: commaMatch[1].trim(), company: commaMatch[2].trim() };
  return { jobTitle: headline, company: "" };
}

// ─── AI Parsing: Groq → Gemini → OpenAI → Regex ──────────────────

function buildPrompt(headlines: string): string {
  return `Extract "Job Title" and "Company Name" from LinkedIn headlines.
Return JSON: {"results": [{"index": N, "jobTitle": "...", "company": "..."}]}

Rules:
- Extract ONLY the role name (e.g. "Founder", "Software Engineer").
- Use "@", "at", "|", "-" as separators to find company.
- If no clear company, set company to "".
- index must match input numbering exactly.

Headlines:
${headlines}`;
}

function extractParsedArray(text: string): { index: number; jobTitle: string; company: string }[] {
  const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const raw = JSON.parse(jsonStr);
  if (Array.isArray(raw)) return raw;
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

async function parseWithGroq(prompt: string): Promise<string> {
  const res = await retryFetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    },
    0
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Groq ${res.status}: ${e.error?.message || "error"}`);
  }
  return (await res.json()).choices[0].message.content;
}

async function parseWithGemini(prompt: string): Promise<string> {
  const res = await retryFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    },
    0
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Gemini ${res.status}: ${e.error?.message || "error"}`);
  }
  return (await res.json()).candidates[0].content.parts[0].text;
}

async function parseWithOpenAI(prompt: string): Promise<string> {
  const res = await retryFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

// ─── AI Parsing Waterfall ─────────────────────────────────────────────

async function runAIParsing(
  profiles: NormalizedProfile[],
  parsedTitles: Map<number, ParsedTitle>,
  onEvent: (event: PipelineEvent) => void
): Promise<string> {
  const headlines = profiles.map((p, i) => `${i}. "${p.headline || "N/A"}"`).join("\n");
  const prompt = buildPrompt(headlines);
  let aiUsed = "none";

  const applyResults = (results: { index: number; jobTitle: string; company: string }[]) => {
    results.forEach((item) => {
      if (item.index !== undefined && !parsedTitles.has(item.index)) {
        parsedTitles.set(item.index, { jobTitle: item.jobTitle, company: item.company });
      }
    });
  };

  if (process.env.GROQ_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithGroq(prompt)));
      aiUsed = "Groq";
      onEvent({ type: "step", message: `✅ Groq parsed ${parsedTitles.size} titles` });
    } catch (err: any) {
      onEvent({ type: "step", message: `⚠️ Groq: ${err?.message} — trying Gemini...` });
    }
  }

  if (parsedTitles.size < profiles.length && process.env.GEMINI_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithGemini(prompt)));
      aiUsed = "Gemini";
      onEvent({ type: "step", message: `✅ Gemini parsed ${parsedTitles.size} titles` });
    } catch (err: any) {
      const q = err?.message?.includes("429") || err?.message?.includes("quota");
      onEvent({ type: "step", message: `⚠️ Gemini: ${q ? "quota exceeded" : err?.message} — trying OpenAI...` });
    }
  }

  if (parsedTitles.size < profiles.length && process.env.OPENAI_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithOpenAI(prompt)));
      aiUsed = "OpenAI";
      onEvent({ type: "step", message: `✅ OpenAI parsed ${parsedTitles.size} titles` });
    } catch (err: any) {
      onEvent({ type: "step", message: `⚠️ OpenAI: ${err?.message} — using regex fallback...` });
    }
  }

  // Always fill any remaining gaps with regex — even if AI parsed some items
  let regexCount = 0;
  profiles.forEach((p, i) => {
    if (!parsedTitles.has(i) && p.headline) {
      parsedTitles.set(i, fallbackRegexParse(p.headline));
      regexCount++;
    }
  });
  if (regexCount > 0) {
    if (aiUsed === "none") aiUsed = "Regex";
    onEvent({ type: "step", message: `✅ Regex filled ${regexCount} remaining title(s)` });
  }

  return aiUsed;
}

// ─── Email enrichment (API fallbacks, used when scraper email is empty) ───────
// Apollo and Hunter are optional — they are used only when the Python scraper
// couldn't find an email without them.
// apolloDisabled is request-scoped (passed as { value } ref) to avoid shared state.

async function tryApolloEmail(
  linkedinUrl: string,
  fullName: string,
  company: string,
  disabled: { value: boolean }
): Promise<string | null> {
  if (!process.env.APOLLO_API_KEY || disabled.value) return null;

  // Strategy A: by LinkedIn URL
  try {
    const res = await fetchWithTimeout("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": process.env.APOLLO_API_KEY!,
      },
      body: JSON.stringify({ linkedin_url: linkedinUrl }),
    });
    if (res.ok) return (await res.json()).person?.email || null;
    if (res.status === 403) disabled.value = true; // Free-plan key — stop retrying
  } catch { /* timeout */ }

  // Strategy B: by name + company
  if (fullName && company && !disabled.value) {
    try {
      const [first, ...rest] = fullName.split(" ");
      const res = await fetchWithTimeout("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": process.env.APOLLO_API_KEY!,
        },
        body: JSON.stringify({ first_name: first, last_name: rest.join(" "), organization_name: company }),
      });
      if (res.ok) return (await res.json()).person?.email || null;
    } catch { /* timeout */ }
  }

  return null;
}

async function tryHunterEmail(
  fullName: string,
  company: string
): Promise<string | null> {
  if (!process.env.HUNTER_API_KEY || !fullName || !company) return null;

  try {
    const cleanCo = company.split(/[|,-]/)[0]
      .replace(/helping.*/i, "").replace(/scaling.*/i, "").replace(/[^\w\s]/g, "").trim()
      || company.split(" ")[0];

    const dsRes = await fetchWithTimeout(
      `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(cleanCo)}&api_key=${process.env.HUNTER_API_KEY}`
    );
    if (!dsRes.ok) return null;
    const domain = (await dsRes.json()).data?.domain || "";
    if (!domain) return null;

    const [first, ...rest] = fullName.split(" ");
    const res = await fetchWithTimeout(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(rest.join(" "))}&api_key=${process.env.HUNTER_API_KEY}`
    );
    if (res.ok) return (await res.json()).data?.email || null;
  } catch { /* timeout */ }

  return null;
}

async function parallelLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  // Use an index queue instead of shared counter — clearly safe in JS's single-threaded model
  const queue: number[] = tasks.map((_, i) => i);
  async function worker() {
    let idx: number | undefined;
    while ((idx = queue.shift()) !== undefined) {
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ─── Main Pipeline ────────────────────────────────────────────────────

export async function runPipeline(
  postUrl: string,
  userId: string,
  onEvent: (event: PipelineEvent) => void
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const apolloDisabled = { value: false }; // request-scoped — safe under concurrency

  // ── Env check ─────────────────────────────────────────────────────
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.SCRAPER_SERVICE_URL) missing.push("SCRAPER_SERVICE_URL");
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    missing.push("at least one AI key: GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY");
  }
  if (missing.length > 0) {
    onEvent({ type: "error", message: `Missing env vars: ${missing.join(", ")}` });
    return;
  }

  // ── Step 1+2+3 combined: Full scrape via Python service ────────────
  onEvent({ type: "step", message: "🔍 Step 1/3 — Launching Selenium + Scrapy scraper..." });

  let reactors: Record<string, any>[] = [];
  let profileMap = new Map<string, Record<string, any>>();

  try {
    const result = await callScraper(
      "/scrape/full",
      { post_url: postUrl, limit: 20, scrape_profiles: true, scrape_emails: true },
      240000 // 4 minutes — covers reactions + profiles + email discovery
    );

    reactors = result.reactors ?? [];
    const profiles: Record<string, any>[] = result.profiles ?? [];

    profiles.forEach((p) => {
      const key = (p.linkedinUrl || "").split("?")[0].replace(/\/$/, "");
      profileMap.set(key, p);
    });

    onEvent({
      type: "step",
      message: `✅ Scraped ${reactors.length} reactor(s) · ${profiles.length} profile(s) enriched`,
    });
  } catch (err: any) {
    onEvent({
      type: "error",
      message: `❌ Scraper failed: ${err?.message}. Check SCRAPER_SERVICE_URL, LINKEDIN_EMAIL, LINKEDIN_PASSWORD.`,
    });
    return;
  }

  if (reactors.length === 0) {
    onEvent({ type: "done", message: "⚠️ No reactors found. Try a different post URL.", data: { leadsProcessed: 0 } });
    return;
  }

  // Normalise reactor list → NormalizedProfile[]
  const normalized = normalizeProfiles(reactors, onEvent);

  // ── Step 2: AI title/company parsing (gaps only) ───────────────────
  onEvent({ type: "step", message: "🤖 Step 2/3 — AI parsing job titles & companies from headlines..." });

  const parsedTitles = new Map<number, ParsedTitle>();

  // Pre-fill from profile deep-dive data
  normalized.forEach((p, i) => {
    const cleanUrl = p.linkedinUrl.split("?")[0].replace(/\/$/, "").toLowerCase();
    let matched: Record<string, any> | undefined;
    profileMap.forEach((v, k) => {
      if (k.toLowerCase() === cleanUrl || cleanUrl.includes(k.toLowerCase())) matched = v;
    });
    if (matched && (matched.jobTitle || matched.company)) {
      parsedTitles.set(i, {
        jobTitle: matched.jobTitle || "",
        company: matched.company || "",
        companyUrl: matched.companyUrl || "",
      });
    }
  });

  const gaps = normalized.filter((_, i) => !parsedTitles.has(i));
  if (gaps.length > 0) {
    onEvent({ type: "step", message: `⚙️ Running AI for ${gaps.length} unparsed headline(s)...` });
    const aiUsed = await runAIParsing(normalized, parsedTitles, onEvent);
    onEvent({ type: "step", message: `📊 Titles parsed via: ${aiUsed}` });
  } else {
    onEvent({ type: "step", message: "✅ All titles resolved from profile deep-dive" });
  }

  // ── Step 3: Email — scraper results first, then API fallbacks ─────
  onEvent({ type: "step", message: `📧 Step 3/3 — Finalising emails for ${normalized.length} leads...` });

  const enrichedLeads = await parallelLimit(
    normalized.map((profile, i) => async (): Promise<EnrichedLead> => {
      const parsed = parsedTitles.get(i);
      const cleanUrl = profile.linkedinUrl.split("?")[0].replace(/\/$/, "").toLowerCase();

      // Email already discovered by Python scraper?
      let email: string | null = profile.email || null;

      // Look up from profileMap if not on reactor
      if (!email) {
        profileMap.forEach((v, k) => {
          if (!email && k.toLowerCase() === cleanUrl) email = v.email || null;
        });
      }

      // Fallback: Apollo / Hunter (optional, free-tier limited)
      if (!email) {
        email = await tryApolloEmail(profile.linkedinUrl, profile.fullName, parsed?.company || "", apolloDisabled);
      }
      if (!email && parsed?.company) {
        email = await tryHunterEmail(profile.fullName, parsed.company);
      }

      return {
        full_name: profile.fullName || "Unknown",
        linkedin_url: profile.linkedinUrl,
        headline: profile.headline,
        job_title: parsed?.jobTitle || profile.headline || "",
        company: parsed?.company || "",
        email,
        status: "completed",
      };
    }),
    8
  );

  const emailCount   = enrichedLeads.filter((l) => l.email).length;
  const urlCount     = enrichedLeads.filter((l) => l.linkedin_url).length;
  const companyCount = enrichedLeads.filter((l) => l.company).length;

  onEvent({
    type: "step",
    message: `✅ ${enrichedLeads.length} leads ready — ${emailCount} emails · ${urlCount} URLs · ${companyCount} companies`,
  });

  // ── Step 4: Save to Supabase ──────────────────────────────────────
  onEvent({ type: "step", message: "💾 Saving to database..." });

  const { error } = await supabase.from("scraped_leads").insert(
    enrichedLeads.map((lead) => ({ user_id: userId, source_url: postUrl, ...lead }))
  );

  if (error) {
    onEvent({
      type: "error",
      message: `❌ DB save failed: ${error.message}`,
      data: { errorDetail: error.message, code: error.code },
    });
    return;
  }

  onEvent({
    type: "done",
    message: `🎉 Done! ${enrichedLeads.length} leads saved · ${emailCount} emails · ${companyCount} companies`,
    data: { leadsProcessed: enrichedLeads.length, emailsFound: emailCount },
  });
}
