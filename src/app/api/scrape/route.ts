import { createClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk/v3";

export async function POST(request: Request) {
  try {
    // ── Pre-flight: verify required environment variables ─────────────
    if (!process.env.TRIGGER_SECRET_KEY) {
      console.error("Scrape API: TRIGGER_SECRET_KEY is not set");
      return new Response(
        JSON.stringify({
          error: "Server configuration error",
          details:
            "TRIGGER_SECRET_KEY is not configured. Please add it to your environment variables.",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Auth ─────────────────────────────────────────────────────────
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", details: authError?.message }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Validate input ────────────────────────────────────────────────
    const body = await request.json();
    const { url, limit = 20 } = body as { url?: string; limit?: number };

    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "A LinkedIn URL is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!/^https?:\/\/(www\.)?linkedin\.com\//.test(url)) {
      return new Response(
        JSON.stringify({ error: "Please provide a valid LinkedIn URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Dispatch Trigger.dev task ─────────────────────────────────────
    // The background task runs for up to 10 mins without Vercel timeouts.
    // Requires: TRIGGER_SECRET_KEY + the task deployed via `npx trigger.dev deploy`
    const handle = await tasks.trigger("scrape-linkedin-post", {
      url,
      userId: user.id,
      limit,
    });

    return new Response(
      JSON.stringify({
        jobId: handle.id,
        message: "Pipeline started successfully",
      }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const msg = (error as Error)?.message || "Unknown error";
    console.error("Scrape API error:", msg);

    // Give actionable hints for the most common failure modes
    let details = msg;
    if (msg.includes("TRIGGER_SECRET_KEY") || msg.toLowerCase().includes("unauthorized")) {
      details =
        "Trigger.dev authentication failed. Make sure TRIGGER_SECRET_KEY is set and the task is deployed (`npx trigger.dev@latest deploy`).";
    } else if (msg.includes("fetch") || msg.includes("ECONNREFUSED")) {
      details = "Cannot reach Trigger.dev API. Check network connectivity and TRIGGER_SECRET_KEY.";
    }

    return new Response(
      JSON.stringify({ error: "Failed to start pipeline", details }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
