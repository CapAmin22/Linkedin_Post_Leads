"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ─── Types ────────────────────────────────────────────────────────────

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

const PAGE_SIZE = 25;

// ─── CSV helper ───────────────────────────────────────────────────────

function downloadCsv(rows: Lead[], filename: string) {
  const headers = [
    "Full Name",
    "LinkedIn URL",
    "Job Title",
    "Company",
    "Email",
    "Headline",
    "Source Post URL",
    "Status",
    "Added Date",
  ];

  const escape = (v: string | null) =>
    `"${(v ?? "").replace(/"/g, '""')}"`;

  const lines = rows.map((l) =>
    [
      escape(l.full_name),
      escape(l.linkedin_url),
      escape(l.job_title),
      escape(l.company),
      escape(l.email),
      escape(l.headline),
      escape(l.source_url),
      escape(l.status),
      escape(l.created_at ? new Date(l.created_at).toLocaleDateString() : ""),
    ].join(",")
  );

  // BOM prefix ensures Excel opens with correct encoding
  const csv = "\uFEFF" + [headers.join(","), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Status badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20">
          Enriched
        </Badge>
      );
    case "processing":
      return (
        <Badge variant="default" className="animate-pulse">
          Processing
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="outline">Pending</Badge>;
  }
}

// ─── Stat card ────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card p-4 flex flex-col gap-1">
      <span className="text-2xl font-bold tracking-tight">{value}</span>
      <span className="text-sm font-medium text-foreground">{label}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────

