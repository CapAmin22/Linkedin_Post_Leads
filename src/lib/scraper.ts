/**
 * LinkedIn Post Reactor Scraper — Zero-cost, local Playwright execution.
 *
 * Architecture:
 *   1. Launch headless Chromium (Playwright) locally with anti-detection
 *   2. Login to LinkedIn (LINKEDIN_EMAIL / LINKEDIN_PASSWORD env vars)
 *   3. Scrape ALL reactors from the post (scroll until exhausted)
 *   4. Deep-dive each profile (name, location, job title, company, company URL)
 *   5. Fill gaps via LLM waterfall (Groq → Gemini → Regex)
 *   6. Save enriched leads to Supabase
 *   7. Yield progress events for SSE streaming
 */
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
  postUrl: string
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
  const MAX_SCROLLS = 200; // Support large posts

  for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
    const rows = modal.locator(".artdeco-list__item");
    const count = await rows.count();
    let added = 0;

    for (let i = 0; i < count; i++) {
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
        reactors.push({
          fullName: name,
          headline,
          profileUrl,
          reactionType: "",
        });
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

  return reactors;
}

// ─── Profile deep-dive ────────────────────────────────────────────────

interface ProfileData {
  linkedinUrl: string;
  jobTitle: string;
  company: string;
  companyUrl: string;
  location: string;
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
    location: "",
    email: "",
    fullName,
  };
  try {
    await page.goto(profileUrl, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);

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

    // Location from profile header
    let location = "";
    for (const sel of [
      ".text-body-small.inline.t-black--light.break-words",
      ".pv-text-details__left-panel .text-body-small",
      "span.text-body-small.break-words",
    ]) {
      try {
        location = (
          (await page.locator(sel).first().textContent({ timeout: 2000 })) || ""
        ).trim();
        if (location) break;
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

    // Email via contact-info overlay (free — reads public profile data)
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

    return {
      linkedinUrl: profileUrl,
      jobTitle,
      company,
      companyUrl,
      location,
      email,
      fullName,
    };
  } catch {
    return empty;
  }
}

// ─── Main scraping generator ─────────────────────────────────────────

export async function* scrapeLinkedInPost(params: {
  url: string;
  userId: string;
}): AsyncGenerator<PipelineEvent> {
  const { url, userId } = params;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const linkedinEmail = process.env.LINKEDIN_EMAIL;
  const linkedinPassword = process.env.LINKEDIN_PASSWORD;
  if (!linkedinEmail || !linkedinPassword) {
    yield {
      type: "error",
      message:
        "LINKEDIN_EMAIL / LINKEDIN_PASSWORD not set in environment variables",
    };
    return;
  }

  // ── Step 1: Scrape reactions ──────────────────────────────────────
  yield { type: "step", message: "Step 1/3 — Launching browser..." };

  let reactors: Reactor[] = [];
  const profileMap = new Map<string, ProfileData>();
  const browser = await createBrowser();

  try {
    const page = await newStealthPage(browser);

    yield { type: "step", message: "Logging in to LinkedIn..." };
    try {
      await loginLinkedIn(page, linkedinEmail, linkedinPassword);
      yield { type: "step", message: "Logged in successfully" };
    } catch (err: unknown) {
      yield {
        type: "error",
        message: `Login failed: ${(err as Error)?.message}. Check LINKEDIN_EMAIL / LINKEDIN_PASSWORD.`,
      };
      return;
    }

    yield { type: "step", message: "Navigating to post..." };
    reactors = await scrapeReactions(page, url);
    yield {
      type: "step",
      message: `Found ${reactors.length} reactor(s)`,
    };

    if (reactors.length === 0) {
      yield {
        type: "done",
        message:
          "No reactors found. Post may have 0 reactions or URL is incorrect.",
        data: { leadsProcessed: 0 },
      };
      return;
    }

    // ── Step 2: Profile deep-dive ─────────────────────────────────
    yield {
      type: "step",
      message: `Step 2/3 — Scraping ${reactors.length} profile(s)...`,
    };

    for (let i = 0; i < reactors.length; i++) {
      const reactor = reactors[i];
      if (!reactor.profileUrl.startsWith("http")) continue;
      const data = await scrapeProfile(
        page,
        reactor.profileUrl,
        reactor.fullName
      );
      profileMap.set(reactor.profileUrl.replace(/\/$/, ""), data);
      if ((i + 1) % 5 === 0 || i === reactors.length - 1) {
        yield {
          type: "step",
          message: `  Profiles scraped: ${i + 1}/${reactors.length}`,
        };
      }
    }

    yield {
      type: "step",
      message: `${profileMap.size} profiles enriched`,
    };
  } finally {
    await browser.close();
  }

  // ── Step 3: LLM parsing ───────────────────────────────────────────
  const events: PipelineEvent[] = [];
  const emit = (event: PipelineEvent) => {
    events.push(event);
  };

  const normalized = normalizeProfiles(
    reactors as unknown as Record<string, unknown>[],
    emit
  );
  // Yield any events from normalizeProfiles
  for (const e of events) yield e;

  const parsedTitles = new Map<number, ParsedTitle>();

  // Pre-fill from Playwright profile data
  normalized.forEach((p, i) => {
    const cleanUrl = p.linkedinUrl
      .split("?")[0]
      .replace(/\/$/, "")
      .toLowerCase();
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
    yield {
      type: "step",
      message: `Step 3/3 — AI parsing ${gaps.length} unparsed headline(s)...`,
    };
    const aiEvents: PipelineEvent[] = [];
    const aiUsed = await runAIParsing(normalized, parsedTitles, (e) =>
      aiEvents.push(e)
    );
    for (const e of aiEvents) yield e;
    yield { type: "step", message: `Titles resolved via: ${aiUsed}` };
  } else {
    yield {
      type: "step",
      message: "All titles resolved from profile deep-dive",
    };
  }

  // ── Finalise & save ───────────────────────────────────────────────
  yield {
    type: "step",
    message: `Finalising ${normalized.length} leads...`,
  };

  const enrichedLeads = normalized.map((profile, i) => {
    const parsed = parsedTitles.get(i);
    const cleanUrl = profile.linkedinUrl
      .split("?")[0]
      .replace(/\/$/, "")
      .toLowerCase();

    let email: string | null = profile.email || null;
    let companyLinkedinUrl: string | null = parsed?.companyUrl || null;
    let location: string | null = null;

    for (const [k, v] of profileMap) {
      if (k.toLowerCase() === cleanUrl) {
        if (!email && v.email) email = v.email;
        if (!companyLinkedinUrl && v.companyUrl)
          companyLinkedinUrl = v.companyUrl;
        if (v.location) location = v.location;
        break;
      }
    }

    return {
      full_name: profile.fullName || "Unknown",
      linkedin_url: profile.linkedinUrl,
      headline: profile.headline,
      job_title: parsed?.jobTitle || profile.headline || "",
      company: parsed?.company || "",
      company_linkedin_url: companyLinkedinUrl,
      location,
      email,
      status: "completed",
    };
  });

  const companyCount = enrichedLeads.filter((l) => l.company).length;
  const companyUrlCount = enrichedLeads.filter(
    (l) => l.company_linkedin_url
  ).length;

  yield {
    type: "step",
    message: `${enrichedLeads.length} leads — ${companyCount} companies · ${companyUrlCount} company URLs`,
  };

  // Save to Supabase
  yield { type: "step", message: "Saving to database..." };
  const { error } = await supabase.from("scraped_leads").insert(
    enrichedLeads.map((lead) => ({
      user_id: userId,
      source_url: url,
      ...lead,
    }))
  );

  if (error) {
    yield {
      type: "error",
      message: `DB save failed: ${error.message}`,
      data: { errorDetail: error.message, code: error.code },
    };
    return;
  }

  yield {
    type: "done",
    message: `Done! ${enrichedLeads.length} leads saved — ${companyCount} companies · ${companyUrlCount} company URLs`,
    data: { leadsProcessed: enrichedLeads.length },
  };
}
