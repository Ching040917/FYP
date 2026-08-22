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
import { ReadinessCard } from '../components/dashboard/readiness-card'
import { ComplianceSummary } from '../components/audit/compliance-summary'
import { AuditCompletionPanel } from '../components/audit/audit-completion-panel'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../components/ui/card'
import {
  createSessionStorageAdapter,
  clearCompletionSnapshot,
  loadCompletionSnapshot,
  saveCompletionSnapshot,
  toCompletionSnapshot,
  type AuditCompletionSnapshot,
} from '../lib/audit/audit-completion'
import type { AuditResult } from '../types/audit'

/**
 * DashboardContent — the reusable dashboard body.
 * No nav, no footer, no page chrome (the Landing page embeds it as-is).
 */
export function DashboardContent() {
  const [result, setResult] = React.useState<AuditResult | null>(null)
  const [completion, setCompletion] = React.useState<AuditCompletionSnapshot | null>(null)
  const completionStorageRef = React.useRef(
    // Lazily bound once per mount. If unavailable, completion persists only
    // for the current mounted session (upload still completes normally).
    createSessionStorageAdapter(),
  )
  const didHydrateCompletionRef = React.useRef(false)

  const dismissCompletion = React.useCallback(() => {
    setCompletion(null)
    clearCompletionSnapshot(completionStorageRef.current)
  }, [])

  // Restore a validated completion across a same-tab remount (navigate away
  // → Return to upload) or a hard refresh. Structural validation is inside
  // loadCompletionSnapshot — malformed / future-version records are removed.
  React.useEffect(() => {
    if (didHydrateCompletionRef.current) return
    didHydrateCompletionRef.current = true
    const restored = loadCompletionSnapshot(completionStorageRef.current)
    if (!restored) return
    setCompletion(restored)
  }, [])

  // Snapshot the exact completed-audit from the POST response — never from
  // History, filename, or selected profile. Each success replaces the
  // previous completion (newer audit wins). Failures do not create one and
  // do not restore a stale predecessor.
  const handleResult = React.useCallback(
    (r: AuditResult, _cloudEnabled: boolean) => {
      setResult(r)
      const snap = toCompletionSnapshot({
        audit_id: r.audit_id,
        score: r.weighted_compliance_score,
        major_count: r.major_count ?? 0,
        minor_count: r.minor_count ?? 0,
        completed_at: r.audited_at,
      })
      if (!snap) return
      setCompletion(snap)
      saveCompletionSnapshot(completionStorageRef.current, snap)
    },
    [],
  )

  // Do NOT clear the completion on file pick — a new valid submission
  // starts is the replacement gate (see UploadCard's onUpload/run-success
  // sequence). Clearing on pick would punish a user who corrects a file
  // name before retrying. For the file-to-audit association, Dashboard
  // clears the result summary only when the user explicitly picks a new file
  // if they choose to; for Build 6+ the completion panel is only cleared on
  // Dismiss / View audit / newer successful audit — not on pick.
  const handleReset = React.useCallback(() => {
    setResult(null)
  }, [])

  return (
    <DashboardShell
      result={result}
      completion={completion}
      onViewAudit={(id) => {
        clearCompletionSnapshot(completionStorageRef.current)
        setCompletion(null)
        // Use the exact stored id, never a recomputed one.
        window.location.assign(`/audit/${encodeURIComponent(id)}`)
      }}
      onDismissCompletion={dismissCompletion}
      onResult={handleResult}
      onReset={handleReset}
    />
  )
}

function DashboardShell({
  result,
  completion,
  onViewAudit,
  onDismissCompletion,
  onResult,
  onReset,
}: {
  result: AuditResult | null
  completion: AuditCompletionSnapshot | null
  onViewAudit: (auditId: string) => void
  onDismissCompletion: () => void
  onResult: (r: AuditResult, cloudEnabled: boolean) => void
  onReset: () => void
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 xl:grid-cols-[5fr_7fr]">
      {/* Intake — upload + specification */}
      <div className="min-w-0 space-y-6">
        {completion ? (
          <AuditCompletionPanel
            model={{ source: 'snapshot', value: completion }}
            onViewAudit={onViewAudit}
            onDismiss={onDismissCompletion}
          />
        ) : null}
        <ReadinessCard />
        <UploadCard onResult={onResult} onReset={onReset} />
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
