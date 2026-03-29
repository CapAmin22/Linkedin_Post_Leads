/**
 * Trigger.dev background task: LinkedIn post → enriched leads.
 *
 * Architecture:
 *   1. Launch headless Chromium (Playwright) with anti-detection
 *   2. Login to LinkedIn (LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars)
 *   3. Scrape reactors from the post (scroll modal, collect up to `limit`)
 *   4. Deep-dive each profile page (job title, company, contact email)
 *   5. Fill gaps via LLM waterfall (Groq → Gemini → OpenAI → Regex)
 *   6. Save enriched leads to Supabase
 *   7. Emit progress events via task metadata (polled by the SSE route)
 */
import { task, metadata as taskMeta, logger } from "@trigger.dev/sdk/v3";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { createClient } from "@supabase/supabase-js";
import {
  normalizeProfiles,
  runAIParsing,
  type PipelineEvent,
  type ParsedTitle,
} from "@/lib/pipeline";

// ─── LinkedIn scraper constants ───────────────────────────────────────

const BTN_SELECTORS = [
  "button.social-details-social-counts__count-value",
  ".social-details-social-counts__count-value",
  "button[aria-label*='reaction']",
  "button[aria-label*='like']",
  "button[aria-label*='Like']",
  "[data-test-id*='social-counts'] button",
];

const MODAL_SELECTORS = [
  ".artdeco-modal__content",
  ".social-details-reactors-modal",
  ".reactions-tabpanel",
  "[class*='reactions-modal']",
  "[class*='reactor-list']",
  ".scaffold-finite-scroll__content",
];

// ─── Browser factory ──────────────────────────────────────────────────

async function createBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
}

async function newStealthPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: true,
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  // Hide webdriver + other automation signals
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
  });
  return ctx.newPage();
}

// ─── Login ────────────────────────────────────────────────────────────

async function loginLinkedIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.fill("#username", email);
  await page.fill("#password", password);
  await page.click("[type=submit]");
  await page.waitForURL(/linkedin\.com\/(feed|in\/|check\/|mynetwork)/, {
    timeout: 20000,
  });
}

// ─── Reaction scraping ────────────────────────────────────────────────

interface Reactor {
  fullName: string;
  headline: string;
  profileUrl: string;
  reactionType: string;
}

async function tryClickButton(page: Page): Promise<boolean> {
  for (const sel of BTN_SELECTORS) {
    try {
      await page.click(sel, { timeout: 4000 });
      return true;
    } catch {
      /* try next */
    }
  }
  // Fallback: any button whose text is a number
  const btns = await page.$$("button");
  for (const btn of btns) {
    const txt = ((await btn.textContent()) || "").trim().replace(/,/g, "");
    if (/^\d+$/.test(txt)) {
      await btn.click();
      return true;
    }
  }
  return false;
}

async function findModal(page: Page): Promise<Locator | null> {
  for (const sel of MODAL_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 6000 });
      return page.locator(sel).first();
    } catch {
      /* try next */
    }
  }
  return null;
}

async function scrapeReactions(
  page: Page,
  postUrl: string,
  limit: number
): Promise<Reactor[]> {
  await page.goto(postUrl, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);

  const clicked = await tryClickButton(page);
  if (!clicked) return [];

  await page.waitForTimeout(2000);

  const modal = await findModal(page);
  if (!modal) return [];

  const reactors: Reactor[] = [];
  const seen = new Set<string>();
  let stale = 0;

  for (let scroll = 0; scroll < 25 && reactors.length < limit; scroll++) {
    const rows = modal.locator(".artdeco-list__item");
    const count = await rows.count();
    let added = 0;

    for (let i = 0; i < count && reactors.length < limit; i++) {
      const row = rows.nth(i);

      let name = "";
      for (const sel of [
        ".artdeco-entity-lockup__title span[aria-hidden='true']",
        ".artdeco-entity-lockup__title",
        ".lockup__title span",
        "span[aria-hidden='true']",
      ]) {
        try {
          name = (
            (await row.locator(sel).first().textContent({ timeout: 400 })) ||
            ""
          ).trim();
          if (name) break;
        } catch {
          /* try next */
        }
      }

      let headline = "";
      for (const sel of [
        ".artdeco-entity-lockup__subtitle span[aria-hidden='true']",
        ".artdeco-entity-lockup__subtitle",
        ".lockup__subtitle span",
      ]) {
        try {
          headline = (
            (await row.locator(sel).first().textContent({ timeout: 400 })) ||
            ""
          ).trim();
          if (headline) break;
        } catch {
          /* try next */
        }
      }

      let profileUrl = "";
      try {
        const href = await row
          .locator("a[href*='/in/']")
          .first()
          .getAttribute("href", { timeout: 400 });
        profileUrl = (href || "").split("?")[0].replace(/\/$/, "");
      } catch {
        /* skip */
      }

      if (name && profileUrl && !seen.has(profileUrl)) {
        seen.add(profileUrl);
        reactors.push({ fullName: name, headline, profileUrl, reactionType: "" });
        added++;
      }
    }

    if (added === 0) {
      stale++;
      if (stale >= 3) break;
    } else {
      stale = 0;
    }

    await modal.evaluate((el) => {
      el.scrollTop += 600;
    });
    await page.waitForTimeout(1500);
  }

  return reactors.slice(0, limit);
}

