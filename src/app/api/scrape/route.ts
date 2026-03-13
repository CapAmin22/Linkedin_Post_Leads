import { createClient } from "@/lib/supabase/server";
import { runPipeline, type PipelineEvent } from "@/lib/pipeline";

// Vercel Pro limit is 300s. Hobby is 60s. 
// The heavy lifting happens in the Python scraper service locally.
export const maxDuration = 300;

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
    const { url } = body as { url?: string };

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

    // ── Check required local env vars ─────────────────────────────────
    // These are checked here to give immediate feedback in the UI
    const missing: string[] = [];
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!process.env.NEXT_PUBLIC_SCRAPER_SERVICE_URL) missing.push("NEXT_PUBLIC_SCRAPER_SERVICE_URL");
    
    if (!process.env.NEXT_PUBLIC_LINKEDIN_EMAIL && !process.env.LINKEDIN_EMAIL) {
      missing.push("LINKEDIN_EMAIL");
    }
    if (!process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD && !process.env.LINKEDIN_PASSWORD) {
      missing.push("LINKEDIN_PASSWORD");
    }
    
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing env vars: ${missing.join(", ")}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Stream progress via SSE ───────────────────────────────────────
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: PipelineEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        };

        // Add a heartbeat to keep the browser connection alive
        const heartbeat = setInterval(() => {
          send({ type: "step", message: "📡 Working..." });
        }, 15000);

        try {
          // Execute the modular pipeline (Python Scraper -> AI Parsing -> DB)
          await runPipeline(url, user.id, send);
        } catch (error: any) {
          send({
            type: "error",
            message: `❌ Pipeline error: ${error?.message || "Unknown error"}`,
          });
        } finally {
          clearInterval(heartbeat);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error("Scrape API error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error?.message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
