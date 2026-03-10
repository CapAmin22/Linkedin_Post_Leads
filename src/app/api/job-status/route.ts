import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runs } from "@trigger.dev/sdk/v3";

export async function GET(request: Request) {
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

    // Get the job ID from query params
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId query parameter is required" },
        { status: 400 }
      );
    }

    // Retrieve the run status from Trigger.dev
    const run = await runs.retrieve(jobId);

    return NextResponse.json(
      {
        status: run.status,
        taskIdentifier: run.taskIdentifier,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Job status API error:", error);
    return NextResponse.json(
      { error: "Failed to retrieve job status" },
      { status: 500 }
    );
  }
}
