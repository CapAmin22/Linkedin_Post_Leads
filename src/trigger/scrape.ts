/**
 * Trigger.dev background task: LinkedIn post → enriched leads.
 *
 * Architecture:
 *   1. Launch headless Chromium via PinchTab HTTP API
 *   2. Login to LinkedIn (LINKEDIN_EMAIL / LINKEDIN_PASSWORD config)
 *   3. Scrape reactors from the post (scroll modal, collect up to `limit`)
 *   4. Deep-dive each profile page (job title, company, contact email)
 *   5. Fill gaps via LLM waterfall (Groq → Gemini → OpenAI → Regex)
 *   6. Save enriched leads to Supabase
 *   7. Emit progress events via task metadata (polled by the SSE route)
 */
import { task, metadata as taskMeta, logger } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import {
  normalizeProfiles,
  runAIParsing,
  type PipelineEvent,
  type ParsedTitle,
} from "@/lib/pipeline";

// ─── PinchTab HTTP Client (Official API) ────────────────────────────────

class PinchTabAPI {
  baseUrl: string;
  instanceId: string = "";
  tabId: string = "";

  constructor() {
    this.baseUrl = (process.env.PINCHTAB_URL || "http://localhost:9867").replace(/\/$/, "");
  }

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      throw new Error(`PinchTab ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async init(profileId: string = "leadharvest") {
    // Ensure profile exists (ignore if already created)
    try {
      await this.request("POST", "/profiles", { name: profileId });
    } catch { /* profile may already exist */ }

    const data = await this.request("POST", "/instances/start", {
      profileId,
      mode: "headless",
    });
    this.instanceId = data.id || data.instanceId;
    if (!this.instanceId) {
      throw new Error(`Invalid PinchTab response: ${JSON.stringify(data)}`);
    }
  }

  /** Open a new tab and navigate to url. Sets this.tabId. */
  async openTab(url: string): Promise<string> {
    const data = await this.request(
      "POST",
      `/instances/${this.instanceId}/tabs/open`,
      { url }
    );
    this.tabId = data.tabId || data.id;
    return this.tabId;
  }

  /** Execute JavaScript in the current tab via POST /tabs/{tabId}/eval */
  async eval<T>(expression: string): Promise<T> {
    const data = await this.request("POST", `/tabs/${this.tabId}/eval`, {
      expression,
    });
    return data && data.value !== undefined ? data.value : data;
  }

  /** Get accessibility snapshot of the current tab */
  async snapshot(filter?: string) {
    const qs = filter ? `?filter=${filter}` : "";
    return this.request("GET", `/tabs/${this.tabId}/snapshot${qs}`);
  }

  /** Perform a browser action (click, fill, type, press, hover) */
  async action(kind: string, ref: string, options?: Record<string, unknown>) {
    return this.request("POST", `/tabs/${this.tabId}/action`, {
      kind,
      ref,
      ...options,
    });
  }

  /** Extract page text */
  async getText(): Promise<string> {
    const data = await this.request("GET", `/tabs/${this.tabId}/text`);
    return typeof data === "string" ? data : data.text || data.content || "";
  }

  async close() {
    if (this.instanceId) {
      try {
        await this.request("POST", `/instances/${this.instanceId}/stop`);
      } catch { /* ignore close failures */ }
    }
  }

  async wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Login ────────────────────────────────────────────────────────────

async function loginLinkedIn(
  pinchtab: PinchTabAPI,
  email: string,
  password: string
): Promise<boolean> {
  await pinchtab.openTab("https://www.linkedin.com/login");
  await pinchtab.wait(2000);

  // Check if we are already logged in (profile persistence)
  const isLogged = await pinchtab.eval<boolean>(
    `window.location.href.includes('feed') || window.location.href.includes('mynetwork')`
  );
  if (isLogged) return true;

  // Perform login via eval (most reliable for LinkedIn's dynamic login form)
  await pinchtab.eval(`
    (() => {
      const u = document.querySelector('#username');
      const p = document.querySelector('#password');
      if (u) u.value = '${email}';
      if (p) p.value = '${password.replace(/'/g, "\\'")}';
      const btn = document.querySelector('[type=submit]');
      if (btn) btn.click();
    })()
  `);

  await pinchtab.wait(5000);
  const currentUrl = await pinchtab.eval<string>(`window.location.href`);
  return currentUrl.includes('feed') || currentUrl.includes('mynetwork') || currentUrl.includes('check');
}

// ─── Reaction scraping ────────────────────────────────────────────────

interface Reactor {
  fullName: string;
  headline: string;
  profileUrl: string;
  reactionType: string;
}

async function scrapeReactions(
  pinchtab: PinchTabAPI,
  postUrl: string,
  limit: number
): Promise<Reactor[]> {
  await pinchtab.openTab(postUrl);
  await pinchtab.wait(4000);

  // Try clicking reaction buttons
  const buttonClicked = await pinchtab.eval<boolean>(`
    (() => {
      const selectors = [
        "button.social-details-social-counts__count-value",
        ".social-details-social-counts__count-value",
        "button[aria-label*='reaction']",
        "button[aria-label*='like']",
        "button[aria-label*='Like']",
        "[data-test-id*='social-counts'] button"
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return true; }
      }
      const btns = document.querySelectorAll("button");
      for (const btn of btns) {
        const txt = (btn.textContent || "").trim().replace(/,/g, "");
        if (/^\\d+$/.test(txt)) { btn.click(); return true; }
      }
      return false;
    })()
  `);

  if (!buttonClicked) return [];
  await pinchtab.wait(2000);

  const reactors: Reactor[] = [];
  const seen = new Set<string>();
  let stale = 0;

  for (let scroll = 0; scroll < 25 && reactors.length < limit; scroll++) {
    // Extract current visible reactors
    const batch = await pinchtab.eval<Reactor[]>(`
      (() => {
        const rows = document.querySelectorAll('.artdeco-list__item');
        const items = [];
        for (const row of rows) {
          let name = "";
          for (const sel of [".artdeco-entity-lockup__title span[aria-hidden='true']", ".artdeco-entity-lockup__title", ".lockup__title span"]) {
            const el = row.querySelector(sel);
            if (el && el.textContent) { name = el.textContent.trim(); break; }
          }
          let headline = "";
          for (const sel of [".artdeco-entity-lockup__subtitle span[aria-hidden='true']", ".artdeco-entity-lockup__subtitle"]) {
            const el = row.querySelector(sel);
            if (el && el.textContent) { headline = el.textContent.trim(); break; }
          }
          let profileUrl = "";
          const a = row.querySelector("a[href*='/in/']");
          if (a) {
            profileUrl = a.getAttribute("href").split("?")[0].replace(/\\/$/, "");
          }
          if (name && profileUrl) {
            items.push({ fullName: name, headline, profileUrl, reactionType: "" });
          }
        }
        return items;
      })()
    `);

    let added = 0;
    for (const r of (batch || [])) {
      if (!seen.has(r.profileUrl)) {
        seen.add(r.profileUrl);
        reactors.push(r);
        added++;
        if (reactors.length >= limit) break;
      }
    }

    if (added === 0) {
      stale++;
      if (stale >= 3) break;
    } else {
      stale = 0;
    }

    // Scroll modal down
    await pinchtab.eval(`
      (() => {
        for (const sel of [".artdeco-modal__content", ".social-details-reactors-modal", ".reactions-tabpanel", ".scaffold-finite-scroll__content"]) {
          const el = document.querySelector(sel);
          if (el) { el.scrollTop += 600; return; }
        }
      })()
    `);
    await pinchtab.wait(1500);
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
  pinchtab: PinchTabAPI,
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
    await pinchtab.openTab(profileUrl);
    await pinchtab.wait(3000);

    const data = await pinchtab.eval<Partial<ProfileData & { currentUrl: string }>>(`
      (() => {
        let jobTitle = "";
        for (const sel of [".text-body-medium.break-words", ".pv-text-details__left-panel .text-body-medium", "h2.mt1"]) {
          const el = document.querySelector(sel);
          if (el && el.textContent) { jobTitle = el.textContent.trim(); break; }
        }

        let company = "";
        let companyUrl = "";
        try {
          const expSection = document.querySelector("#experience")?.parentElement;
          if (expSection) {
            const firstItem = expSection.querySelector(".pvs-list__paged-list-item");
            if (firstItem) {
              const compEl = firstItem.querySelector(".t-bold span[aria-hidden='true']");
              if (compEl) company = compEl.textContent.trim();

              const a = firstItem.querySelector("a[href*='/company/']");
              if (a) companyUrl = "https://linkedin.com" + a.getAttribute("href").split("?")[0];
            }
          }
        } catch {}

        return { jobTitle, company, companyUrl, currentUrl: window.location.href };
      })()
    `);

    // Fetch email via contact-info overlay
    let email = "";
    try {
      await pinchtab.eval(`
        (() => {
          const a = document.querySelector("a[href*='/overlay/contact-info/']");
          if (a) a.click();
        })()
      `);
      await pinchtab.wait(1500);
      email = await pinchtab.eval<string>(`
        (() => {
          const e = document.querySelector("a[href^='mailto:']");
          if (e) return e.getAttribute("href").replace("mailto:", "").trim();
          return "";
        })()
      `);
    } catch { /* contact info may not be available */ }

    const resolvedUrl = data?.currentUrl || profileUrl;
    const finalUrl = (resolvedUrl.includes("/in/") && !resolvedUrl.includes("ACoA"))
      ? resolvedUrl.split("?")[0].replace(/\/$/, "")
      : profileUrl;

    return {
      linkedinUrl: finalUrl,
      jobTitle: data?.jobTitle || "",
      company: data?.company || "",
      companyUrl: data?.companyUrl || "",
      email: email || "",
      fullName,
    };
  } catch {
    return empty;
  }
}

// ─── Email enrichment: Apollo → Hunter ───────────────────────────────

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}

async function enrichViaApollo(firstName: string, lastName: string, company: string): Promise<string | null> {
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
    const res = await fetch(`https://api.hunter.io/v2/domain-search?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { domain?: string } };
    return data.data?.domain || null;
  } catch {
    return null;
  }
}