// ─── Profile deep-dive ────────────────────────────────────────────────

interface ProfileData {
  linkedinUrl: string;
  jobTitle: string;
  company: string;
  companyUrl: string;
  email: string;
  fullName: string;
}

async function scrapeProfile(
  page: Page,
  profileUrl: string,
  fullName: string
): Promise<ProfileData> {
  const empty: ProfileData = {
    linkedinUrl: profileUrl,
    jobTitle: "",
    company: "",
    companyUrl: "",
    email: "",
    fullName,
  };
  try {
    await page.goto(profileUrl, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);

    // Resolve canonical URL — LinkedIn redirects /in/ACoAA... internal IDs to /in/username slugs
    const resolvedUrl = page.url().split("?")[0].replace(/\/$/, "");
    if (resolvedUrl.includes("/in/") && !resolvedUrl.includes("ACoA")) {
      empty.linkedinUrl = resolvedUrl;
    }

    // Headline / current role
    let jobTitle = "";
    for (const sel of [
      ".text-body-medium.break-words",
      ".pv-text-details__left-panel .text-body-medium",
      "h2.mt1",
    ]) {
      try {
        jobTitle = (
          (await page.locator(sel).first().textContent({ timeout: 2000 })) || ""
        ).trim();
        if (jobTitle) break;
      } catch {
        /* try next */
      }
    }

    // Company from experience section
    let company = "";
    let companyUrl = "";
    try {
      const expSection = page.locator("#experience").locator("..");
      const firstItem = expSection
        .locator(".pvs-list__paged-list-item")
        .first();
      company = (
        (await firstItem
          .locator(".t-bold span[aria-hidden='true']")
          .first()
          .textContent({ timeout: 2000 })) || ""
      ).trim();
      const href = await firstItem
        .locator("a[href*='/company/']")
        .first()
        .getAttribute("href", { timeout: 2000 });
      if (href) {
        companyUrl = `https://linkedin.com${href.split("?")[0]}`;
      }
    } catch {
      /* no experience section */
    }

    // Email via contact-info overlay
    let email = "";
    try {
      await page
        .locator("a[href*='/overlay/contact-info/']")
        .first()
        .click({ timeout: 3000 });
      await page.waitForTimeout(1000);
      const emailHref = await page
        .locator("a[href^='mailto:']")
        .first()
        .getAttribute("href", { timeout: 2000 });
      email = (emailHref || "").replace("mailto:", "").trim();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    } catch {
      /* no public email */
    }

    // Use resolved canonical URL if available, otherwise fall back to original
    const canonicalUrl = page.url().split("?")[0].replace(/\/$/, "");
    const finalUrl = (canonicalUrl.includes("/in/") && !canonicalUrl.includes("ACoA"))
      ? canonicalUrl
      : profileUrl;
    return { linkedinUrl: finalUrl, jobTitle, company, companyUrl, email, fullName };
  } catch {
    return empty;
  }
}

// ─── Email enrichment: Apollo → Hunter ───────────────────────────────

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}

async function enrichViaApollo(
  firstName: string,
  lastName: string,
  company: string
): Promise<string | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey || !firstName || !company) return null;
  try {
    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({ api_key: apiKey, first_name: firstName, last_name: lastName, organization_name: company }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { person?: { email?: string } };
    return data.person?.email || null;
  } catch {
    return null;
  }
}

