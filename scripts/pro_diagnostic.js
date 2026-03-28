const { createClient } = require('@supabase/supabase-js');
const { ApifyClient } = require('apify-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config({ path: '.env.local' });

async function runDiagnostics() {
  const report = [];
  const log = (msg) => { console.log(msg); report.push(msg); };

  log('=== LEADHARVEST PRO DIAGNOSTICS ===\n');

  // 1. Supabase
  log('[1/6] Testing Supabase...');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseAnonKey?.startsWith('eyJ')) {
    log('  ❌ NEXT_PUBLIC_SUPABASE_ANON_KEY is invalid (it looks like a Trigger.dev key!). Must start with "eyJ".');
  } else {
    try {
      const supabase = createClient(supabaseUrl, supabaseAnonKey);
      const { error } = await supabase.from('scraped_leads').select('id').limit(1);
      if (error && error.code !== 'PGRST116') throw error; // 116 is just "no rows found" if empty
      log('  ✅ Supabase (Anon) connection successful.');
    } catch (e) {
      log('  ❌ Supabase (Anon) test failed: ' + e.message);
    }
  }

  if (supabaseServiceKey === 'YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE') {
    log('  ❌ SUPABASE_SERVICE_ROLE_KEY is still a placeholder.');
  }

  // 2. Trigger.dev
  log('\n[2/6] Testing Trigger.dev...');
  const triggerKey = process.env.TRIGGER_API_KEY;
  if (!triggerKey?.startsWith('tr_sk_')) {
    log(`  ❌ TRIGGER_API_KEY is invalid. Current: ${triggerKey?.substring(0, 7)}...`);
    log('     NOTE: You are using a Dev Public Key (tr_dev_...). Trigger.dev v3 requires a Secret Key (tr_sk_...).');
  } else {
    log('  ✅ TRIGGER_API_KEY format looks correct (tr_sk_...).');
  }

  // 3. Apify
  log('\n[3/6] Testing Apify...');
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken?.startsWith('apify_api_')) {
    log('  ❌ APIFY_API_TOKEN format is incorrect.');
  } else {
    try {
      const apify = new ApifyClient({ token: apifyToken });
      await apify.users().get();
      log('  ✅ Apify connection successful.');
    } catch (e) {
      log('  ❌ Apify connection failed: ' + e.message);
    }
  }

  // 4. Gemini
  log('\n[4/6] Testing Gemini...');
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    log('  ❌ GEMINI_API_KEY is missing.');
  } else {
    try {
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent("Hello");
      if (result.response.text()) log('  ✅ Gemini connection successful.');
    } catch (e) {
      log('  ❌ Gemini connection failed: ' + e.message);
    }
  }

  // 5. Apollo
  log('\n[5/6] Testing Apollo...');
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey) {
    log('  ❌ APOLLO_API_KEY is missing.');
  } else {
    try {
      const res = await fetch("https://api.apollo.io/v1/users/info", {
        headers: { "X-Api-Key": apolloKey }
      });
      if (res.ok) log('  ✅ Apollo connection successful.');
      else log('  ❌ Apollo connection failed: ' + res.status);
    } catch (e) {
      log('  ❌ Apollo test failed: ' + e.message);
    }
  }

  // 6. Hunter
  log('\n[6/6] Testing Hunter...');
  const hunterKey = process.env.HUNTER_API_KEY;
  if (!hunterKey) {
    log('  ❌ HUNTER_API_KEY is missing.');
  } else {
    try {
      const res = await fetch(`https://api.hunter.io/v2/account?api_key=${hunterKey}`);
      if (res.ok) log('  ✅ Hunter connection successful.');
      else log('  ❌ Hunter connection failed: ' + res.status);
    } catch (e) {
      log('  ❌ Hunter test failed: ' + e.message);
    }
  }

  log('\n=== DIAGNOSTICS COMPLETE ===');
}

runDiagnostics();
