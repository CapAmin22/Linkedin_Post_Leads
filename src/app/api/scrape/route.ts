import { createClient } from "@/lib/supabase/server";
import { tasks } from "@trigger.dev/sdk/v3";
// Import the task ID but note we dispatch via ID string for better isolation
// export { scrapeLinkedInPost } from "@/trigger/scrape";

export async function POST(request: Request) {
  try {
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
    // This allows the task to run for up to 10 mins without Vercel timeouts
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
    console.error("Scrape API error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: (error as Error)?.message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
