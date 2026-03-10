-- Create the scraped_leads table
CREATE TABLE IF NOT EXISTS scraped_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    job_id TEXT, -- Trigger.dev Job ID
    source_url TEXT NOT NULL,
    full_name TEXT,
    linkedin_url TEXT,
    headline TEXT,
    job_title TEXT,
    company TEXT,
    email TEXT,
    status TEXT DEFAULT 'pending' -- pending, completed, failed
);

-- Enable Row Level Security
ALTER TABLE scraped_leads ENABLE ROW LEVEL SECURITY;

-- Create Policies
-- Users can see only their own leads
CREATE POLICY "Users can view their own leads" 
ON scraped_leads FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

-- Users can insert their own leads (though usually the service role does this in the background)
CREATE POLICY "Users can insert their own leads" 
ON scraped_leads FOR INSERT 
TO authenticated 
WITH CHECK (auth.uid() = user_id);

-- ALLOW Service Role to do everything (This is default in Supabase, but added for clarity)
-- The background job uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS anyway.

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_scraped_leads_user_id ON scraped_leads(user_id);
CREATE INDEX IF NOT EXISTS idx_scraped_leads_job_id ON scraped_leads(job_id);
