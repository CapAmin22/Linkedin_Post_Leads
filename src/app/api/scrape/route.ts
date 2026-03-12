import { createClient } from "@/lib/supabase/server";
import { runPipeline, type PipelineEvent } from "@/lib/pipeline";

export const maxDuration = 60; // Vercel function timeout

export async function POST(request: Request) {
  try {
    // Authenticate
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

    // Validate URL
    const body = await request.json();
    const { url } = body;

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

    // Stream pipeline events via SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: PipelineEvent) => {
          const data = JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        // Add a heartbeat to keep the connection alive
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(`data: {"type":"step","message":"📡 Heartbeat: Processing..."}\n\n`));
        }, 10000);

        try {
          await runPipeline(url, user.id, sendEvent);
        } catch (error: any) {
          sendEvent({
            type: "error",
            message: `❌ Unexpected error: ${error?.message || "Unknown error"}`,
          });
        } finally {
          clearInterval(heartbeat);
        }

        // Signal end of stream
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
  } catch (error: any) {
    console.error("Scrape API error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error?.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
