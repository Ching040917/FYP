/**
 * Auditra — Academic Compliance Auditor (single-page app)
 *
 * Ported from reference_project/src/app/page.tsx. Layout mirrors DESIGN.md
 * (Corporate Modern dark):
 *   ┌─ Header (logo + brand + 3 outlined badges: Local-First / Hybrid / APA 7)
 *   ├─ Hero (1-line value prop + lead copy)
 *   ├─ Upload card + Spec card  |  Score dashboard (when a result is present)
 *   │                              ├─ Score hero + radar + per-category bars
 *   │                              ├─ Error list (left)  +  Error detail (right)
 *   │                              └─ AI citation tips (right)
 *   └─ Footer (privacy note, FR-5)
 *
 * Backend `/api/audit` is unchanged — wire payload is mapped to reference
 * AuditResult shape via lib/audit/adapter.ts.
 */

import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FileSearch } from 'lucide-react'
import { UploadCard } from '../components/audit/upload-card'
import { ScoreDashboard } from '../components/audit/score-dashboard'
import { ErrorList, ErrorDetail } from '../components/audit/error-list'
import { CitationTips } from '../components/audit/citation-tips'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../components/ui/card'
import { Button } from '../components/ui/button'
import type { AuditResult, LayoutError } from '../types/audit'

export function Dashboard() {
  const navigate = useNavigate()
  const [result, setResult] = React.useState<AuditResult | null>(null)
  const [cloudWasEnabled, setCloudWasEnabled] = React.useState(false)
  const [selected, setSelected] = React.useState<LayoutError | null>(null)

  const handleResult = (r: AuditResult) => {
    setResult(r)
    setCloudWasEnabled(true) // the only path to setResult is via UploadCard which already toggled cloud
    setSelected(r.physical_layout_errors[0] ?? null)
  }

  const handleReset = () => {
    setResult(null)
    setSelected(null)
    setCloudWasEnabled(false)
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <AppNav
        current="dashboard"
        title="Dashboard"
        subtitle="Academic Compliance Auditor"
      />

      {/* ────────────────────────── Hero ────────────────────────── */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6 md:py-10">
          <h1 className="max-w-3xl text-2xl font-bold tracking-tight md:text-3xl">
            Audit your thesis formatting with a hybrid{' '}
            <span className="text-primary">rules + AI</span> engine — locally, in seconds.
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
            Upload a{' '}
            <code className="rounded bg-muted/40 px-1 py-0.5 font-mono text-xs">.docx</code>{' '}
            and Auditra will run six deterministic layout checks (margins, fonts, sizes,
            paragraph typography, heading hierarchy, media captions) plus an optional APA 7
            citation pass. Files never leave your browser unless you explicitly enable cloud
            AI.
          </p>
        </div>
      </section>

      {/* ────────────────────────── Main ────────────────────────── */}
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Left rail — upload + spec */}
          <div className="lg:col-span-5 xl:col-span-4">
            <UploadCard onResult={handleResult} onReset={handleReset} />
            <SpecCard />
          </div>

          {/* Right — dashboard or empty state */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-4">
            {result ? (
              <>
                <ScoreDashboard result={result} />
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <ErrorList
                    result={result}
                    selectedId={selected?.id}
                    onSelect={(e) => setSelected(e)}
                  />
                  <div className="space-y-4">
                    <ErrorDetail error={selected} />
                    <CitationTips result={result} cloudWasEnabled={cloudWasEnabled} />
                  </div>
                </div>
                {result.audit_id && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      className="border-border text-muted-foreground"
                      onClick={() => navigate(`/audit/${result.audit_id}`)}
                    >
                      View full audit
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <EmptyDashboard />
            )}
          </div>
        </div>
      </main>

      {/* ────────────────────────── Footer ────────────────────────── */}
      <AppFooter />
    </div>
  )
}

/* ----------------------------- Auxiliary cards ----------------------------- */

function SpecCard() {
  return (
    <Card className="mt-4 border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Compliance Spec</CardTitle>
        <CardDescription>
          Default &quot;University Thesis&quot; ruleset applied during audit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <SpecRow label="Body font" value="Times New Roman, 12pt" />
        <SpecRow label="Heading font" value="Times New Roman, 12–16pt by level" />
        <SpecRow label="Line spacing" value="Double (2.0×)" />
        <SpecRow label="Body alignment" value="Justified" />
        <SpecRow label="Page margins" value="1″ top / bottom / left / right" />
        <SpecRow label="Citation style" value="APA 7th edition (opt-in AI)" />
      </CardContent>
    </Card>
  )
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}

function EmptyDashboard() {
  return (
    <Card className="border-border bg-card flex min-h-[520px] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
        <FileSearch className="h-6 w-6" />
      </div>
      <div>
        <div className="text-base font-semibold">No audit yet</div>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Drop a .docx file in the panel on the left. Auditra will compute the weighted
          compliance score, surface layout errors by paragraph, and (optionally) flag APA
          citation issues via the cloud AI engine.
        </p>
      </div>
      <div className="grid w-full max-w-md grid-cols-3 gap-2 text-xs">
        <Stat icon="ruler" label="6 rule scopes" />
        <Stat icon="weight" label="Weighted score" />
        <Stat icon="sparkles" label="APA 7 AI audit" />
      </div>
    </Card>
  )
}

function Stat({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="rounded-md border border-border bg-input/20 px-2 py-2 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{icon}</div>
      <div className="mt-0.5 text-xs font-medium text-foreground">{label}</div>
    </div>
  )
}