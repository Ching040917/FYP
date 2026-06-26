/**
 * LandingPage — Scrollable introduction / marketing page for Auditra.
 *
 * Mirrors DESIGN.md (Corporate Modern dark):
 *   ┌─ Header (logo + brand + 3 outlined badges: Local-First / Hybrid / APA 7)
 *   ├─ Hero (1-line value prop + lead copy)
 *   ├─ Feature highlights (3 cards)
 *   ├─ How it works (3-step flow)
 *   ├─ Compliance spec card
 *   └─ Footer (privacy note, FR-5)
 *
 * No audit logic — purely presentational. CTA navigates to /workspace.
 */

import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck,
  FileSearch,
  Lock,
  Cloud,
  Sparkles,
  ArrowRight,
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
import { Badge } from '../components/ui/badge'

export function LandingPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ────────────────────────── Header ────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Auditra</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Academic Compliance Auditor
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            >
              <Lock className="mr-1 h-3 w-3" /> Local-First
            </Badge>
            <Badge variant="outline" className="border-border text-muted-foreground">
              <FileSearch className="mr-1 h-3 w-3" /> Hybrid Engine
            </Badge>
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/10 text-primary"
            >
              <Sparkles className="mr-1 h-3 w-3" /> APA 7 Ready
            </Badge>
          </div>
          {/* CTA to workspace */}
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
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-16 md:px-6 md:py-20">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl lg:text-5xl">
              Audit your thesis formatting with a hybrid{' '}
              <span className="text-primary">rules + AI</span> engine — locally, in seconds.
            </h1>
            <p className="mt-4 max-w-2xl mx-auto text-base text-muted-foreground md:text-lg">
              Upload a{' '}
              <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-sm">
                .docx
              </code>{' '}
              and Auditra will run six deterministic layout checks (margins, fonts, sizes,
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
                onClick={() => navigate('/history')}
              >
                View History
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ────────────────────────── Trust badges ────────────────────────── */}
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
              description="Six rule scopes run in <500ms: margins, fonts, line spacing, alignment, heading hierarchy, media captions. Weighted scoring reflects thesis requirements."
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
              title="Review & Fix"
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
      <footer className="mt-auto border-t border-border bg-background/60">
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