async function getDomainViaHunter(company: string): Promise<string | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !company) return null;
  try {
    const params = new URLSearchParams({ company, api_key: apiKey, limit: "1" });
    const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { domain?: string } };
    return data.data?.domain || null;
  } catch {
    return null;
  }
}

async function enrichViaHunter(
  firstName: string,
  lastName: string,
  domain: string
): Promise<string | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !firstName || !domain) return null;
  try {
    const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain, api_key: apiKey });
    const res = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { email?: string } };
    return data.data?.email || null;
  } catch {
    return null;
  }
}

async function enrichLeadEmail(
  fullName: string,
  company: string
): Promise<string | null> {
  const { firstName, lastName } = splitName(fullName);

  // Try Apollo first (works with company name alone — no domain needed)
  const apolloEmail = await enrichViaApollo(firstName, lastName, company);
  if (apolloEmail) return apolloEmail;

  // Fall back to Hunter: resolve domain first, then find email
  if (company) {
    const domain = await getDomainViaHunter(company);
    if (domain) {
      const hunterEmail = await enrichViaHunter(firstName, lastName, domain);
      if (hunterEmail) return hunterEmail;
    }
  }

  return null;
}

// ─── Trigger.dev task ─────────────────────────────────────────────────

export const scrapeLinkedInPost = task({
  id: "scrape-linkedin-post",
  maxDuration: 600,

  run: async (payload: { url: string; userId: string; limit?: number }) => {
    const { url, userId, limit = 20 } = payload;

    // Event bus: accumulates all progress events; SSE route polls these
    const events: PipelineEvent[] = [];
    const emit = (event: PipelineEvent) => {
      events.push(event);
      // Fire-and-forget — flush is best-effort for real-time progress
      taskMeta
        .set("events", events as never)
        .flush()
        .catch(() => {});
      logger.info(event.message);
    };

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const linkedinEmail =
      process.env.NEXT_PUBLIC_LINKEDIN_EMAIL || process.env.LINKEDIN_EMAIL;
    const linkedinPassword =
      process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD || process.env.LINKEDIN_PASSWORD;
    if (!linkedinEmail || !linkedinPassword) {
      emit({
        type: "error",
        message:
          "❌ LINKEDIN_EMAIL / LINKEDIN_PASSWORD not set in environment variables",
      });
      await taskMeta.set("done" as never, true as never).flush();
      return;
    }

    // ── Step 1: Scrape reactions ──────────────────────────────────────
    emit({ type: "step", message: "🔍 Step 1/3 — Launching browser..." });

    let reactors: Reactor[] = [];
    const profileMap = new Map<string, ProfileData>();
    const browser = await createBrowser();

    try {
      const page = await newStealthPage(browser);

      emit({ type: "step", message: "🔑 Logging in to LinkedIn..." });
      try {
        await loginLinkedIn(page, linkedinEmail, linkedinPassword);
        emit({ type: "step", message: "✅ Logged in" });
      } catch (err: unknown) {
        emit({
          type: "error",
          message: `❌ Login failed: ${(err as Error)?.message}. Check LINKEDIN_EMAIL / LINKEDIN_PASSWORD.`,
        });
        return;
      }

      emit({ type: "step", message: `🔎 Navigating to post...` });
      reactors = await scrapeReactions(page, url, limit);
      emit({
        type: "step",
        message: `📋 Found ${reactors.length} reactor(s)`,
      });

      if (reactors.length === 0) {
        emit({
          type: "done",
          message: "⚠️ No reactors found. Post may have 0 reactions or URL is wrong.",
          data: { leadsProcessed: 0 },
        });
        await taskMeta.set("done" as never, true as never).flush();
        return;
      }

      // ── Step 2: Profile deep-dive ─────────────────────────────────
      emit({
        type: "step",
        message: `🔎 Step 2/3 — Deep-diving ${reactors.length} profile(s)...`,
      });

      for (let i = 0; i < reactors.length; i++) {
        const reactor = reactors[i];
        if (!reactor.profileUrl.startsWith("http")) continue;
        const data = await scrapeProfile(page, reactor.profileUrl, reactor.fullName);
        profileMap.set(reactor.profileUrl.replace(/\/$/, ""), data);
        if ((i + 1) % 5 === 0 || i === reactors.length - 1) {
          emit({
            type: "step",
            message: `  ↳ Profiles scraped: ${i + 1}/${reactors.length}`,
          });
        }
      }

      emit({
        type: "step",
        message: `✅ ${profileMap.size} profiles enriched`,
      });
    } finally {
      await browser.close();
    }

    // ── Step 3: LLM parsing ───────────────────────────────────────────
    const normalized = normalizeProfiles(reactors as unknown as Record<string, unknown>[], emit);
    const parsedTitles = new Map<number, ParsedTitle>();

    // Pre-fill from Playwright profile data
    normalized.forEach((p, i) => {
      const cleanUrl = p.linkedinUrl.split("?")[0].replace(/\/$/, "").toLowerCase();
      for (const [k, v] of profileMap) {
        if (k.toLowerCase() === cleanUrl) {
          if (v.jobTitle || v.company) {
            parsedTitles.set(i, {
              jobTitle: v.jobTitle,
              company: v.company,
              companyUrl: v.companyUrl,
            });
          }
          break;
        }
      }
    });

    const gaps = normalized.filter((_, i) => !parsedTitles.has(i));
    if (gaps.length > 0) {
      emit({
        type: "step",
        message: `🤖 Step 3/3 — AI parsing ${gaps.length} unparsed headline(s)...`,
      });
      const aiUsed = await runAIParsing(normalized, parsedTitles, emit);
      emit({ type: "step", message: `📊 Titles resolved via: ${aiUsed}` });
    } else {
      emit({ type: "step", message: "✅ All titles resolved from profile deep-dive" });
    }

    // ── Finalise & save ───────────────────────────────────────────────
    emit({ type: "step", message: `📧 Finalising ${normalized.length} leads...` });

    const enrichedLeads = normalized.map((profile, i) => {
      const parsed = parsedTitles.get(i);
      const cleanUrl = profile.linkedinUrl.split("?")[0].replace(/\/$/, "").toLowerCase();

      let email: string | null = profile.email || null;
      if (!email) {
        for (const [k, v] of profileMap) {
          if (k.toLowerCase() === cleanUrl && v.email) {
            email = v.email;
            break;
          }
        }
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

    // ── Step 4: Apollo + Hunter email enrichment ──────────────────────
    const leadsNeedingEmail = enrichedLeads.filter((l) => !l.email && l.company);
    if (leadsNeedingEmail.length > 0 && (process.env.APOLLO_API_KEY || process.env.HUNTER_API_KEY)) {
      emit({
        type: "step",
        message: `📧 Step 4/4 — Enriching ${leadsNeedingEmail.length} email(s) via Apollo/Hunter...`,
      });
      let enriched = 0;
      for (const lead of leadsNeedingEmail) {
        const email = await enrichLeadEmail(lead.full_name, lead.company);
        if (email) {
          lead.email = email;
          enriched++;
        }
      }
      emit({
        type: "step",
        message: `✅ Apollo/Hunter found ${enriched} additional email(s)`,
      });
    }

    const emailCount = enrichedLeads.filter((l) => l.email).length;
    const companyCount = enrichedLeads.filter((l) => l.company).length;

    emit({
      type: "step",
      message: `✅ ${enrichedLeads.length} leads — ${emailCount} emails · ${companyCount} companies`,
    });

    // Save to Supabase — upsert on (user_id, linkedin_url, source_url) to prevent duplicates
    emit({ type: "step", message: "💾 Saving to database..." });
    const { error } = await supabase
      .from("scraped_leads")
      .upsert(
        enrichedLeads.map((lead) => ({
          user_id: userId,
          source_url: url,
          ...lead,
        })),
        { onConflict: "user_id,linkedin_url,source_url", ignoreDuplicates: false }
      );

    if (error) {
      emit({
        type: "error",
        message: `❌ DB save failed: ${error.message}`,
        data: { errorDetail: error.message, code: error.code },
      });
      await taskMeta.set("done" as never, true as never).flush();
      return;
    }

    emit({
      type: "done",
      message: `🎉 Done! ${enrichedLeads.length} leads saved · ${emailCount} emails · ${companyCount} companies`,
      data: { leadsProcessed: enrichedLeads.length, emailsFound: emailCount },
    });

    await taskMeta.set("done" as unknown as Parameters<typeof taskMeta.set>[0], true as unknown as Parameters<typeof taskMeta.set>[1]);
    return { leadsProcessed: enrichedLeads.length, emailsFound: emailCount };
  },
});