export default function LeadsTable({
  refreshKey,
  latestSourceUrl,
}: {
  refreshKey: number;
  latestSourceUrl?: string | null;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  // ── Resolve authenticated user ────────────────────────────────────

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, [supabase]);

  // ── Auto-select the latest scrape URL when a new scrape completes ──

  useEffect(() => {
    if (latestSourceUrl) {
      setSourceFilter(latestSourceUrl);
      setSearch("");
      setPage(1);
    }
  }, [latestSourceUrl, refreshKey]);

  // ── Fetch leads for the current user only ─────────────────────────

  const fetchLeads = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setPage(1);
    const { data, error } = await supabase
      .from("scraped_leads")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (!error && data) setLeads(data as Lead[]);
    setLoading(false);
  }, [supabase, userId]);

  useEffect(() => {
    let mounted = true;
    if (mounted) {
      fetchLeads();
    }
    return () => { mounted = false; };
  }, [fetchLeads, refreshKey]);

  // ── Derived data ──────────────────────────────────────────────────

  const sourceUrls = useMemo(
    () => [...new Set(leads.map((l) => l.source_url).filter(Boolean))],
    [leads]
  );

  const stats = useMemo(
    () => ({
      total: leads.length,
      withEmail: leads.filter((l) => l.email).length,
      withCompany: leads.filter((l) => l.company).length,
      sources: sourceUrls.length,
    }),
    [leads, sourceUrls]
  );

  const filtered = useMemo(() => {
    let r = leads;
    if (sourceFilter !== "all")
      r = r.filter((l) => l.source_url === sourceFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(
        (l) =>
          (l.full_name ?? "").toLowerCase().includes(q) ||
          (l.company ?? "").toLowerCase().includes(q) ||
          (l.email ?? "").toLowerCase().includes(q) ||
          (l.job_title ?? "").toLowerCase().includes(q)
      );
    }
    return r;
  }, [leads, sourceFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const paginated = useMemo(
    () =>
      filtered.slice(
        (currentPage - 1) * PAGE_SIZE,
        currentPage * PAGE_SIZE
      ),
    [filtered, currentPage]
  );

  // Reset page when filter/search changes
  useEffect(() => setPage(1), [search, sourceFilter]);

  // ── CSV export ────────────────────────────────────────────────────

  const handleExport = () => {
    const rows = filtered.length > 0 ? filtered : leads;
    if (rows.length === 0) return;
    const date = new Date().toISOString().split("T")[0];
    downloadCsv(rows, `leads_${date}.csv`);
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Stats row */}
      {!loading && leads.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Leads" value={stats.total} />
          <StatCard
            label="With Email"
            value={stats.withEmail}
            sub={`${Math.round((stats.withEmail / stats.total) * 100)}% hit rate`}
          />
          <StatCard label="With Company" value={stats.withCompany} />
          <StatCard label="Posts Scraped" value={stats.sources} />
        </div>
      )}

      <Card className="border-border/50 shadow-lg shadow-primary/5">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                {/* Users icon */}
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
                {loading
                  ? "Loading..."
                  : leads.length === 0
                  ? "No leads yet — paste a LinkedIn URL above to get started."
                  : sourceFilter !== "all"
                  ? `Showing ${filtered.length} lead${filtered.length !== 1 ? "s" : ""} from latest scrape`
                  : `${leads.length} lead${leads.length !== 1 ? "s" : ""} total across all scrapes`}
              </CardDescription>
            </div>

            {/* Export button — always visible when leads exist */}
            {leads.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                className="shrink-0 gap-2"
              >
                {/* Download icon */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export CSV
                {filtered.length > 0 && filtered.length < leads.length && (
                  <span className="text-xs text-muted-foreground">
                    ({filtered.length})
                  </span>
                )}
              </Button>
            )}
          </div>

          {/* Search + filter row */}
          {leads.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <div className="relative flex-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <Input
                  placeholder="Search by name, company, email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>

              {sourceUrls.length > 0 && (
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-w-[180px]"
                >
                  <option value="all">All posts ({leads.length})</option>
                  {sourceUrls.map((u) => {
                    const count = leads.filter(
                      (l) => l.source_url === u
                    ).length;
                    const label = u.length > 40 ? "…" + u.slice(-40) : u;
                    return (
                      <option key={u} value={u}>
                        {label} ({count})
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg
                className="animate-spin h-8 w-8 text-muted-foreground"
                viewBox="0 0 24 24"
              >
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
            </div>
          ) : leads.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="rounded-full bg-muted/50 p-5 mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-10 w-10 text-muted-foreground/40"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <p className="font-medium text-muted-foreground">No leads yet</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Paste a LinkedIn post URL above and click Extract.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            /* No search results */
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="font-medium text-muted-foreground">
                No results for &ldquo;{search}&rdquo;
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setSearch("");
                  setSourceFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-border/50 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="font-semibold">Name</TableHead>
                      <TableHead className="font-semibold">LinkedIn</TableHead>
                      <TableHead className="font-semibold text-primary/80">
                        Job Title
                      </TableHead>
                      <TableHead className="font-semibold text-primary/80">
                        Company
                      </TableHead>
                      <TableHead className="font-semibold">Email</TableHead>
                      <TableHead className="font-semibold hidden lg:table-cell">
                        Headline
                      </TableHead>
                      <TableHead className="font-semibold text-center">
                        Status
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((lead) => (
                      <TableRow key={lead.id} className="transition-colors">
                        {/* Name */}
                        <TableCell className="font-medium whitespace-nowrap">
                          {lead.full_name || "—"}
                        </TableCell>

                        {/* LinkedIn */}
                        <TableCell>
                          {lead.linkedin_url ? (
                            <a
                              href={lead.linkedin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:text-primary/80 transition-colors flex items-center gap-1.5 group"
                              title={lead.linkedin_url}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="shrink-0"
                              >
                                <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
                                <rect width="4" height="12" x="2" y="9" />
                                <circle cx="4" cy="4" r="2" />
                              </svg>
                              <span className="text-xs font-mono truncate max-w-[120px] group-hover:underline underline-offset-2">
                                {(() => {
                                  try {
                                    return new URL(lead.linkedin_url).pathname
                                      .replace("/in/", "")
                                      .replace(/\//g, "");
                                  } catch {
                                    return "View";
                                  }
                                })()}
                              </span>
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>

                        {/* Job Title */}
                        <TableCell
                          className="font-medium max-w-[160px] truncate"
                          title={lead.job_title ?? undefined}
                        >
                          {lead.job_title || "—"}
                        </TableCell>

                        {/* Company */}
                        <TableCell
                          className="font-semibold text-primary/90 max-w-[140px] truncate"
                          title={lead.company ?? undefined}
                        >
                          {lead.company || "—"}
                        </TableCell>

                        {/* Email */}
                        <TableCell className="whitespace-nowrap">
                          {lead.email ? (
                            <a
                              href={`mailto:${lead.email}`}
                              className="text-primary hover:underline underline-offset-4 text-sm"
                            >
                              {lead.email}
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-sm">
                              —
                            </span>
                          )}
                        </TableCell>

                        {/* Headline (desktop only) */}
                        <TableCell
                          className="text-muted-foreground text-xs max-w-[200px] truncate italic hidden lg:table-cell"
                          title={lead.headline ?? undefined}
                        >
                          {lead.headline || "—"}
                        </TableCell>

                        {/* Status */}
                        <TableCell className="text-center">
                          <StatusBadge status={lead.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {(currentPage - 1) * PAGE_SIZE + 1}–
                    {Math.min(currentPage * PAGE_SIZE, filtered.length)} of{" "}
                    {filtered.length}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      ← Prev
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      {currentPage} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={currentPage === totalPages}
                    >
                      Next →
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
