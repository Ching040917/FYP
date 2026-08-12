/**
 * Auditra — Academic Compliance Auditor
 *
 * Dashboard.tsx exports:
 *   - DashboardContent: the reusable dashboard body (upload + spec summary
 *     on the left, compliance summary or guidance on the right). Used by
 *     the /dashboard route AND embedded directly on the Landing page.
 *   - Dashboard: the full /dashboard page (skip link, AppNav, editorial
 *     header, DashboardContent, AppFooter).
 *
 * Build 4: concise audit-entry + result-summary page. Full findings
 * evidence lives in the Audit Workspace (/audit/:id) — not duplicated here.
 */

import * as React from 'react'
import { UploadCard } from '../components/audit/upload-card'
import { ComplianceSummary } from '../components/audit/compliance-summary'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../components/ui/card'
import type { AuditResult } from '../types/audit'

/**
 * DashboardContent — the reusable dashboard body.
 * No nav, no footer, no page chrome (the Landing page embeds it as-is).
 */
export function DashboardContent() {
  const [result, setResult] = React.useState<AuditResult | null>(null)

  // AI-review status now travels with the audit result (ai_review_status /
  // ai_provider), so the summary no longer needs request-time cloud state.
  const handleResult = (r: AuditResult, _cloudEnabled: boolean) => {
    setResult(r)
  }

  const handleReset = () => {
    setResult(null)
  }

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 xl:grid-cols-[5fr_7fr]">
      {/* Intake — upload + specification */}
      <div className="min-w-0 space-y-6">
        <UploadCard onResult={handleResult} onReset={handleReset} />
        <SpecCard />
      </div>

      {/* Result — concise summary or guidance */}
      <div className="min-w-0">
        {result ? (
          <ComplianceSummary result={result} />
        ) : (
          <InitialGuidance />
        )}
      </div>
    </div>
  )
}

/**
 * Dashboard — the full /dashboard page.
 */
export function Dashboard() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#dashboard-main">
        Skip to dashboard content
      </a>
      <AppNav
        current="dashboard"
        title="Dashboard"
        subtitle="Academic Compliance Auditor"
      />

      <main id="dashboard-main" className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        <section className="border-b border-border pb-5">
          <h1 className="font-serif text-page-title leading-[34px] text-foreground">
            Audit Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-[21px] text-muted-foreground">
            Upload a .docx thesis draft to run supported formatting checks and review the
            compliance summary. The full evidence report opens in the Audit Workspace.
          </p>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
            Documents are processed locally by default. The optional AI-assisted citation
            review is opt-in.
          </p>
        </section>

        <div className="mt-6">
          <DashboardContent />
        </div>
      </main>

      <AppFooter />
    </div>
  )
}

/* ----------------------------- Specification summary ----------------------------- */

// Spec values mirror the authoritative backend preset (backend/app/config.py
// → PresetConfig). Hardcoded duplication is tracked as technical debt — a
// preset API is out of scope for this Build. Keep this card in sync when
// the preset changes.

function SpecCard() {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Current formatting specification</CardTitle>
        <CardDescription>
          Values reflect the configured default preset applied during audit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1.5">
          <SpecRow label="Body font" value="Times New Roman, 12pt" />
          <SpecRow label="Heading font" value="Times New Roman, 12–16pt by level" />
          <SpecRow label="Line spacing" value="1.5×" />
          <SpecRow label="Body alignment" value="Justified" />
          <SpecRow label="Left margin" value="1.5″" />
          <SpecRow label="Top / right / bottom margin" value="1″" />
          <SpecRow label="Citation style" value="APA 7th edition (opt-in AI)" />
        </dl>
      </CardContent>
    </Card>
  )
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-[13px] text-foreground">{value}</dd>
    </div>
  )
}

/* ----------------------------- Initial guidance ----------------------------- */

function InitialGuidance() {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">No audit yet</CardTitle>
        <CardDescription>
          Start an audit to review the compliance summary here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-[21px] text-muted-foreground">
          <li>Upload a .docx document using the panel on the left.</li>
          <li>
            The audit runs supported deterministic formatting checks (margins, fonts, sizes,
            paragraph spacing, heading hierarchy, media captions).
          </li>
          <li>Review the compliance summary and open the full audit report for evidence.</li>
        </ol>
      </CardContent>
    </Card>
  )
}
