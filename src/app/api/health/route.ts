import { NextResponse } from "next/server";

export async function GET() {
  const results: Record<string, { status: string; detail?: string }> = {};

  // 1. Check Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  results.supabase_url = { status: supabaseUrl ? "✅ Set" : "❌ Missing" };
  results.supabase_anon_key = {
    status: supabaseAnonKey?.startsWith("eyJ") ? "✅ Valid JWT" : "❌ Invalid",
    detail: supabaseAnonKey ? `${supabaseAnonKey.slice(0, 20)}...` : "MISSING",
  };
  results.supabase_service_role_key = {
    status: serviceRoleKey?.startsWith("eyJ") ? "✅ Valid JWT" : "❌ Invalid",
    detail: serviceRoleKey ? `${serviceRoleKey.slice(0, 20)}...` : "MISSING",
  };

  // 2. Check Apify
  const apifyToken = process.env.APIFY_API_TOKEN;
  results.apify_token = {
    status: apifyToken && apifyToken.length > 10 ? "✅ Set" : "❌ Missing",
    detail: apifyToken ? `${apifyToken.slice(0, 15)}...` : "MISSING",
  };

  // 3. Check OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  results.openai_key = {
    status: openaiKey && openaiKey.startsWith("sk-") ? "✅ Set" : "❌ Missing or Invalid",
    detail: openaiKey ? `${openaiKey.slice(0, 15)}...` : "MISSING",
  };

  // 4. Check Apollo
  const apolloKey = process.env.APOLLO_API_KEY;
  results.apollo_key = {
    status: apolloKey && apolloKey.length > 5 ? "✅ Set" : "⚠️ Missing (optional)",
  };

  // 5. Check Hunter
  const hunterKey = process.env.HUNTER_API_KEY;
  results.hunter_key = {
    status: hunterKey && hunterKey.length > 10 ? "✅ Set" : "⚠️ Missing (optional)",
  };

  // 6. Quick Supabase connection test
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
    } catch (error: any) {
      results.supabase_connection = {
        status: "❌ Connection failed",
        detail: error?.message,
      };
    }
  }

  // 7. Quick Apify test
  if (apifyToken) {
    try {
      const res = await fetch("https://api.apify.com/v2/acts?limit=1", {
        headers: { Authorization: `Bearer ${apifyToken}` },
      });
      results.apify_connection = {
        status: res.ok ? "✅ Connected" : `❌ HTTP ${res.status} (bad token?)`,
      };
    } catch (error: any) {
      results.apify_connection = {
        status: "❌ Connection failed",
        detail: error?.message,
      };
    }
  }

  return NextResponse.json(results);
}