async function enrichViaHunter(firstName: string, lastName: string, domain: string): Promise<string | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !firstName || !domain) return null;
  try {
    const params = new URLSearchParams({ first_name: firstName, last_name: lastName, domain, api_key: apiKey });
    const res = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { email?: string } };
    return data.data?.email || null;
  } catch {
    return null;
  }
}

async function enrichLeadEmail(fullName: string, company: string): Promise<string | null> {
  const { firstName, lastName } = splitName(fullName);
  const apolloEmail = await enrichViaApollo(firstName, lastName, company);
  if (apolloEmail) return apolloEmail;

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

    const events: PipelineEvent[] = [];
    const emit = (event: PipelineEvent) => {
      events.push(event);
      taskMeta.set("events", events as never).flush().catch(() => {});
      logger.info(event.message);
    };

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const linkedinEmail = process.env.NEXT_PUBLIC_LINKEDIN_EMAIL || process.env.LINKEDIN_EMAIL;
    const linkedinPassword = process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD || process.env.LINKEDIN_PASSWORD;
    if (!linkedinEmail || !linkedinPassword) {
      emit({
        type: "error",
        message: "❌ LINKEDIN_EMAIL / LINKEDIN_PASSWORD not set in environment variables",
      });
      await taskMeta.set("done" as never, true as never).flush();
      return;
    }

    emit({ type: "step", message: "🔍 Step 1/3 — Launching browser via PinchTab..." });

    const pinchtab = new PinchTabAPI();
    let reactors: Reactor[] = [];
    const profileMap = new Map<string, ProfileData>();

    try {
      try {
        await pinchtab.init("leadharvest");
      } catch (e: unknown) {
        emit({ type: "error", message: `❌ Failed connecting to PinchTab: ${(e as Error)?.message}`});
        await taskMeta.set("done" as never, true as never).flush();
        return;
      }

      emit({ type: "step", message: "🔑 Checking LinkedIn Session..." });
      try {
        const authed = await loginLinkedIn(pinchtab, linkedinEmail, linkedinPassword);
        if (!authed) throw new Error("Could not confirm login status");
        emit({ type: "step", message: "✅ Logged in" });
      } catch (err: unknown) {
        emit({
          type: "error",
          message: `❌ Login failed: ${(err as Error)?.message}.`,
        });
        return;
      }

      emit({ type: "step", message: `🔎 Navigating to post...` });
      reactors = await scrapeReactions(pinchtab, url, limit);
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
        const data = await scrapeProfile(pinchtab, reactor.profileUrl, reactor.fullName);
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
      await pinchtab.close();
    }

    // ── Step 3: LLM parsing ───────────────────────────────────────────
    const normalized = normalizeProfiles(reactors as unknown as Record<string, unknown>[], emit);
    const parsedTitles = new Map<number, ParsedTitle>();

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
