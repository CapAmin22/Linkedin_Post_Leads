"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DebugPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      setStatus({ error: "Failed to fetch health status" });
    }
    setLoading(false);
  };

  useEffect(() => {
    checkStatus();
  }, []);

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">System Debugger</h1>
      <Button onClick={checkStatus} disabled={loading}>
        {loading ? "Checking..." : "Refresh Status"}
      </Button>

      {status && (
        <Card>
          <CardHeader>
            <CardTitle>API & Keys Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="font-bold">Supabase URL:</div>
              <div className="text-muted-foreground">{status.supabase?.url || "Missing"}</div>
              
              <div className="font-bold">Supabase Anon Key:</div>
              <div className={status.supabase?.anonKeyValid ? "text-green-500" : "text-red-500"}>
                {status.supabase?.anonKeyValid ? "✅ Valid JWT" : "❌ Invalid (Swap detected?)"}
              </div>

              <div className="font-bold">Trigger.dev Key:</div>
              <div className={status.trigger?.type === "Secret (Correct)" ? "text-green-500" : "text-red-500"}>
                {status.trigger?.type}
              </div>

              <div className="font-bold">Supabase Auth:</div>
              <div className={status.supabase?.status === "connected" ? "text-green-500" : "text-red-500"}>
                {status.supabase?.status} {status.supabase?.error && `(${status.supabase.error})`}
              </div>
            </div>

            {status.error && (
              <div className="p-4 bg-red-100 text-red-700 rounded-md">
                Critical Error: {status.error}
              </div>
            )}
            
            <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded border border-yellow-200">
              <strong>Instructions:</strong> If any item is red, visit the [Walkthrough](file:///C:/Users/HP/.gemini/antigravity/brain/c6da91e1-c156-442c-97d5-27d3fa0a1b83/walkthrough.md) and update your Vercel Environment Variables.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
