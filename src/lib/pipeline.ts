import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────

export interface NormalizedProfile {
  fullName: string;
  headline: string;
  linkedinUrl: string;
  email?: string;
}

export interface ParsedTitle {
  jobTitle: string;
  company: string;
  companyUrl?: string;
  companyDomain?: string;
}

export interface EnrichedLead {
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

// ─── Supabase Admin ───────────────────────────────────────────────────

function getSupabaseAdmin() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────

export async function fetchWithTimeout(
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

export async function retryFetch(
  url: string,
  options: RequestInit,
  maxRetries = 1,
  delay = 1000,
  shouldRetry429 = false
): Promise<Response> {
  let lastError: unknown;
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

function scraperBase(): string {
  return (process.env.NEXT_PUBLIC_SCRAPER_SERVICE_URL || "").replace(/\/$/, "");
}

async function callScraper<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
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
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail || `Scraper ${endpoint} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Profile Normalizer ───────────────────────────────────────────────

export function normalizeProfiles(
  rawItems: Record<string, unknown>[],
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
        (item.fullName as string) ||
        (item.name as string) ||
        `${(item.firstName as string) || ""} ${(item.lastName as string) || ""}`.trim()
      ).trim(),
      headline: (item.headline as string) || (item.position as string) || "",
      linkedinUrl: (
        (item.profileUrl as string) ||
        (item.profile_url as string) ||
        (item.linkedinUrl as string) ||
        (item.url as string) ||
        (item.publicIdentifier
          ? `https://linkedin.com/in/${item.publicIdentifier}`
          : "")
      )
        .split("?")[0]
        .replace(/\/$/, ""),
      email: (item.email as string) || undefined,
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

// ─── AI Parsing: Groq → Gemini → OpenAI → Regex ──────────────────────

function buildPrompt(headlines: string): string {
  return `Extract the professional "Job Title" and "Company Name" from LinkedIn profile headlines.
Return ONLY valid JSON: {"results": [{"index": N, "jobTitle": "...", "company": "..."}]}

Rules:
1. jobTitle must be a SHORT role/title only (e.g. "Founder & CEO", "Software Engineer", "VP of Sales").
2. Many headlines start with a personal pitch before the actual title — SKIP the pitch, extract the title.
3. Use separators "@", "at", "|", "-", "," to identify company name.
4. Emojis are NOT part of the title — strip them.
5. If no company is identifiable, set company to "".
6. index must match input numbering exactly.

Examples:
- "I help founders grow revenue | CEO @ Acme Corp" → jobTitle: "CEO", company: "Acme Corp"
- "Helping startups scale with AI - CTO at TechCo" → jobTitle: "CTO", company: "TechCo"
- "Software Engineer | Google" → jobTitle: "Software Engineer", company: "Google"
- "🚀 Founder building the future of SaaS | OpenAI" → jobTitle: "Founder", company: "OpenAI"
- "Marketing consultant & speaker" → jobTitle: "Marketing Consultant", company: ""

Headlines:
${headlines}`;
}

function extractParsedArray(
  text: string
): { index: number; jobTitle: string; company: string }[] {
  const jsonStr = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const raw = JSON.parse(jsonStr) as unknown;
  if (Array.isArray(raw)) return raw as { index: number; jobTitle: string; company: string }[];
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(raw as object)) {
      const val = (raw as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val as { index: number; jobTitle: string; company: string }[];
    }
  }
  return [];
}

async function parseWithGroq(prompt: string): Promise<string> {
  const res = await retryFetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
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
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Groq ${res.status}: ${e.error?.message || "error"}`);
  }
  return (
    (await res.json()) as {
      choices: { message: { content: string } }[];
    }
  ).choices[0].message.content;
}

async function parseWithGemini(prompt: string): Promise<string> {
  const res = await retryFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    },
    0
  );
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Gemini ${res.status}: ${e.error?.message || "error"}`);
  }
  return (
    (await res.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    }
  ).candidates[0].content.parts[0].text;
}

async function parseWithOpenAI(prompt: string): Promise<string> {
  const res = await retryFetch(
    "https://api.openai.com/v1/chat/completions",
    {
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
    }
  );
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  return (
    (await res.json()) as {
      choices: { message: { content: string } }[];
    }
  ).choices[0].message.content;
}

