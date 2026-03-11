"use client";

import { useState, useCallback } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import ScrapeForm from "@/components/ScrapeForm";
import LeadsTable from "@/components/LeadsTable";

export default function DashboardPage() {
  // Increment to force LeadsTable to re-fetch
  const [refreshKey, setRefreshKey] = useState(0);

  const handleComplete = useCallback((leadsProcessed: number) => {
    if (leadsProcessed > 0) {
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

        {/* Scrape form */}
        <ScrapeForm onComplete={handleComplete} />

        {/* Leads table */}
        <LeadsTable refreshKey={refreshKey} />
      </main>
    </div>
  );
}
