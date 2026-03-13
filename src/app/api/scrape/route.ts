import { createClient } from "@/lib/supabase/server";
import { scrapeLinkedInPost } from "@/trigger/scrape";
import { runs } from "@trigger.dev/sdk/v3";
import type { PipelineEvent } from "@/lib/pipeline";

// Vercel: hobby = 60s, pro = 300s.
// Heavy work runs inside Trigger.dev (max 600s) — Vercel only polls.
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
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!process.env.TRIGGER_SECRET_KEY) missing.push("TRIGGER_SECRET_KEY");
    if (!process.env.LINKEDIN_EMAIL) missing.push("LINKEDIN_EMAIL");
    if (!process.env.LINKEDIN_PASSWORD) missing.push("LINKEDIN_PASSWORD");
    if (
      !process.env.OPENAI_API_KEY &&
      !process.env.GEMINI_API_KEY &&
      !process.env.GROQ_API_KEY
    ) {
      missing.push("at least one LLM key: GROQ_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY");
    }

    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing env vars: ${missing.join(", ")}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Trigger background task ───────────────────────────────────────
    const handle = await scrapeLinkedInPost.trigger({
      url,
      userId: user.id,
      limit: 20,
    });

    // ── Stream progress via SSE ───────────────────────────────────────
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: PipelineEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        };

        send({ type: "step", message: "⏳ Task queued — starting scraper..." });

        let lastEventCount = 0;
        let stalePollCount = 0;
        const MAX_POLLS = 600; // up to 10 minutes

        // Heartbeat so the browser connection stays alive
        const heartbeat = setInterval(() => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "step", message: "📡 Working..." })}\n\n`
            )
          );
        }, 15000);

        try {
          for (let poll = 0; poll < MAX_POLLS; poll++) {
            await new Promise((r) => setTimeout(r, 1000));

            let run: Awaited<ReturnType<typeof runs.retrieve>>;
            try {
              run = await runs.retrieve(handle.id);
            } catch {
              stalePollCount++;
              if (stalePollCount >= 10) {
                send({
                  type: "error",
                  message:
                    "❌ Could not reach Trigger.dev. Is TRIGGER_SECRET_KEY correct? Run `npx trigger.dev@latest dev` locally.",
                });
                break;
              }
              continue;
            }
            stalePollCount = 0;

            // Drain new events from task metadata
            const allEvents =
              ((run.metadata as Record<string, unknown>)?.events as PipelineEvent[]) || [];
            if (allEvents.length > lastEventCount) {
              allEvents.slice(lastEventCount).forEach(send);
              lastEventCount = allEvents.length;
            }

            // Task finished?
            if (
              run.status === "COMPLETED" ||
              run.status === "FAILED" ||
              run.status === "CRASHED" ||
              run.status === "CANCELED" ||
              run.status === "SYSTEM_FAILURE"
            ) {
              if (run.status !== "COMPLETED") {
                send({
                  type: "error",
                  message: `❌ Task ended with status: ${run.status}`,
                });
              }
              break;
            }
          }
        } finally {
          clearInterval(heartbeat);
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
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
