# LeadHarvest — LinkedIn Post Lead Extraction

A B2B SaaS application that automatically extracts, AI-parses, and enriches leads from LinkedIn post engagement.

## Architecture

```
User → Next.js Frontend → API Route → Trigger.dev Task
                                            │
                                    ┌───────┼───────┐
                                    ▼       ▼       ▼
                                 Apify   Gemini  Apollo
                                    │       │       │
                                    └───────┼───────┘
                                            ▼
                                   Supabase PostgreSQL
                                            │
                                            ▼
                                   Frontend (Polling)
```

**Pipeline:**

1. **Extract** — Apify scrapes all profiles that engaged with the LinkedIn post.
2. **Parse** — Gemini AI cleans messy LinkedIn headlines into structured `{jobTitle, company}`.
3. **Enrich** — Apollo.io matches each lead to a verified business email.
4. **Store** — Results are saved to Supabase with Row Level Security per user.

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend/Backend | Next.js 16 (App Router) | Full-stack framework |
| Styling | Tailwind CSS v4 + shadcn/ui | Component library |
| Database | Supabase PostgreSQL | Auth + data storage + RLS |
| Background Jobs | Trigger.dev v3 | Long-running scrape pipeline |
| LinkedIn Scraping | Apify | Profile extraction |
| AI Parsing | Google Gemini | Job title/company parsing |
| Email Enrichment | Apollo.io | B2B email lookup |
| CI/CD | GitHub Actions + Vercel | Lint/build checks + auto-deploy |

## Environment Variables

Create a `.env.local` file in the project root (see `.env.example`):

```bash
# Database
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Background Jobs
TRIGGER_API_KEY=your-trigger-dev-key

# AI & Enrichment APIs
GEMINI_API_KEY=your-gemini-key
APIFY_API_TOKEN=your-apify-token
APOLLO_API_KEY=your-apollo-key
```

### Where to Find Each Key

| Variable | Where to Get It |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API → `anon` / `public` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Settings → API → `service_role` key |
| `TRIGGER_API_KEY` | Trigger.dev Dashboard → Project → API Keys |
| `GEMINI_API_KEY` | Google AI Studio → API Keys |
| `APIFY_API_TOKEN` | Apify Console → Settings → Integrations |
| `APOLLO_API_KEY` | Apollo.io → Settings → API → Manage API Keys |

## Getting Started

### 1. Set Up Supabase

- Create a project at [supabase.com](https://supabase.com).
- Run the SQL commands from the `supabase_schema.md` artifact (or the SQL file in docs/) in your Supabase SQL Editor.
- Copy your project URL, anon key, and service role key to `.env.local`.

### 2. Set Up Trigger.dev

- Create a project at [trigger.dev](https://trigger.dev).
- Copy the Secret API Key to `.env.local`.
- Run `npx trigger.dev@latest dev` to connect local dev to the Trigger.dev dashboard.

### 3. Install & Run

```bash
npm install
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

### 4. Connect Vercel to GitHub

1. Push this repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → Import Project → Select this repository.
3. Add all environment variables from `.env.local` to Vercel's project settings.
4. Deploy — Vercel auto-deploys on every push to `main`.

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) automatically runs on every push and PR to `main`:

1. **`npm run lint`** — ESLint checks
2. **`npm run build`** — Full production build

This ensures broken code never reaches production.

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
```

## License

Proprietary. All rights reserved.
