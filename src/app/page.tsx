import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-background selection:bg-primary/30 relative overflow-hidden">
      {/* Dynamic Background Elements */}
      <div className="absolute top-0 left-0 right-0 h-[500px] bg-gradient-to-b from-primary/10 via-background to-transparent pointer-events-none" />
      <div className="absolute -top-24 -right-24 h-[500px] w-[500px] rounded-full bg-primary/20 blur-[120px] animate-pulse pointer-events-none" />
      <div className="absolute top-1/2 -left-24 h-[400px] w-[400px] rounded-full bg-chart-3/15 blur-[100px] pointer-events-none" />

      {/* Navbar Container */}
      <header className="relative z-50 px-6 py-4 flex items-center justify-between border-b border-white/5 backdrop-blur-md sticky top-0 bg-background/50">
        <div className="flex items-center gap-2.5 group cursor-default">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-chart-3 shadow-lg shadow-primary/20 transition-transform group-hover:scale-110">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </div>
          <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
            LeadHarvest
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
            Sign In
          </Link>
          <Link href="/signup">
            <Button variant="secondary" size="sm" className="font-semibold shadow-sm hover:translate-y-[-1px] transition-all">
              Sign Up Free
            </Button>
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex flex-col items-center pt-16 sm:pt-24 px-6 pb-24">
        {/* Hero Section */}
        <section className="text-center max-w-4xl space-y-10 mb-24">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-semibold animate-fade-in">
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            V2 Now with Playwright Deep Scrape
          </div>

          <div className="space-y-6">
            <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight leading-[1.1] sm:leading-[1.1]">
              Automate Your
              <br />
              <span className="bg-gradient-to-r from-primary via-chart-4 to-chart-1 bg-clip-text text-transparent">
                LinkedIn Prospecting
              </span>
            </h1>
            <p className="text-lg sm:text-2xl text-muted-foreground max-w-2xl mx-auto font-medium leading-relaxed">
              Extract every person who engaged with any LinkedIn post. Parse titles with AI, enrich with verified emails, and close deals faster.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-5 pt-4">
            <Link href="/signup">
              <Button
                size="lg"
                className="h-14 px-10 text-lg font-bold shadow-2xl shadow-primary/30 hover:scale-105 active:scale-95 transition-all bg-primary hover:bg-primary/90"
              >
                Get Started Free
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="ml-2 h-5 w-5"
                >
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </Button>
            </Link>
            <div className="flex items-center -space-x-3 ml-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-10 w-10 rounded-full border-2 border-background bg-muted overflow-hidden">
                  <div className={`h-full w-full bg-gradient-to-br ${i % 2 === 0 ? 'from-primary/40 to-chart-3/40' : 'from-chart-1/40 to-chart-4/40'} flex items-center justify-center text-[10px] font-bold`}>
                    User
                  </div>
                </div>
              ))}
              <div className="pl-4 text-sm text-muted-foreground font-medium">
                Joined by 500+ growth hackers
              </div>
            </div>
          </div>
        </section>

        {/* Mockup Preview Section */}
        <section className="w-full max-w-6xl mb-32 relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-primary/40 via-chart-3/40 to-chart-1/40 rounded-[2rem] blur-xl opacity-20 group-hover:opacity-40 transition-opacity" />
          <div className="relative border border-white/10 rounded-[1.8rem] bg-card/40 backdrop-blur-xl overflow-hidden shadow-2xl">
            {/* Header bar */}
            <div className="h-10 border-b border-white/5 bg-white/5 flex items-center px-4 gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-red-400/50" />
              <div className="h-2.5 w-2.5 rounded-full bg-amber-400/50" />
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-400/50" />
            </div>
            {/* Mock Dashboard Representation */}
            <div className="p-8 aspect-video bg-gradient-to-br from-background/80 to-muted/20 flex flex-col items-center justify-center gap-4 group-hover:scale-[1.01] transition-transform duration-700">
               <div className="h-full w-full flex flex-col gap-6 opacity-80 pointer-events-none">
                  {/* Skeletal UI for Table */}
                  <div className="flex items-center justify-between">
                    <div className="h-8 w-48 bg-white/5 rounded-lg border border-white/5" />
                    <div className="h-8 w-24 bg-primary/20 rounded-lg border border-primary/10" />
                  </div>
                  <div className="space-y-4">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div key={i} className="flex items-center gap-4 py-3 border-b border-white/5">
                        <div className="h-10 w-10 rounded-full bg-white/5" />
                        <div className="h-4 w-32 bg-white/10 rounded" />
                        <div className="h-4 w-48 bg-white/5 rounded" />
                        <div className="ml-auto h-6 w-20 bg-emerald-500/10 border border-emerald-500/20 rounded-full" />
                      </div>
                    ))}
                  </div>
               </div>
               {/* Label */}
               <div className="absolute inset-0 flex items-center justify-center">
                 <div className="bg-background/80 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10 shadow-xl font-bold text-lg">
                   Smart Dashboard Experience 🚀
                 </div>
               </div>
            </div>
          </div>
        </section>

        {/* Features Matrix */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-8 w-full max-w-6xl">
          {[
            {
              title: "AI Extraction",
              desc: "Deep-scrapes comments & reactions with Playwright stealth browser.",
              icon: "M15.5 2H8.6c-.4 0-.8.2-1.1.5L4.5 5.5c-.3.3-.5.7-.5 1.1v12.8c0 .4.2.8.5 1.1l3 3c.3.3.7.5 1.1.5h6.9c.4 0 .8-.2 1.1-.5l3-3c.3-.3.5-.7.5-1.1V3.1c0-.4-.2-.8-.5-1.1l-3-3.1z",
              color: "text-primary",
              bg: "bg-primary/10"
            },
            {
              title: "Contextual Parsing",
              desc: "Gemini AI turns unstructured headlines into {job, company} datasets.",
              icon: "M12 2v20M2 12h20M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z",
              color: "text-chart-3",
              bg: "bg-chart-3/10"
            },
            {
              title: "Email Enrichment",
              desc: "Verify B2B contacts instantly using Apollo + LinkedIn profile mapping.",
              icon: "M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z",
              color: "text-chart-1",
              bg: "bg-chart-1/10"
            }
          ].map((f, i) => (
            <div key={i} className="group p-8 rounded-[2rem] border border-white/5 bg-card/30 backdrop-blur-md hover:bg-white/5 transition-all hover:translate-y-[-4px]">
              <div className={`h-14 w-14 rounded-2xl ${f.bg} flex items-center justify-center mb-6 group-hover:scale-110 group-hover:rotate-3 transition-transform`}>
                 <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={f.color}>
                   <path d={f.icon} />
                 </svg>
              </div>
              <h3 className="text-xl font-bold mb-3">{f.title}</h3>
              <p className="text-muted-foreground leading-relaxed">
                {f.desc}
              </p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-white/5 py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6 opacity-60">
          <p className="text-sm">© 2026 LeadHarvest. Powered by AI Intelligence.</p>
          <div className="flex gap-8 text-sm font-medium">
             <Link href="#" className="hover:text-primary">Terms</Link>
             <Link href="#" className="hover:text-primary">Privacy</Link>
             <Link href="#" className="hover:text-primary">GitHub</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

