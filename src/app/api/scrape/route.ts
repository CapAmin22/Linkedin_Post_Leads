import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk/v3";
import type { scrapeLeadsTask } from "@/trigger/scrape-leads";

export async function POST(request: Request) {
  try {
    // Authenticate the user
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    // Dispatch the Trigger.dev task
    const handle = await tasks.trigger<typeof scrapeLeadsTask>(
      "scrape-leads",
      {
        url,
        userId: user.id,
      }
    );

    return NextResponse.json({ jobId: handle.id }, { status: 200 });
  } catch (error) {
    console.error("Scrape API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
