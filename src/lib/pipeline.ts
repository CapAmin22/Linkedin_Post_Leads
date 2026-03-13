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

// ─── HTTP Helpers ────────────────────────────────────────────────────

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

export function fallbackRegexParse(headline: string): ParsedTitle {
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

export function buildPrompt(headlines: string): string {
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

export function extractParsedArray(
  text: string
): { index: number; jobTitle: string; company: string }[] {
  const jsonStr = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const raw = JSON.parse(jsonStr);
  if (Array.isArray(raw)) return raw;
  for (const key of Object.keys(raw)) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

export async function parseWithGroq(prompt: string): Promise<string> {
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
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Groq ${res.status}: ${e.error?.message || "error"}`);
  }
  return ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
}

export async function parseWithGemini(prompt: string): Promise<string> {
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
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Gemini ${res.status}: ${e.error?.message || "error"}`);
  }
  return ((await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] }).candidates[0].content.parts[0].text;
}

export async function parseWithOpenAI(prompt: string): Promise<string> {
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
  return ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
}

export async function runAIParsing(
  profiles: NormalizedProfile[],
  parsedTitles: Map<number, ParsedTitle>,
  onEvent: (event: PipelineEvent) => void
): Promise<string> {
  const headlines = profiles.map((p, i) => `${i}. "${p.headline || "N/A"}"`).join("\n");
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
        message: `⚠️ Groq: ${(err as Error)?.message} — trying Gemini...`,
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
        message: `⚠️ OpenAI: ${(err as Error)?.message} — using regex fallback...`,
      });
    }
  }

  // Always fill remaining gaps with regex
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