export async function runAIParsing(
  profiles: NormalizedProfile[],
  parsedTitles: Map<number, ParsedTitle>,
  onEvent: (event: PipelineEvent) => void
): Promise<string> {
  const headlines = profiles
    .map((p, i) => `${i}. "${p.headline || "N/A"}"`)
    .join("\n");
  const prompt = buildPrompt(headlines);
  let aiUsed = "none";

  const applyResults = (
    results: { index: number; jobTitle: string; company: string }[]
  ) => {
    results.forEach((item) => {
      if (item.index !== undefined && !parsedTitles.has(item.index)) {
        parsedTitles.set(item.index, {
          jobTitle: item.jobTitle,
          company: item.company,
        });
      }
    });
  };

  if (process.env.GROQ_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithGroq(prompt)));
      aiUsed = "Groq";
      onEvent({
        type: "step",
        message: `✅ Groq parsed ${parsedTitles.size} titles`,
      });
    } catch (err: unknown) {
      onEvent({
        type: "step",
        message: `⚠️ Groq: ${(err as Error)?.message || "error"} — trying Gemini...`,
      });
    }
  }

  if (parsedTitles.size < profiles.length && process.env.GEMINI_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithGemini(prompt)));
      aiUsed = "Gemini";
      onEvent({
        type: "step",
        message: `✅ Gemini parsed ${parsedTitles.size} titles`,
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message || "";
      const q = msg.includes("429") || msg.includes("quota");
      onEvent({
        type: "step",
        message: `⚠️ Gemini: ${q ? "quota exceeded" : msg} — trying OpenAI...`,
      });
    }
  }

  if (parsedTitles.size < profiles.length && process.env.OPENAI_API_KEY) {
    try {
      applyResults(extractParsedArray(await parseWithOpenAI(prompt)));
      aiUsed = "OpenAI";
      onEvent({
        type: "step",
        message: `✅ OpenAI parsed ${parsedTitles.size} titles`,
      });
    } catch (err: unknown) {
      onEvent({
        type: "step",
        message: `⚠️ OpenAI: ${(err as Error)?.message || "error"} — using regex fallback...`,
      });
    }
  }

  // Fill any remaining gaps with regex
  let regexCount = 0;
  profiles.forEach((p, i) => {
    if (!parsedTitles.has(i) && p.headline) {
      parsedTitles.set(i, fallbackRegexParse(p.headline));
      regexCount++;
    }
  });
  if (regexCount > 0 && aiUsed === "none") aiUsed = "Regex";

  return aiUsed;
}

// ─── Main Pipeline ─────────────────────────────────────────────────────

