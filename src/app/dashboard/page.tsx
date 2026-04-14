"use client";

import { useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import ScrapeForm from "@/components/ScrapeForm";
import LeadsTable from "@/components/LeadsTable";

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  // Track the source URL of the most recently completed scrape
  const [latestSourceUrl, setLatestSourceUrl] = useState<string | null>(null);

  // Called when a scrape completes — store URL and re-fetch leads
  const handleComplete = useCallback((leadsProcessed: number, url: string) => {
    if (leadsProcessed > 0) {
      setLatestSourceUrl(url);
      setRefreshKey((k) => k + 1);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground">
            Extract and enrich leads from LinkedIn post engagement.
          </p>
        </div>

        {/* Scrape form — always visible */}
        <ScrapeForm onComplete={handleComplete} />

        {/* Leads table — shows the latest scrape by default, all history accessible via dropdown */}
        <LeadsTable refreshKey={refreshKey} latestSourceUrl={latestSourceUrl} />
      </main>
    </div>
  );
}
