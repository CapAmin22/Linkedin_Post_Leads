"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import DashboardHeader from "@/components/DashboardHeader";
import ScrapeForm from "@/components/ScrapeForm";
import LeadsTable from "@/components/LeadsTable";

export default function DashboardPage() {
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastSourceUrl, setLastSourceUrl] = useState<string | null>(null);
  const supabase = useMemo(() => createClient(), []);

  // On mount, check if user has previous leads and show the latest batch
  useEffect(() => {
    async function loadLatest() {
      const { data } = await supabase
        .from("scraped_leads")
        .select("source_url")
        .order("created_at", { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        setLastSourceUrl(data[0].source_url);
      }
    }
    loadLatest();
  }, [supabase]);

  const handleComplete = useCallback(
    (leadsProcessed: number, url: string) => {
      if (leadsProcessed > 0) {
        setActiveUrl(url);
        setLastSourceUrl(url);
        setRefreshKey((k) => k + 1);
      }
    },
    []
  );

  const displayUrl = activeUrl || lastSourceUrl;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground">
            Extract leads from LinkedIn post reactions — names, titles,
            companies, and company pages.
          </p>
        </div>

        <ScrapeForm onComplete={handleComplete} />

        {displayUrl && (
          <LeadsTable refreshKey={refreshKey} sourceUrl={displayUrl} />
        )}
      </main>
    </div>
  );
}
