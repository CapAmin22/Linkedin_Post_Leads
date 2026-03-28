"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DebugPage() {
  const [status, setStatus] = useState<Record<string, { status: string; detail?: string }> | null>(null);
  const [loading, setLoading] = useState(true);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setStatus(data as Record<string, { status: string; detail?: string }>);
    } catch (error: unknown) {
      setStatus({ 
        error: { 
          status: "failed", 
          detail: error instanceof Error ? error.message : "Failed to fetch health status" 
        } 
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    let mounted = true;
    if (mounted) {
      checkStatus();
    }
    return () => { mounted = false; };
  }, []);

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">System Status</h1>
        <Button onClick={checkStatus} disabled={loading} variant="outline">
          {loading ? "Checking..." : "Refresh Status"}
        </Button>
      </div>

      {status && (
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle>API & Keys Connection Report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 gap-4">
              {Object.entries(status).map(([key, val]: [string, { status: string; detail?: string }]) => (
                <div key={key} className="flex items-center justify-between border-b pb-2 border-border/20 last:border-0 hover:bg-muted/30 px-2 py-1 rounded transition-colors">
                  <div className="font-medium text-sm capitalize">{key.replace(/_/g, ' ')}</div>
                  <div className="flex flex-col items-end">
                    <div className="text-sm font-semibold">{val.status}</div>
                    {val.detail && <div className="text-[10px] text-muted-foreground font-mono">{val.detail}</div>}
                  </div>
                </div>
              ))}
            </div>

            {status.error && (
              <div className="p-4 bg-red-100 text-red-700 rounded-md text-sm">
                Critical Error: {status.error.detail || status.error.status}
              </div>
            )}
            
            <div className="text-xs bg-muted/50 p-4 rounded-lg border border-border/50 space-y-2">
              <p className="font-semibold text-primary">Troubleshooting Tips:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>If **Supabase Connection** is red, check your `NEXT_PUBLIC_` keys.</li>
                <li>If **Scraper Connection** is red, run `python -m uvicorn main:app` in the /scraper folder.</li>
                <li>Ensure you have confirmed the user email in the Supabase Dashboard.</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
