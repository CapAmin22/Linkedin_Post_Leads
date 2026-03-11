import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runPipeline } from "@/lib/pipeline";

export const maxDuration = 60; // Vercel function timeout (seconds)

export async function POST(request: Request) {
  try {
    // Authenticate the user
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized", details: authError?.message },
        { status: 401 }
      );
    }

    // Validate the request body
    const body = await request.json();
    const { url } = body;

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

    // Run the pipeline directly (no Trigger.dev)
    const result = await runPipeline(url, user.id);

    if (!result.success) {
      return NextResponse.json(
        { error: "Pipeline failed", details: result.error, steps: result.steps },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        leadsProcessed: result.leadsProcessed,
        steps: result.steps,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Scrape API error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: error?.message },
      { status: 500 }
    );
  }
}
