import { NextResponse } from "next/server";

export async function GET() {
  const results: Record<string, { status: string; detail?: string }> = {};

  // 1. Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  results.supabase_url = { status: supabaseUrl ? "Set" : "Missing" };
  results.supabase_anon_key = {
    status: supabaseAnonKey?.startsWith("eyJ") ? "Valid JWT" : "Invalid",
  };
  results.supabase_service_role_key = {
    status: serviceRoleKey?.startsWith("eyJ") ? "Valid JWT" : "Invalid",
  };

  // 2. LinkedIn credentials
  const linkedinEmail = process.env.LINKEDIN_EMAIL;
  const linkedinPassword = process.env.LINKEDIN_PASSWORD;
  results.linkedin_credentials = {
    status: linkedinEmail && linkedinPassword ? "Set" : "Missing",
  };

  // 3. AI keys (free tier)
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  results.groq_key = {
    status: groqKey && groqKey.startsWith("gsk_") ? "Set" : "Missing",
  };
  results.gemini_key = {
    status: geminiKey && geminiKey.startsWith("AIza") ? "Set" : "Missing",
  };

  const activeKeys = [
    groqKey ? "Groq" : null,
    geminiKey ? "Gemini" : null,
  ].filter(Boolean);

  results.ai_strategy = {
    status:
      activeKeys.length > 0
        ? `Active: ${activeKeys.join(" -> ")} -> Regex`
        : "No AI key set — will use regex fallback only",
  };

  // 4. Quick Supabase connection test
  if (supabaseUrl && supabaseAnonKey?.startsWith("eyJ")) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/scraped_leads?select=count&limit=1`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
        }
      );
      results.supabase_connection = {
        status: res.ok ? "Connected" : `HTTP ${res.status}`,
        detail: res.ok ? "Table accessible" : await res.text(),
      };
    } catch (error: unknown) {
      results.supabase_connection = {
        status: "Connection failed",
        detail: (error as Error)?.message,
      };
    }
  }

  return NextResponse.json(results);
}
