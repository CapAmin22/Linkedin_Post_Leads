import { createClient } from "@/lib/supabase/server";
import { scrapeLinkedInPost } from "@/lib/scraper";
import type { PipelineEvent } from "@/lib/pipeline";

// For self-hosted / local: no strict time limit.
// For Vercel hobby: 60s, pro: 300s. Consider self-hosting for large posts.
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

    // ── Check required env vars ───────────────────────────────────────
    const missing: string[] = [];
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
      missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!process.env.LINKEDIN_EMAIL) missing.push("LINKEDIN_EMAIL");
    if (!process.env.LINKEDIN_PASSWORD) missing.push("LINKEDIN_PASSWORD");
    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
      missing.push(
        "at least one free LLM key: GROQ_API_KEY or GEMINI_API_KEY"
      );
    }

    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing env vars: ${missing.join(", ")}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Direct execution with SSE streaming ─────────────────────────
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: PipelineEvent) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          } catch {
            // Controller may be closed if client disconnected
          }
        };

        try {
          const scraper = scrapeLinkedInPost({ url, userId: user.id });
          for await (const event of scraper) {
            send(event);
          }
        } catch (err: unknown) {
          send({
            type: "error",
            message: `Scraping failed: ${(err as Error)?.message || "Unknown error"}`,
          });
        }

        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // Already closed
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
