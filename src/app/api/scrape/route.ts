import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { scrapeLeadsTask } from "@/trigger/scrape-leads";

export async function POST(request: Request) {
  try {
    // Authenticate the user
    console.log("Authenticating user...");
    const supabase = await createClient();

    // Key Validation Diagnostics
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const triggerKey = process.env.TRIGGER_API_KEY;

    if (!supabaseUrl || !supabaseKey || !triggerKey) {
      console.error("Missing critical environment variables:", { supabaseUrl: !!supabaseUrl, supabaseKey: !!supabaseKey, triggerKey: !!triggerKey });
      return NextResponse.json({ 
        error: "Configuration Error", 
        details: "One or more API keys are missing in the environment. Check your Vercel settings.",
        missing: { supabaseUrl: !supabaseUrl, supabaseKey: !supabaseKey, triggerKey: !triggerKey }
      }, { status: 500 });
    }

    if (supabaseKey && !supabaseKey.startsWith("eyJ")) {
      console.warn("WARNING: NEXT_PUBLIC_SUPABASE_ANON_KEY does not look like a standard Supabase JWT key.");
    }

    if (triggerKey && triggerKey.startsWith("tr_dev_")) {
      console.warn("WARNING: TRIGGER_API_KEY looks like a Public/Dev key. Trigger.dev v3 requires a Secret Key (starting with 'tr_sk_') for server-side triggers.");
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error("Auth error:", authError);
      return NextResponse.json({ 
        error: "Unauthorized", 
        details: "You must be logged in to use this feature. Also, check if your SUPABASE_ANON_KEY is valid.",
        authError: authError?.message 
      }, { status: 401 });
    }
    console.log("User authenticated:", user.id);

    // Validate the request body
    const body = await request.json();
    const { url } = body;
    console.log("Request URL:", url);

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "A LinkedIn URL is required" },
        { status: 400 }
      );
    }

    if (!/^https?:\/\/(www\.)?linkedin\.com\//.test(url)) {
      return NextResponse.json(
        { error: "Please provide a valid LinkedIn URL" },
        { status: 400 }
      );
    }

    // Dispatch the Trigger.dev task
    try {
      if (!triggerKey || !triggerKey.startsWith("tr_sk_")) {
        throw new Error("Invalid TRIGGER_API_KEY. For @trigger.dev/sdk/v3, you must use a Secret Key (starts with 'tr_sk_').");
      }

      console.log("Triggering task 'scrape-leads'...");
      const handle = await tasks.trigger<typeof scrapeLeadsTask>(
        "scrape-leads",
        {
          url,
          userId: user.id,
        }
      );
      console.log("Task triggered successfully, job ID:", handle.id);
      return NextResponse.json({ jobId: handle.id }, { status: 200 });
    } catch (triggerError: any) {
      console.error("Trigger.dev error:", triggerError);
      return NextResponse.json(
        { 
          error: "Failed to start background job", 
          details: triggerError?.message,
          suggestion: "Ensure you are using a Trigger.dev v3 Secret Key (tr_sk_...) and that 'npx trigger.dev@latest dev' is running."
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Scrape API error details:", error);
    return NextResponse.json(
      { 
        error: "Internal server error", 
        details: error?.message, 
        stack: error?.stack,
        name: error?.name
      },
      { status: 500 }
    );
  }
}