export async function runPipeline(
  postUrl: string,
  userId: string,
  onEvent: (event: PipelineEvent) => void
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // ── Env check ──────────────────────────────────────────────────────
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.NEXT_PUBLIC_SCRAPER_SERVICE_URL)
    missing.push("NEXT_PUBLIC_SCRAPER_SERVICE_URL");
  if (
    !process.env.NEXT_PUBLIC_LINKEDIN_EMAIL &&
    !process.env.LINKEDIN_EMAIL
  )
    missing.push("LINKEDIN_EMAIL");
  if (
    !process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD &&
    !process.env.LINKEDIN_PASSWORD
  )
    missing.push("LINKEDIN_PASSWORD");
  if (
    !process.env.OPENAI_API_KEY &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GROQ_API_KEY
  ) {
    missing.push(
      "at least one AI key: GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY"
    );
  }

  if (missing.length > 0) {
    onEvent({
      type: "error",
      message: `Missing env vars: ${missing.join(", ")}`,
    });
    return;
  }

  // ── Step 1: Scrape reactions + profiles via Python service ─────────
  onEvent({
    type: "step",
    message: "🔍 Step 1/3 — Launching Selenium + Scrapy scraper...",
  });

  interface ScraperResult {
    reactors?: Record<string, unknown>[];
    profiles?: Record<string, unknown>[];
  }

  let reactors: Record<string, unknown>[] = [];
  const profileMap = new Map<string, Record<string, unknown>>();

  try {
    const result = (await callScraper(
      "/scrape/full",
      {
        post_url: postUrl,
        limit: 20,
        scrape_profiles: true,
        scrape_emails: true,
      },
      240000 // 4 min — covers reactions + profiles + email discovery
    )) as ScraperResult;

    reactors = result.reactors ?? [];
    const profiles = result.profiles ?? [];

    profiles.forEach((p) => {
      const key = ((p.linkedinUrl as string) || "")
        .split("?")[0]
        .replace(/\/$/, "");
      profileMap.set(key, p);
    });

    onEvent({
      type: "step",
      message: `✅ Scraped ${reactors.length} reactor(s) · ${profiles.length} profile(s) enriched`,
    });
  } catch (err: unknown) {
    onEvent({
      type: "error",
      message: `❌ Scraper failed: ${(err as Error)?.message || "error"}. Is the Python service running at ${scraperBase()}?`,
    });
    return;
  }

  if (reactors.length === 0) {
    onEvent({
      type: "done",
      message: "⚠️ No reactors found. Try a different post URL.",
      data: { leadsProcessed: 0 },
    });
    return;
  }

  // ── Step 2: Normalise & pre-fill from deep-dive data ──────────────
  const normalized = normalizeProfiles(reactors, onEvent);

  onEvent({
    type: "step",
    message: "⚙️ Extracting job titles & companies from profile data...",
  });

  const parsedTitles = new Map<number, ParsedTitle>();

  normalized.forEach((p, i) => {
    const cleanUrl = p.linkedinUrl
      .split("?")[0]
      .replace(/\/$/, "")
      .toLowerCase();
    let matched: Record<string, unknown> | undefined;
    profileMap.forEach((v, k) => {
      if (
        k.toLowerCase() === cleanUrl ||
        cleanUrl.includes(k.toLowerCase())
      )
        matched = v;
    });
    if (matched && (matched.jobTitle || matched.company)) {
      parsedTitles.set(i, {
        jobTitle: (matched.jobTitle as string) || "",
        company: (matched.company as string) || "",
        companyUrl: (matched.companyUrl as string) || "",
      });
    }
  });

  // ── Step 3: LLM waterfall for remaining gaps ───────────────────────
  const gaps = normalized.filter((_, i) => !parsedTitles.has(i));
  if (gaps.length > 0) {
    onEvent({
      type: "step",
      message: `🤖 Step 2/3 — AI parsing ${gaps.length} headline(s)...`,
    });
    const aiUsed = await runAIParsing(normalized, parsedTitles, onEvent);
    onEvent({ type: "step", message: `📊 Titles resolved via: ${aiUsed}` });
  } else {
    onEvent({
      type: "step",
      message: "✅ All titles resolved from profile deep-dive",
    });
  }

  // ── Step 4: Finalise enriched leads ───────────────────────────────
  onEvent({
    type: "step",
    message: `📧 Finalising ${normalized.length} leads...`,
  });

  const enrichedLeads: EnrichedLead[] = normalized.map((profile, i) => {
    const parsed = parsedTitles.get(i);
    const cleanUrl = profile.linkedinUrl
      .split("?")[0]
      .replace(/\/$/, "")
      .toLowerCase();

    let email: string | null = profile.email || null;
    if (!email) {
      profileMap.forEach((v, k) => {
        if (!email && k.toLowerCase() === cleanUrl)
          email = (v.email as string) || null;
      });
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
  });

  const emailCount = enrichedLeads.filter((l) => l.email).length;
  const companyCount = enrichedLeads.filter((l) => l.company).length;

  onEvent({
    type: "step",
    message: `✅ ${enrichedLeads.length} leads ready — ${emailCount} emails · ${companyCount} companies`,
  });

  // ── Step 5: Save to Supabase ───────────────────────────────────────
  onEvent({ type: "step", message: "💾 Saving to database..." });

  const { error } = await supabase.from("scraped_leads").insert(
    enrichedLeads.map((lead) => ({
      user_id: userId,
      source_url: postUrl,
      ...lead,
    }))
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
    data: {
      leadsProcessed: enrichedLeads.length,
      emailsFound: emailCount,
    },
  });
}
