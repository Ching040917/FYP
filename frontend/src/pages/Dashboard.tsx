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
import { GuidancePanel } from '../components/dashboard/guidance-panel'
import { ComplianceSummary } from '../components/audit/compliance-summary'
import { AuditCompletionPanel } from '../components/audit/audit-completion-panel'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import { Button } from '../components/ui/button'
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
import {
  clearGuidance,
  createBrowserGuidanceAdapter,
  createMemoryGuidanceAdapter,
  loadGuidanceDismissed,
  saveGuidanceDismissed,
} from '../lib/guidance'
import type { AuditResult } from '../types/audit'
import type { ReadinessOverall } from '../lib/readiness'

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
  const [readinessOverall, setReadinessOverall] = React.useState<ReadinessOverall | null>(null)
  const [expandSignal, setExpandSignal] = React.useState(0)

  // First-run guidance: hydrated once from versioned localStorage. Null until
  // hydration completes so returning users never see a dismissal flash.
  const guidanceAdapterRef = React.useRef(
    createBrowserGuidanceAdapter() ?? createMemoryGuidanceAdapter(),
  )
  const [guidanceDismissed, setGuidanceDismissed] = React.useState<boolean | null>(null)

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

  // Hydrate guidance dismissal once. No usable record (first visit, corrupted
  // record removed, storage unavailable) → guidance shows.
  const didHydrateGuidanceRef = React.useRef(false)
  React.useEffect(() => {
    if (didHydrateGuidanceRef.current) return
    didHydrateGuidanceRef.current = true
    setGuidanceDismissed(loadGuidanceDismissed(guidanceAdapterRef.current))
  }, [])

  const dismissGuidance = React.useCallback(() => {
    setGuidanceDismissed(true)
    saveGuidanceDismissed(guidanceAdapterRef.current, true)
  }, [])

  const reopenGuidance = React.useCallback(() => {
    // Reopen clears the persisted dismissal so the panel behaves like a
    // first visit again (and stays visible across refreshes until dismissed).
    clearGuidance(guidanceAdapterRef.current)
    setGuidanceDismissed(false)
  }, [])

  // Snapshot the exact completed-audit from the POST response — never from
  // History, filename, or selected profile. Each success replaces the
  // previous completion (newer audit wins). Failures do not create one and
  // do not restore a stale predecessor.
  const handleResult = React.useCallback(
    (r: AuditResult) => {
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
      readinessOverall={readinessOverall}
      onReadinessChange={setReadinessOverall}
      guidanceDismissed={guidanceDismissed}
      expandSignal={expandSignal}
      onExpandSignal={() => setExpandSignal((s) => s + 1)}
      onDismissGuidance={dismissGuidance}
      onReopenGuidance={reopenGuidance}
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
  readinessOverall,
  onReadinessChange,
  guidanceDismissed,
  expandSignal,
  onExpandSignal,
  onReopenGuidance,
  onDismissGuidance,
  onViewAudit,
  onDismissCompletion,
  onResult,
  onReset,
}: {
  result: AuditResult | null
  completion: AuditCompletionSnapshot | null
  readinessOverall: ReadinessOverall | null
  onReadinessChange: (overall: ReadinessOverall | null) => void
  /** null = still hydrating; true = dismissed; false = show guidance. */
  guidanceDismissed: boolean | null
  expandSignal: number
  onExpandSignal: () => void
  onReopenGuidance: () => void
  onDismissGuidance: () => void
  onViewAudit: (auditId: string) => void
  onDismissCompletion: () => void
  onResult: (r: AuditResult) => void
  onReset: () => void
}) {
  const focusDropzone = React.useCallback(() => {
    const el = document.getElementById('upload-dropzone')
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    ;(el as HTMLElement).focus({ preventScroll: true })
  }, [])

  const focusReadiness = React.useCallback(() => {
    const el = document.getElementById('readiness-heading')
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    ;(el as HTMLElement).focus?.({ preventScroll: true })
  }, [])

  return (
    <div className="min-w-0 space-y-5">
        {completion ? (
          <AuditCompletionPanel
            model={{ source: 'snapshot', value: completion }}
            onViewAudit={onViewAudit}
            onDismiss={onDismissCompletion}
          />
        ) : null}
        <ReadinessCard
          onReadinessChange={onReadinessChange}
          expandSignal={expandSignal}
          detailsSlot={
            guidanceDismissed === true ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={onReopenGuidance}
              >
                Show setup guidance
              </Button>
            ) : undefined
          }
        />
        <UploadCard
          onResult={onResult}
          onReset={onReset}
        />
      <div className="min-w-0">
        {result ? (
          <ComplianceSummary result={result} />
        ) : guidanceDismissed !== true ? (
          <GuidancePanel
            readiness={readinessOverall ?? 'unavailable'}
            onStartAuditing={() => {
              onDismissGuidance()
              requestAnimationFrame(focusDropzone)
            }}
            onViewReadiness={() => {
              onExpandSignal()
              requestAnimationFrame(focusReadiness)
            }}
            onDismiss={onDismissGuidance}
          />
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

      <main id="dashboard-main" className="mx-auto w-full max-w-[1440px] px-4 py-5 md:px-6">
        <section className="border-b border-border pb-4">
          <h1 className="font-serif text-page-title leading-[34px] text-foreground">
            Audit Dashboard
          </h1>
          <p className="mt-1 text-sm leading-[21px] text-muted-foreground">
            Upload a DOCX, choose a profile and run supported formatting checks. Review full evidence in the Audit Workspace.
          </p>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
            Documents are processed locally; optional AI citation review uses your local AI service.
          </p>
        </section>

        <div className="mt-4">
          <DashboardContent />
        </div>
      </main>

      <AppFooter />
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
