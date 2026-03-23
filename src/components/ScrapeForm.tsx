"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface PipelineEvent {
  type: "step" | "error" | "done";
  message: string;
  data?: Record<string, unknown>;
}

interface ScrapeFormProps {
  onComplete: (leadsProcessed: number, url: string) => void;
}

export default function ScrapeForm({ onComplete }: ScrapeFormProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<PipelineEvent[]>([]);

  const isValidLinkedInUrl = (u: string) =>
    /^https?:\/\/(www\.)?linkedin\.com\//.test(u);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSteps([]);

    if (!isValidLinkedInUrl(url)) {
      setError("Please enter a valid LinkedIn URL");
      return;
    }

    setLoading(true);
    setSteps([{ type: "step", message: "⏳ Starting pipeline..." }]);

    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      // If the response is not a stream (error before streaming started)
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        throw new Error(data.error || data.details || "Failed to start pipeline");
      }

      if (!res.body) {
        throw new Error("No response stream received");
      }

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let leadsProcessed = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; 

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;

            try {
              const event: PipelineEvent = JSON.parse(payload);
              
              // Handle working/heartbeat messages: only keep the newest one
              if (event.message.includes("Working") || event.message.includes("Heartbeat")) {
                  setSteps((prev) => {
                      const filtered = prev.filter(s => !s.message.includes("Working") && !s.message.includes("Heartbeat"));
                      return [...filtered, event];
                  });
              } else {
                  setSteps((prev) => [...prev, event]);
              }

              if (event.type === "error") {
                setError(event.message);
              }

              if (event.type === "done" && event.data?.leadsProcessed) {
                leadsProcessed = event.data.leadsProcessed as number;
              }
            } catch {
              // Skip malformed SSE data
            }
          }
        }
      }

      if (leadsProcessed > 0) {
        onComplete(leadsProcessed, url);
        setUrl("");
      }
    } catch (err: any) {
      const isTimeout = err.name === "AbortError" || err.message?.includes("body stream");
      const errorMessage = isTimeout ? "Connection timed out (Vercel limit). Try a smaller post or check your internet." : (err instanceof Error ? err.message : "Something went wrong");
      
      setError(errorMessage);
      setSteps((prev) => [
        ...prev,
        { type: "error", message: `❌ ${errorMessage}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const getStepColor = (type: string) => {
    switch (type) {
      case "error":
        return "text-red-400";
      case "done":
        return "text-emerald-400 font-medium";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <Card className="border-border/50 shadow-lg shadow-primary/5 overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-primary via-chart-3 to-chart-1" />
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 text-primary"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Extract Leads
        </CardTitle>
        <CardDescription>
          Paste a LinkedIn post URL to extract every reactor with their title,
          company, and company LinkedIn page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex gap-3">
          <div className="flex-1">
            <Input
              id="linkedin-url"
              type="url"
              placeholder="https://www.linkedin.com/posts/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              className="h-11"
              disabled={loading}
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="h-11 px-6 font-medium cursor-pointer shadow-md shadow-primary/20"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Extracting...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                >
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
                Extract
              </span>
            )}
          </Button>
        </form>

        {/* Real-time pipeline progress */}
        {steps.length > 0 && (
          <div className="mt-4 rounded-lg bg-muted/30 border border-border/50 p-4 space-y-1.5 max-h-64 overflow-y-auto">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Pipeline Progress
            </div>
            {steps.map((step, i) => (
              <div
                key={i}
                className={`text-sm font-mono leading-relaxed ${getStepColor(step.type)}`}
              >
                {step.message}
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                Running...
              </div>
            )}
          </div>
        )}

        {/* Error summary (only if NOT already in steps) */}
        {error && steps.length === 0 && (
          <div className="mt-3 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
