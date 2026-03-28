import { runs } from "@trigger.dev/sdk/v3";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
      return new Response(JSON.stringify({ error: "Job ID is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Auth ─────────────────────────────────────────────────────────
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Fetch run status from Trigger.dev ────────────────────────────
    const run = await runs.retrieve(jobId);

    if (!run) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Extract progress events from metadata (if any)
    const events = (run.metadata as any)?.events || [];
    const done = (run.metadata as any)?.done || false;

    return new Response(
      JSON.stringify({
        status: run.status, // PENDING, EXECUTING, COMPLETED, FAILED, etc.
        events,
        done: done || run.status === "COMPLETED" || run.status === "FAILED",
        output: run.output,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    return NextResponse.json({ 
      error: "Failed to fetch job status", 
      details: (error as Error)?.message 
    }, { status: 500 });
  }
}
