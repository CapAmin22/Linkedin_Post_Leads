"use client";

import { useState } from "react";
import DashboardHeader from "@/components/DashboardHeader";
import ScrapeForm from "@/components/ScrapeForm";
import LeadsTable from "@/components/LeadsTable";
import JobStatusBadge from "@/components/JobStatusBadge";

export default function DashboardPage() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Stats overview */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground">
              Extract and enrich leads from LinkedIn post engagement.
            </p>
          </div>
          <JobStatusBadge jobId={activeJobId} />
        </div>

        {/* Scrape form */}
        <ScrapeForm onJobStarted={(jobId) => setActiveJobId(jobId)} />

        {/* Leads table */}
        <LeadsTable activeJobId={activeJobId} />
      </main>
    </div>
  );
}
