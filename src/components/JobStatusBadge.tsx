"use client";

import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";

interface JobStatusBadgeProps {
  jobId: string | null;
}

type JobStatus =
  | "QUEUED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "REATTEMPTING"
  | "FROZEN"
  | "SYSTEM_FAILURE";

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  QUEUED: { label: "Queued", variant: "outline" },
  EXECUTING: { label: "Processing", variant: "default" },
  COMPLETED: { label: "Completed", variant: "secondary" },
  FAILED: { label: "Failed", variant: "destructive" },
  CANCELED: { label: "Canceled", variant: "outline" },
  REATTEMPTING: { label: "Retrying", variant: "default" },
  FROZEN: { label: "Frozen", variant: "outline" },
  SYSTEM_FAILURE: { label: "System Error", variant: "destructive" },
};

export default function JobStatusBadge({ jobId }: JobStatusBadgeProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);

  useEffect(() => {
    if (!jobId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus(null);
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/job-status?jobId=${jobId}`);
        const data = await res.json();
        if (data.status) {
          setStatus(data.status);
          // Stop polling on terminal states
          if (["COMPLETED", "FAILED", "CANCELED", "SYSTEM_FAILURE"].includes(data.status)) {
            clearInterval(interval);
          }
        }
      } catch {
        // Silently handle poll errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [jobId]);

  if (!jobId || !status) return null;

  const isTerminal = ["COMPLETED", "FAILED", "CANCELED", "SYSTEM_FAILURE"].includes(status);
  const polling = !isTerminal;

  const config = statusConfig[status] || {
    label: status,
    variant: "outline" as const,
  };

  return (
    <div className="flex items-center gap-2">
      {polling && (
        <div className="h-2 w-2 rounded-full bg-chart-1 animate-pulse" />
      )}
      <Badge variant={config.variant} className="text-xs font-medium">
        {config.label}
      </Badge>
    </div>
  );
}
