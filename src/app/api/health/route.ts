import { NextResponse } from "next/server";

export async function GET() {
  const results: Record<string, { status: string; detail?: string }> = {};

  // 1. Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  results.supabase_url = { status: supabaseUrl ? "✅ Set" : "❌ Missing" };
  results.supabase_anon_key = {
    status: supabaseAnonKey?.startsWith("eyJ") ? "✅ Valid JWT" : "❌ Invalid",
  };
  results.supabase_service_role_key = {
    status: serviceRoleKey?.startsWith("eyJ") ? "✅ Valid JWT" : "❌ Invalid",
  };

  // 2. Groq
  const groqKey = process.env.GROQ_API_KEY;
  results.groq_key = {
    status: groqKey && groqKey.startsWith("gsk_") ? "✅ Set" : "⚠️ Missing",
  };

  // 4. OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  results.openai_key = {
    status: openaiKey && openaiKey.startsWith("sk-") ? "✅ Set" : "⚠️ Missing",
  };

  // 5. Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  results.gemini_key = {
    status: geminiKey && geminiKey.startsWith("AIza") ? "✅ Set" : "⚠️ Missing",
  };

  // AI status
  const activeKeys = [
    groqKey ? "Groq" : null,
    geminiKey ? "Gemini" : null,
    openaiKey ? "OpenAI" : null,
  ].filter(Boolean);

  results.ai_strategy = {
    status: activeKeys.length > 0 
      ? `✅ Active Chain: ${activeKeys.join(" → ")}`
      : "❌ No AI key set!",
  };

  // 5. Trigger.dev (background task runner)
  const triggerKey = process.env.TRIGGER_SECRET_KEY;
  results.trigger_dev = {
    status: triggerKey ? "✅ Set" : "❌ Missing (required for background scraping jobs)",
  };

  // 6. LinkedIn scraper credentials
  // Support both NEXT_PUBLIC_ prefix (used by Trigger.dev task) and plain variant as fallback
  const linkedinEmail =
    process.env.NEXT_PUBLIC_LINKEDIN_EMAIL || process.env.LINKEDIN_EMAIL;
  const linkedinPassword =
    process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD || process.env.LINKEDIN_PASSWORD;

  results.scraper_credentials = {
    status: linkedinEmail && linkedinPassword ? "✅ Set" : "❌ Missing",
  };

  // 9. Quick Supabase connection test
  if (supabaseUrl && supabaseAnonKey?.startsWith("eyJ")) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/scraped_leads?select=count&limit=1`, {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
      });
      results.supabase_connection = {
        status: res.ok ? "✅ Connected" : `❌ HTTP ${res.status}`,
        detail: res.ok ? "Table accessible" : await res.text(),
      };
    } catch (error: unknown) {
      results.supabase_connection = {
        status: "❌ Connection failed",
        detail: (error as Error)?.message,
      };
    }
  }

  return NextResponse.json(results);
}
