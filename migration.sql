-- Migration: Add company_linkedin_url and location columns, remove job_id
-- Run this on existing Supabase databases

ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT;
ALTER TABLE scraped_leads ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE scraped_leads DROP COLUMN IF EXISTS job_id;
DROP INDEX IF EXISTS idx_scraped_leads_job_id;
