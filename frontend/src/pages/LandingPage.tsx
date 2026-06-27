/**
 * LandingPage — Scrollable introduction / marketing page for Auditra.
 *
 * Mirrors DESIGN.md (Corporate Modern dark):
 *   ┌─ Header (logo + brand + 3 outlined badges: Local-First / Hybrid / APA 7)
 *   ├─ Hero (1-line value prop + lead copy + dashboard preview window)
 *   ├─ Feature highlights (3 cards)
 *   ├─ How it works (3-step flow)
 *   ├─ Compliance spec card
 *   └─ Footer (privacy note, FR-5)
 *
 * No audit logic — purely presentational. CTA navigates to /workspace.
 */

import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import {
  ShieldCheck,
  FileSearch,
  Lock,
  Cloud,
  Sparkles,
  CheckCircle2,
  Zap,
  Shield,
  ArrowRightFromLine,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../components/ui/card'

// Custom SVG logo from Stitch prototype (shield with checkmark)
const LogoIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

export function LandingPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ────────────────────────── Header ────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
          <Link to="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              <LogoIcon />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Auditra</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Academic Compliance Auditor
              </div>
            </div>
          </Link>
          <nav className="hidden items-center gap-2 md:flex" aria-label="Main navigation">
            <Link
              to="/"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Home
            </Link>
            <Link
              to="/workspace"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Workspace
            </Link>
            <Link
              to="/history"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              History
            </Link>
          </nav>
          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => navigate('/workspace')}
          >
            <ArrowRightFromLine className="mr-2 h-4 w-4" />
            Start Audit
          </Button>
        </div>
      </header>

      {/* ────────────────────────── Hero ────────────────────────── */}
      <section className="relative border-b border-border bg-gradient-to-b from-primary/5 to-transparent overflow-hidden">
        {/* Grid background pattern */}
        <div
          className="absolute inset-0 opacity-30 [background-image:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Cpath%20d%3D%22M100%200H0v100h100V0Z%22%20fill%3D%22none%22%20stroke%3D%22%23464554%22%20stroke-width%3D%220.5%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E'),url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20100%20100%22%3E%3Cpath%20d%3D%22M0%20100H100V0H0v100Z%22%20fill%3D%22none%22%20stroke%3D%22%23464554%22%20stroke-width%3D%220.5%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E')]"
          aria-hidden="true"
        />
        {/* Hero glow */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/10 blur-3xl pointer-events-none"
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-[1440px] px-4 py-16 md:px-6 md:py-24">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl lg:text-5xl">
              Audit your thesis before the deadline does it for you in <span className="text-primary">seconds</span>.
            </h1>
            <p className="mt-4 max-w-2xl mx-auto text-base text-muted-foreground md:text-lg">
              Upload a{' '}
              <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-sm">
                .docx
              </code>{' '}
              and Auditra runs six deterministic layout checks (margins, fonts, sizes,
              paragraph typography, heading hierarchy, media captions) plus an optional APA 7
              citation pass. Files never leave your browser unless you explicitly enable cloud
              AI.
            </p>
            <div className="mt-8 flex items-center justify-center gap-4">
              <Button
                size="lg"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => navigate('/workspace')}
              >
                <ArrowRightFromLine className="mr-2 h-5 w-5" />
                Start Free Audit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="border-border text-muted-foreground hover:text-foreground"
                onClick={() => navigate('/workspace')}
              >
                <Zap className="mr-2 h-5 w-5" />
                Try with Sample Thesis
              </Button>
            </div>
          </div>

          {/* Dashboard Preview Window Mockup (.window-frame) */}
          <div className="mt-12 mx-auto max-w-5xl">
            <div className="relative bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl overflow-hidden">
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 py-2">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-rose-500" />
                  <div className="w-3 h-3 rounded-full bg-amber-500" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500" />
                </div>
                <div className="flex-1 text-center text-xs text-on-surface-variant font-mono">
                  academic-compliance-auditor.tsx
                </div>
              </div>
              {/* Miniature dashboard content */}
              <div className="p-4 md:p-6">
                <div className="grid gap-4 md:grid-cols-3">
                  {/* Left: Document preview */}
                  <div className="md:col-span-2 space-y-3">
                    <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                      <span className="flex items-center gap-1">
                        <FileSearch className="h-3 w-3" />
                        thesis_final_v3.docx
                      </span>
                      <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-300 rounded border border-emerald-500/30">
                        94/100
                      </span>
                    </div>
                    <div className="bg-surface border border-outline-variant rounded-lg p-3 font-body-md text-body-md leading-relaxed text-on-surface max-h-48 overflow-auto">
                      <h2 className="font-headline-md text-headline-md mb-2 text-on-surface">Chapter 4: Methodology and Analysis</h2>
                      <p className="mb-2">The primary dataset was collected over a three-month period utilizing a stratified random sampling approach. Participant demographics were recorded, ensuring representation across all targeted socioeconomic strata.</p>
                      <p className="highlight-error border-l-2 border-error bg-error/5 pl-2 my-2">
                        However, an alternative methodology was proposed by Smith (2022) but was not fully integrated into the initial framework due to time constraints and lack of available literature regarding its long-term efficacy in similar cohort studies.
                      </p>
                      <p>Further analysis revealed a statistically significant correlation between the independent variables, supporting the primary hypothesis formulated during the preliminary review phase.</p>
                    </div>
                  </div>
                  {/* Right: Citation Assistant */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-outline-variant pb-2">
                      <h3 className="font-headline-sm text-headline-sm text-on-surface flex items-center gap-1">
                        <Sparkles className="h-4 w-4 text-primary" />
                        Citation Assistant
                      </h3>
                      <span className="bg-surface-container-highest px-2 py-0.5 rounded text-[10px] font-medium text-on-surface-variant">3 Issues</span>
                    </div>
                    <div className="space-y-2">
                      {/* Major violation */}
                      <div className="bg-surface border border-outline-variant rounded-lg p-3 relative overflow-hidden group hover:border-error transition-colors">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-error" />
                        <div className="flex items-start justify-between mb-1">
                          <span className="bg-error/10 text-error font-label-sm text-label-sm px-2 py-0.5 rounded border border-error/20 font-bold uppercase tracking-wide">Major</span>
                          <span className="text-on-surface-variant font-mono text-xs">Line 6–7</span>
                        </div>
                        <h4 className="font-body-md text-body-md font-semibold text-on-surface mb-1">Missing Citation &amp; Formatting</h4>
                        <p className="font-body-md text-body-md text-on-surface-variant mb-2 text-sm">"Smith (2022)" is mentioned in text but missing from bibliography. Paragraph structure deviates from APA 7th ed. guidelines for long quotes.</p>
                        <div className="bg-surface-container rounded p-2 border border-outline-variant border-dashed">
                          <div className="flex items-center gap-1 text-primary font-label-sm text-label-sm mb-1">
                            <span className="material-symbols-outlined text-sm">build</span>
                            AI Fix Suggestion
                          </div>
                          <p className="font-mono text-xs text-on-surface-variant">Insert Citation → Add New Source. Ensure author name is spelled exactly as "Smith, J."</p>
                          <button className="mt-2 bg-surface-bright text-on-surface px-3 py-1 rounded text-label-sm font-label-sm border border-outline-variant hover:bg-surface-variant transition-colors w-full">Apply Format Fix</button>
                        </div>
                      </div>
                      {/* Minor violation */}
                      <div className="bg-surface border border-outline-variant rounded-lg p-3 relative overflow-hidden group hover:border-tertiary transition-colors">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-tertiary" />
                        <div className="flex items-start justify-between mb-1">
                          <span className="bg-tertiary/10 text-tertiary font-label-sm text-label-sm px-2 py-0.5 rounded border border-tertiary/20 font-bold uppercase tracking-wide">Minor</span>
                          <span className="text-on-surface-variant font-mono text-xs">Line 12</span>
                        </div>
                        <h4 className="font-body-md text-body-md font-semibold text-on-surface mb-1">Passive Voice Overuse</h4>
                        <p className="font-body-md text-body-md text-on-surface-variant text-sm">Academic guidelines recommend active voice for clarity. "Further analysis revealed..." could be restructured.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ────────────────────────── Trust Badges ────────────────────────── */}
      <section className="border-b border-border bg-background/50">
        <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6">
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Read-only — never modifies your document
            </span>
            <span className="flex items-center gap-1.5">
              <Lock className="h-4 w-4 text-emerald-400" />
              Local-first (Ollama qwen2.5:3b)
            </span>
            <span className="flex items-center gap-1.5">
              <Cloud className="h-4 w-4 text-primary" />
              Cloud AI opt-in (Gemini 1.5 Flash)
            </span>
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-amber-400" />
              APA 7th edition citations
            </span>
          </div>
        </div>
      </section>

      {/* ────────────────────────── Feature highlights ────────────────────────── */}
      <section className="border-b border-border bg-background">
        <div className="mx-auto max-w-[1440px] px-4 py-12 md:px-6 md:py-16">
          <div className="max-w-2xl mx-auto text-center mb-12">
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
              Built for academic compliance
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              Six deterministic layout rules plus optional AI citation checking — all in one
              privacy-preserving workflow.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <FeatureCard
              icon={<Zap className="h-6 w-6" />}
              title="Instant Layout Audit"
              description="Six rule scopes run in &lt;500ms: margins, fonts, line spacing, alignment, heading hierarchy, media captions. Weighted scoring reflects thesis requirements."
            />
            <FeatureCard
              icon={<Shield className="h-6 w-6" />}
              title="Local-First Privacy"
              description="Default engine runs on your machine via Ollama (qwen2.5:3b). Your thesis never leaves your browser unless you explicitly toggle cloud mode."
            />
            <FeatureCard
              icon={<CheckCircle2 className="h-6 w-6" />}
              title="APA 7 Citation Check"
              description="Optional AI pass detects missing authors, years, et al. errors, ampersand issues, page number format, and more. Confidence scores on every finding."
            />
          </div>
        </div>
      </section>

      {/* ────────────────────────── How it works ────────────────────────── */}
      <section className="border-b border-border bg-background/50">
        <div className="mx-auto max-w-[1440px] px-4 py-12 md:px-6 md:py-16">
          <div className="max-w-2xl mx-auto text-center mb-12">
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">
              How it works
            </h2>
            <p className="mt-3 text-base text-muted-foreground">
              Three steps from document to compliance report.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <StepCard
              step="01"
              title="Upload .docx"
              description="Drag and drop your thesis or select a file. Maximum 10 MB. Parsed in-memory — never written to disk."
              icon={<FileSearch className="h-6 w-6" />}
            />
            <StepCard
              step="02"
              title="Run Audit"
              description="Layout engine scores 6 rule categories instantly. Toggle cloud AI for APA 7 citation analysis — falls back to local if cloud fails."
              icon={<Zap className="h-6 w-6" />}
            />
            <StepCard
              step="03"
              title="Review &amp; Fix"
              description="Weighted score, per-paragraph violations with expected vs actual values, and AI fix suggestions. Export full report or view history."
              icon={<CheckCircle2 className="h-6 w-6" />}
            />
          </div>
        </div>
      </section>

      {/* ────────────────────────── Compliance Spec ────────────────────────── */}
      <section className="border-b border-border bg-background">
        <div className="mx-auto max-w-[1440px] px-4 py-12 md:px-6 md:py-16">
          <div className="max-w-3xl mx-auto">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold">Default Compliance Spec</CardTitle>
                <CardDescription>
                  University Thesis ruleset applied during every audit.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <SpecRow label="Body font" value="Times New Roman, 12pt" />
                <SpecRow label="Heading font" value="Times New Roman, 12–16pt by level" />
                <SpecRow label="Line spacing" value="Double (2.0×)" />
                <SpecRow label="Body alignment" value="Justified" />
                <SpecRow label="Page margins" value="1″ top / bottom / left / right" />
                <SpecRow label="Citation style" value="APA 7th edition (opt-in AI)" />
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* ────────────────────────── Footer ────────────────────────── */}
      <footer className="mt-auto w-full border-t border-border bg-card p-4">
        <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">
          <div className="flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              <span>
                Auditra · Read-only formatting checker. Your file is parsed in-memory and
                never modified.
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Lock className="h-3 w-3" /> Local by default
              </span>
              <span className="flex items-center gap-1">
                <Cloud className="h-3 w-3" /> Cloud opt-in
              </span>
            </div>
          </div>
          <nav className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground" aria-label="Footer navigation">
            <Link to="/" className="hover:text-foreground transition-colors">Home</Link>
            <Link to="/workspace" className="hover:text-foreground transition-colors">Workspace</Link>
            <Link to="/history" className="hover:text-foreground transition-colors">History</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}

/* ----------------------------- Feature Card ----------------------------- */

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <Card className="border-border bg-card h-full">
      <CardContent className="flex flex-col h-full p-6">
        <div className="grid h-12 w-12 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30 mb-4">
          {icon}
        </div>
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <CardDescription className="text-sm text-muted-foreground flex-1">
          {description}
        </CardDescription>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Step Card ----------------------------- */

function StepCard({
  step,
  title,
  description,
  icon,
}: {
  step: string
  title: string
  description: string
  icon: React.ReactNode
}) {
  return (
    <Card className="border-border bg-card h-full">
      <CardContent className="flex flex-col h-full p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-shrink-0 text-xs font-mono font-bold text-primary">{step}</div>
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
            {icon}
          </div>
        </div>
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <CardDescription className="text-sm text-muted-foreground flex-1">
          {description}
        </CardDescription>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Spec Row ----------------------------- */

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}