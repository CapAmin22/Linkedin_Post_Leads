# LeadHarvest — LinkedIn Lead Extraction & Enrichment

A premium B2B SaaS application that automatically extracts, AI-parses, and enriches leads from LinkedIn post engagement.

## 🚀 Recent Updates (March 2026)
- **Playwright Agent**: Replaced legacy Python scraper with a direct Node.js/Playwright browser agent for better reliability and performance.
- **Improved UI**: Completely redesigned landing page with "Premium" aesthetics, glassmorphism, and better responsiveness.
- **ESLint/Build Fixes**: Resolved critical linting errors and React hook violations to ensure production stability.
- **Metadata Progress**: Added task metadata tracking in Trigger.dev for real-time progress updates.

## Architecture

```
User → Next.js (Tailwind v4) → API Route → Trigger.dev (Playwright)
                                                  │
                                          ┌───────┼───────┐
                                          ▼       ▼       ▼
                                     LinkedIn   Gemini  Apollo
                                     (Chrome)   (AI)   (Email)
                                          │       │       │
                                          └───────┼───────┘
                                                  ▼
                                         Supabase PostgreSQL
```

**Pipeline:**
1. **Extract** — Playwright-stealth browser logs into LinkedIn and scrapes post reactors/commenters.
2. **Deep Scrape** — The agent visits each profile to extract job titles, companies, and public contact info.
3. **AI Resolve** — Gemini/Groq parses messy headlines into structured data.
4. **Enrich** — Apollo.io (via profile mapping) matches leads to verified business emails.
5. **Store** — Results are saved to Supabase with RLS protections.

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | Next.js 15+ (App Router) | Core application logic |
| Browser Agent | Playwright (Chromium) | Stealthy LinkedIn scraping |
| Styling | Tailwind CSS v4 | Premium UI & Glassmorphism |
| Background Jobs | Trigger.dev v3 | Reliable long-running pipelines |
| Database/Auth | Supabase | Postgres + JWT Auth + RLS |
| AI Intelligence | Google Gemini / Groq | LLM-based headline parsing |

## Environment Variables

Create a `.env.local` file in the project root:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# LinkedIn Credentials (for browser login)
NEXT_PUBLIC_LINKEDIN_EMAIL=...
NEXT_PUBLIC_LINKEDIN_PASSWORD=...

# APIs
TRIGGER_API_KEY=...
GEMINI_API_KEY=...
APIFY_API_TOKEN=... # Optional fallback
APOLLO_API_KEY=...
```

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Connect Trigger.dev
```bash
npx trigger.dev@latest dev
```

### 3. Run Locally
```bash
npm run dev
```

### 4. Build for Production
```bash
npm run build
```

---
*LeadHarvest — From Engagement to Revenue.*

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout (dark mode + Sonner)
│   ├── page.tsx                # Landing page
│   ├── globals.css             # Tailwind + shadcn theme
│   ├── login/page.tsx          # Login page
│   ├── signup/page.tsx         # Signup page
│   ├── auth/callback/route.ts  # Supabase OAuth callback
│   ├── dashboard/page.tsx      # Main dashboard
│   └── api/
│       ├── scrape/route.ts     # Dispatches Trigger.dev job
│       └── job-status/route.ts # Returns job status
├── components/
│   ├── ui/                     # shadcn/ui components
│   ├── AuthForm.tsx            # Login/signup form
│   ├── DashboardHeader.tsx     # Nav bar + logout
│   ├── ScrapeForm.tsx          # URL input form
│   ├── LeadsTable.tsx          # Leads data table
│   └── JobStatusBadge.tsx      # Job status indicator
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client
│   │   ├── server.ts           # Server Supabase client
│   │   └── middleware.ts       # Session refresh helper
│   └── utils.ts                # cn() helper
├── trigger/
│   └── scrape-leads.ts         # Apify → Gemini → Apollo pipeline
└── middleware.ts               # Auth guard middleware

## License

Proprietary. All rights reserved.
