"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Lead {
  id: string;
  full_name: string | null;
  linkedin_url: string | null;
  headline: string | null;
  job_title: string | null;
  company: string | null;
  email: string | null;
  status: string;
  source_url: string;
  created_at: string;
}

interface LeadsTableProps {
  activeJobId: string | null;
}

export default function LeadsTable({ activeJobId }: LeadsTableProps) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  const fetchLeads = useCallback(async () => {
    const { data, error } = await supabase
      .from("scraped_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (!error && data) {
      setLeads(data);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // Poll for new leads while a job is active
  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(fetchLeads, 5000);
    return () => clearInterval(interval);
  }, [activeJobId, fetchLeads]);

  const statusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Enriched</Badge>;
      case "processing":
        return <Badge variant="default" className="animate-pulse">Processing</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="outline">Pending</Badge>;
    }
  };

  return (
    <Card className="border-border/50 shadow-lg shadow-primary/5">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
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
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Extracted Leads
            </CardTitle>
            <CardDescription>
              {leads.length === 0
                ? "No leads yet — paste a LinkedIn URL above to get started."
                : `${leads.length} lead${leads.length !== 1 ? "s" : ""} found`}
            </CardDescription>
          </div>
          {activeJobId && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-2 w-2 rounded-full bg-chart-1 animate-pulse" />
              Live updating
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <svg className="animate-spin h-8 w-8 text-muted-foreground" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : leads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted/50 p-4 mb-4">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-8 w-8 text-muted-foreground/50"
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
              </svg>
            </div>
            <p className="text-sm text-muted-foreground">
              Your enriched leads will appear here
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-semibold">Name</TableHead>
                  <TableHead className="font-semibold">Job Title</TableHead>
                  <TableHead className="font-semibold">Company</TableHead>
                  <TableHead className="font-semibold">Email</TableHead>
                  <TableHead className="font-semibold text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <TableRow key={lead.id} className="transition-colors">
                    <TableCell className="font-medium">
                      {lead.linkedin_url ? (
                        <a
                          href={lead.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline underline-offset-4"
                        >
                          {lead.full_name || "—"}
                        </a>
                      ) : (
                        lead.full_name || "—"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lead.job_title || lead.headline || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {lead.company || "—"}
                    </TableCell>
                    <TableCell>
                      {lead.email ? (
                        <a
                          href={`mailto:${lead.email}`}
                          className="text-primary hover:underline underline-offset-4 text-sm"
                        >
                          {lead.email}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {statusBadge(lead.status)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
