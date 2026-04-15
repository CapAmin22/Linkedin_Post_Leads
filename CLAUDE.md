# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Working directory**: The actual Next.js project lives in `Linkedin_Post_Leads/`. All commands below should be run from that directory.

## Commands

```bash
# Install dependencies
npm install

# Development (Next.js on port 3000)
npm run dev

# PinchTab browser-automation service (required for scraping; default http://localhost:9867)
# Must be running before Trigger.dev can execute the scrape task.

# Trigger.dev background task runner (required alongside npm run dev for local scraping)
npx trigger.dev@latest dev

# Production build
npm run build

# Linting
npm run lint
```

No test suite is configured. CI runs `npm run lint` + `npm run build`.

## Architecture

**LeadHarvest** extracts and enriches leads from LinkedIn post engagements. The core flow:

1. User submits a LinkedIn post URL via `ScrapeForm`
2. `/api/scrape` dispatches a Trigger.dev background job and returns a `jobId`
3. `ScrapeForm` polls `/api/job-status` every 8s for up to 10 minutes
4. The Trigger.dev task (`src/trigger/scrape.ts`) orchestrates:
   - Browser automation via the **PinchTab HTTP API** (`PinchTabAPI` class at the top of the file) — opens a named profile (`leadharvest`) via `POST /instances/start`, drives tabs with `/tabs/{id}/eval` and `/tabs/{id}/action`, and persists the LinkedIn session across runs. Configured via `PINCHTAB_URL` (defaults to `http://localhost:9867`).
   - LinkedIn login → scrape post reactions modal → deep-dive each profile page
   - AI parsing waterfall: **Groq** (llama-3.3-70b) → **Gemini 2.0 Flash** → **OpenAI gpt-4o-mini** → regex fallback
   - Writes enriched leads to Supabase `scraped_leads` table via service role (bypasses RLS)
   - Emits progress events via Trigger.dev task metadata
5. `LeadsTable` fetches leads from Supabase (RLS restricts to the authenticated user's rows)

## Key Files

| File | Role |
|------|------|
| `src/trigger/scrape.ts` | Core background task: browser automation + AI parsing + DB writes |
| `src/lib/pipeline.ts` | Shared AI parsing logic: `runAIParsing()` waterfall, `normalizeProfiles()`, regex fallback |
| `src/app/api/scrape/route.ts` | Dispatches Trigger.dev job, returns `jobId` |
| `src/app/api/job-status/route.ts` | Polls Trigger.dev run by `jobId`, returns progress events |
| `src/components/ScrapeForm.tsx` | UI orchestration: form → polling loop → progress display |
| `src/components/LeadsTable.tsx` | Paginated leads table with CSV export (BOM prefix for Excel) |
| `src/lib/supabase/client.ts` | Browser Supabase client (anon key) |
| `src/lib/supabase/server.ts` | Server Supabase client (service role) |
| `src/middleware.ts` | Next.js middleware entry point — calls the auth guard |
| `src/lib/supabase/middleware.ts` | Auth guard logic: redirects unauthenticated users from `/dashboard` to `/login` |
| `schema.sql` | Supabase table definition + Row-Level Security policies |
| `trigger.config.ts` | Trigger.dev project config (600s max duration) |

## Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DB_PASSWORD
DATABASE_URL

# Trigger.dev
TRIGGER_SECRET_KEY

# PinchTab (browser automation service)
PINCHTAB_URL  # defaults to http://localhost:9867

# AI APIs (waterfall: Groq → Gemini → OpenAI → regex)
GROQ_API_KEY
GEMINI_API_KEY
OPENAI_API_KEY

# LinkedIn credentials for the scraper (burner account)
NEXT_PUBLIC_LINKEDIN_EMAIL
NEXT_PUBLIC_LINKEDIN_PASSWORD

# Optional enrichment APIs
APIFY_API_TOKEN
APOLLO_API_KEY
HUNTER_API_KEY
```

## Tech Stack

- **Next.js 16** (App Router, React 19, TypeScript strict mode)
- **Tailwind CSS v4** + **shadcn/ui** (style: `base-nova`)
- **PinchTab HTTP API** — external browser-automation service driven over HTTP; not an npm dependency, runs separately at :9867
- **Trigger.dev v4** (`@trigger.dev/sdk` 4.x) — background jobs, bypasses Vercel's function timeout. `trigger.config.ts` uses the `@trigger.dev/sdk/v3` compat import path.
- **Supabase** — PostgreSQL + Auth + Row-Level Security (users see only their own leads)

## Database Schema

Central table: `scraped_leads` (defined in `schema.sql`)

| Column | Notes |
|--------|-------|
| `id` | UUID PK |
| `user_id` | FK → `auth.users`, enforced by RLS |
| `job_id` | Trigger.dev run ID |
| `source_url` | LinkedIn post URL |
| `full_name`, `linkedin_url`, `headline` | Scraped raw |
| `job_title`, `company` | AI-parsed from `headline` |
| `email` | Enriched business email |
| `status` | `pending` / `completed` / `failed` |

## Important Constraints

- The `scraper/` directory contains a legacy Python FastAPI service that has been superseded by the PinchTab-based approach in `src/trigger/scrape.ts`. Do not extend it.
- The PinchTab service must be running locally (or reachable at `PINCHTAB_URL`) for the scrape task to succeed; otherwise `PinchTabAPI` calls fail immediately.
- Trigger.dev tasks run in a separate process — they cannot import Next.js server utilities directly; use the service role Supabase client from `src/lib/supabase/server.ts`.
- Background tasks write to Supabase using the **service role** (to bypass RLS). The Next.js API routes and components use the **anon key** (subject to RLS).
- `NEXT_PUBLIC_LINKEDIN_EMAIL` / `NEXT_PUBLIC_LINKEDIN_PASSWORD` are exposed to the browser bundle — these are burner credentials for the scraper account, not user credentials.
