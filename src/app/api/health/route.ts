import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const status: any = {
    supabase: { status: "unchecked", url: process.env.NEXT_PUBLIC_SUPABASE_URL },
    trigger: { status: "unchecked", keyFormat: "unknown" },
    gemini: { status: "unchecked" },
    apify: { status: "unchecked" },
  };

  try {
    // 1. Check Supabase Keys
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    
    status.supabase.anonKeyValid = anonKey.startsWith("eyJ");
    status.supabase.serviceKeySet = serviceKey !== "YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE" && serviceKey.length > 20;
    
    // 2. Check Trigger Key
    const triggerKey = process.env.TRIGGER_SECRET_KEY || "";
    status.trigger.type = triggerKey.startsWith("tr_dev_") ? "Dev Secret (OK for local)" : triggerKey.startsWith("tr_prod_") ? "Prod Secret (Correct)" : "Invalid";
    
    // 3. Test Supabase Connection
    const supabase = await createClient();
    const { error: authError } = await supabase.auth.getSession();
    status.supabase.status = authError ? "error" : "connected";
    status.supabase.error = authError?.message;

    return NextResponse.json(status);
  } catch (error: any) {
    return NextResponse.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}
