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

interface ScrapeFormProps {
  onComplete: (leadsProcessed: number) => void;
}

export default function ScrapeForm({ onComplete }: ScrapeFormProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  const isValidLinkedInUrl = (url: string) => {
    return /^https?:\/\/(www\.)?linkedin\.com\//.test(url);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusText(null);

    if (!isValidLinkedInUrl(url)) {
      setError("Please enter a valid LinkedIn URL");
      return;
    }

    setLoading(true);
    setStatusText("Extracting leads... this takes 15-30 seconds");

    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.details || "Failed to extract leads");
      }

      setStatusText(`Done! ${data.leadsProcessed} leads extracted.`);
      onComplete(data.leadsProcessed);
      setUrl("");

      // Clear success message after 5s
      setTimeout(() => setStatusText(null), 5000);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "Something went wrong";
      setError(errorMessage);
      setStatusText(null);
    } finally {
      setLoading(false);
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
          Paste a LinkedIn post URL to extract, parse, and enrich every person
          who engaged with it.
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

        {/* Status / progress text */}
        {statusText && !error && (
          <div className="mt-3 rounded-lg bg-primary/10 border border-primary/20 p-3 text-sm text-primary flex items-center gap-2">
            {loading && (
              <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {statusText}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
