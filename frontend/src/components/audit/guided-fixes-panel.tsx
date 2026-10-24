/**
 * Guided Fixes (Beta) — workspace entry point and dialog flow.
 *
 * The trigger lives in the completed Audit Workspace action row. Selection,
 * original upload, server-confirmed review, apply/verification and explicit
 * download share a responsive modal. Workspace evidence navigation is
 * untouched while the dialog is closed.
 *
 * Selection lives in React state ONLY — never browser storage — and is
 * cleared whenever the audit id changes. Nothing here exposes run indexes,
 * raw rule codes as primary labels, or internal OOXML terminology. The
 * client sends violation IDs only; the server alone confirms exact targets.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Check, Download, Loader2, Wand2, X } from 'lucide-react'
import { api, ApiRequestError, downloadBlob, type GuidedFixReview, type GuidedFixVerification } from '../../services/api'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import {
  GF_INTRO, GF_SECONDARY, MAX_SELECTED, REFERENCE_HEADING_BOLD_PROPERTY, WORKFLOW_STEPS, correctedFilename,
  deselectInView, friendlyGuidedFixError, guidedCountLine, guidedLimitNotice,
  guidedPresentationFor, guidedReviewLabel, selectAllInView, workflowStepForStage,
} from '../../lib/guided-fixes'
import { friendlyRuleTitle } from '../../lib/friendly-finding'
import type { Violation } from '../../types/api'

export type GuidedFixStage =
  | 'idle' | 'selecting' | 'ready_to_upload' | 'checking'
  | 'reviewing' | 'applying' | 'completed' | 'error'

/** Presentation filter over the findings already classified by the helper. */
export type GuidedFilter = 'all' | 'available' | 'manual'

const FILTER_OPTIONS: Array<{ id: GuidedFilter; label: string }> = [
  { id: 'all', label: 'All findings' },
  { id: 'available', label: 'Candidates for safety review' },
  { id: 'manual', label: 'Manual correction required' },
]
/** Page-session only: names we issued, not browser disk contents. */
const downloadedNames = new Set<string>()

/**
 * Use shared finding titles, except the two-direction heading-bold candidate
 * uses its approved neutral property label.
 */
function reviewLabelFor(v: Violation): string {
  return v.rule_code === 'REFERENCE_HEADING_BOLD'
    ? REFERENCE_HEADING_BOLD_PROPERTY
    : friendlyRuleTitle(v.rule_code) ?? 'finding'
}


/** Modal shell follows the shared confirmation's focus, Escape and scroll-lock behavior. */
function GuidedDialog({
  label, onDismiss, dismissible = true, children,
}: {
  label: string
  onDismiss: () => void
  dismissible?: boolean
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => {
      const initial = panelRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ;(initial ?? panelRef.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      document.body.style.overflow = oldOverflow
      if (returnFocus.current?.isConnected) returnFocus.current.focus()
    }
  }, [])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault()
        onDismiss()
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((node) => node.getClientRects().length > 0)
      if (!nodes.length) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissible, onDismiss])
  return createPortal(
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onDismiss() }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}
        className="flex max-h-[90dvh] w-full min-w-0 max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl max-[240px]:block max-[240px]:overflow-y-auto [&_button:focus-visible]:ring-primary">
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function GuidedFixesPanel({
  auditId,
  violations,
  locationLabels,
  onOpenChange,
}: {
  auditId: string
  violations: Violation[]
  /** Friendly location labels per finding id (Page N · Paragraph M). */
  locationLabels?: ReadonlyMap<string, string> | null
  /** Reports the dialog open state (stage !== 'idle') to the parent. */
  onOpenChange?: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [stage, setStage] = useState<GuidedFixStage>('idle')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [filter, setFilter] = useState<GuidedFilter>('available')
  const [limitNotice, setLimitNotice] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorHeading, setErrorHeading] = useState('Fix not applied')
  const [review, setReview] = useState<GuidedFixReview | null>(null)
  const reviewRef = useRef<{ auditId: string; id: string } | null>(null)
  const [verification, setVerification] = useState<GuidedFixVerification | null>(null)
  // Bind the result to its issuing audit, including the commit before audit-reset effects run.
  const verificationAudit = useRef<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadFilename, setDownloadFilename] = useState<string | null>(null)
  const requestSerial = useRef(0)
  const downloadInFlight = useRef<number | null>(null)
  const downloadContext = useRef<{
    auditId: string; verification: GuidedFixVerification | null; stage: GuidedFixStage
  } | null>(null)
  // Committed context only; layout cleanup invalidates downloads before passive unmount/reset effects.
  useLayoutEffect(() => {
    downloadContext.current = { auditId, verification, stage }
    return () => { downloadContext.current = null }
  }, [auditId, verification, stage])
  const [announcement, setAnnouncement] = useState<string | null>(null)
  // The dialog is mounted for every non-idle stage; report that to the
  // workspace so focus-mode entry can be blocked while it is open.
  const guidedOpen = stage !== 'idle'
  useEffect(() => {
    onOpenChange?.(guidedOpen)
  }, [guidedOpen, onOpenChange])
  // Audit switches/unmounts invalidate in-flight UI work and revoke unused reviews.
  useEffect(() => {
    setStage('idle')
    setSelectedIds([])
    setFilter('available')
    setLimitNotice(null)
    setSelectedFile(null)
    setErrorMessage(null)
    setAnnouncement(null)
    setReview(null)
    setVerification(null)
    verificationAudit.current = null
    downloadInFlight.current = null
    setDownloading(false)
    setDownloaded(false)
    setDownloadFilename(null)
    return () => {
      requestSerial.current++
      if (reviewRef.current) {
        const { auditId: oldAudit, id } = reviewRef.current
        reviewRef.current = null
        void api.cancelGuidedFixReview(oldAudit, id).catch(() => undefined)
      }
    }
  }, [auditId])

  /** Presentation classification per finding, computed once per audit. */
  const classified = useMemo(
    () => violations.map((v) => ({ v, pres: guidedPresentationFor(v) })),
    [violations],
  )
  const availableIds = useMemo(
    () => classified.filter((c) => c.pres.supported).map((c) => c.v.id),
    [classified],
  )
  const availableCount = availableIds.length
  const manualCount = classified.length - availableCount
  const viewIds = useMemo(() => {
    const ids =
      filter === 'all'
        ? classified.map((c) => c.v.id)
        : filter === 'available'
          ? availableIds
          : classified.filter((c) => !c.pres.supported).map((c) => c.v.id)
    return new Set(ids)
  }, [classified, filter, availableIds])
  /** Supported findings visible in the current view — select-all target. */
  const viewAvailableIds = useMemo(
    () => availableIds.filter((id) => viewIds.has(id)),
    [availableIds, viewIds],
  )

  const selected = useMemo(
    () => violations.filter((v) => selectedIds.includes(v.id)),
    [violations, selectedIds],
  )
  const allViewSelected =
    viewAvailableIds.length > 0 &&
    viewAvailableIds.every((id) => selectedIds.includes(id))

  const announce = (message: string) => setAnnouncement(message)

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds((cur) => cur.filter((x) => x !== id))
      return
    }
    if (selectedIds.length >= MAX_SELECTED) {
      announce(`You can select up to ${MAX_SELECTED} findings for Guided Fixes.`)
      return
    }
    setSelectedIds((cur) => [...cur, id])
  }

  /** Select every supported finding in the current view, capped at 20. */
  const selectAllAvailable = () => {
    const next = selectAllInView(selectedIds, viewAvailableIds)
    setSelectedIds(next)
    const notice = guidedLimitNotice(next.length, availableCount)
    setLimitNotice(notice)
    announce(notice ?? `${next.length} findings selected.`)
  }

  /** Unselect the view's supported findings; hidden selections survive. */
  const clearAvailableSelection = () => {
    setSelectedIds((cur) => deselectInView(cur, viewAvailableIds))
    setLimitNotice(null)
    announce('Available selection cleared.')
  }

  const openReview = () => {
    if (selectedIds.length === 0) return
    setStage('ready_to_upload')
  }

  const clearSelection = () => {
    setSelectedIds([])
    setLimitNotice(null)
    announce('All Guided Fixes selections cleared.')
  }

  const revokeReview = () => {
    if (!reviewRef.current) return
    const { auditId: oldAudit, id } = reviewRef.current
    reviewRef.current = null
    setReview(null)
    void api.cancelGuidedFixReview(oldAudit, id).catch(() => undefined)
  }

  const closeToIdle = () => {
    requestSerial.current++
    downloadInFlight.current = null
    setDownloading(false)
    setDownloaded(false)
    setDownloadFilename(null)
    revokeReview()
    setReview(null)
    setStage('idle')
    setSelectedIds([])
    setLimitNotice(null)
    setSelectedFile(null)
    setErrorMessage(null)
    setAnnouncement(null)
    setVerification(null)
    verificationAudit.current = null
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const handleFile = (file: File | null) => {
    revokeReview()
    setSelectedFile(file)
    if (file) announce(`Selected ${file.name}. Upload the original DOCX used for this audit.`)
  }

  const reviewFixes = async () => {
    if (!selectedFile || selectedIds.length === 0) return
    const serial = ++requestSerial.current
    setStage('checking')
    setErrorMessage(null)
    try {
      const result = await api.reviewGuidedFixes(auditId, selectedFile, selectedIds)
      if (serial !== requestSerial.current) {
        void api.cancelGuidedFixReview(auditId, result.review_id).catch(() => undefined)
        return
      }
      const returned = result.items.map((item) => item.violation_id)
      if (!result.review_id || returned.length !== selectedIds.length ||
          new Set(returned).size !== returned.length ||
          selectedIds.some((id) => !returned.includes(id))) {
        if (result.review_id) void api.cancelGuidedFixReview(auditId, result.review_id).catch(() => undefined)
        throw new Error('Incomplete safety review')
      }
      reviewRef.current = { auditId, id: result.review_id }
      setReview(result)
      setStage('reviewing')
      announce('Safety review passed. Inspect every confirmed location before applying.')
    } catch (err: unknown) {
      if (serial !== requestSerial.current) return
      setErrorHeading('Fix not applied')
      setErrorMessage(friendlyGuidedFixError(err instanceof Error ? err.message : undefined))
      setStage('error')
    }
  }

  const applyFixes = async () => {
    if (!selectedFile || !review || reviewRef.current?.id !== review.review_id) return
    const serial = ++requestSerial.current
    setStage('applying')
    try {
      const result = await api.applyGuidedFixes(auditId, selectedFile, selectedIds, review.review_id)
      reviewRef.current = null // consumed by apply; never revoke a used token
      if (serial !== requestSerial.current) return
      if (result.resolved.length !== selectedIds.length ||
          selectedIds.some((id) => !result.resolved.includes(id)) ||
          result.new_findings.length !== 0) throw new Error('Verification did not pass')
      verificationAudit.current = auditId
      setVerification(result)
      setDownloaded(false)
      setDownloadFilename(null)
      setStage('completed')
      announce('Fix applied; re-audit passed. Download is now available.')
    } catch (err: unknown) {
      if (serial !== requestSerial.current) return
      revokeReview()
      setVerification(null)
      const verificationFailed = err instanceof ApiRequestError && err.status === 422 &&
        /re.audit|verification|preserv|regression|score|output/i.test(err.message)
      setErrorHeading(verificationFailed ? 'Fix applied; verification failed' : 'Fix not applied')
      setErrorMessage(verificationFailed
        ? 'The attempted change did not pass verification. The output was discarded; no corrected document is available.'
        : friendlyGuidedFixError(err instanceof Error ? err.message : undefined))
      setStage('error')
    }
  }

  const downloadResult = async () => {
    const context = downloadContext.current
    if (!verification || downloading || downloaded || downloadInFlight.current !== null ||
        context?.auditId !== auditId || verificationAudit.current !== auditId ||
        context.verification !== verification || context.stage !== 'completed') return
    const serial = ++requestSerial.current
    downloadInFlight.current = serial
    const isCurrent = () => serial === requestSerial.current &&
      downloadInFlight.current === serial &&
      downloadContext.current?.auditId === auditId &&
      verificationAudit.current === auditId &&
      downloadContext.current.verification === verification &&
      downloadContext.current.stage === 'completed'
    setDownloading(true)
    try {
      const blob = await api.downloadGuidedFix(auditId, verification.download_token)
      if (!isCurrent()) return
      const name = correctedFilename(verification.output_filename, downloadedNames)
      downloadBlob(blob, name)
      downloadedNames.add(name)
      setDownloadFilename(name)
      setDownloaded(true)
    } catch (err) {
      if (!isCurrent()) return
      if (err instanceof ApiRequestError && (err.status === 410 || err.status === 404)) setDownloaded(true)
      setErrorMessage('The verified download is unavailable or expired. Your original document was not changed.')
    } finally {
      if (isCurrent()) {
        downloadInFlight.current = null
        setDownloading(false)
      }
    }
  }

  const step = workflowStepForStage(stage)
  const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const idx = FILTER_OPTIONS.findIndex((o) => o.id === filter)
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const next = FILTER_OPTIONS[(idx + delta + FILTER_OPTIONS.length) % FILTER_OPTIONS.length]
    e.preventDefault()
    setFilter(next.id)
    document.getElementById(`guided-filter-${next.id}`)?.focus()
  }

  // ------------------------------------------------------------------
  // Trigger (workspace action row, completed audits only)
  // ------------------------------------------------------------------
  const trigger = (
    <Button
      ref={triggerRef}
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        requestSerial.current++
        downloadInFlight.current = null
        setDownloading(false)
        setDownloaded(false)
        setDownloadFilename(null)
        revokeReview()
        setSelectedIds([])
        setFilter('available')
        setLimitNotice(null)
        setSelectedFile(null)
        setErrorMessage(null)
        setAnnouncement(null)
        setVerification(null)
        verificationAudit.current = null
        setStage('selecting')
      }}
    >
      <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
      Guided Fixes
      <Badge variant="outline" className="ml-0.5 border-primary/40 bg-primary/10 text-[10px] text-primary">
        Beta
      </Badge>
    </Button>
  )

  if (stage === 'idle') return trigger

  // ------------------------------------------------------------------
  // Shared dialog header: title + compact four-step workflow indicator
  // ------------------------------------------------------------------
  const workflow = step === null ? null : (
    <ol
      aria-label={`Guided Fixes progress — step ${step + 1} of ${WORKFLOW_STEPS.length}: ${WORKFLOW_STEPS[step]}`}
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
    >
      {WORKFLOW_STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === step ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1',
            i === step && 'font-medium text-primary',
            i < step && 'text-foreground',
          )}
        >
          <span aria-hidden="true">{i + 1}.</span>
          {label}
        </li>
      ))}
    </ol>
  )

  // ------------------------------------------------------------------
  // Selecting — filterable findings checklist dialog
  // ------------------------------------------------------------------
  if (stage === 'selecting') {
    return (
      <>
        {trigger}
        <GuidedDialog label="Guided Fixes Beta — select candidate findings" onDismiss={closeToIdle}>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3 max-[240px]:gap-1 max-[240px]:px-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">Guided Fixes</h2>
                <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                  Beta
                </Badge>
              </div>
              {workflow}
            </div>
            <Button variant="ghost" size="icon" onClick={closeToIdle} aria-label="Close Guided Fixes" data-dialog-initial-focus>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="shrink-0 px-5 pt-3 max-[240px]:px-2">
            <p className="text-[13px] leading-[19px] text-muted-foreground">{GF_INTRO}</p>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">{GF_SECONDARY}</p>
          </div>

          <div
            role="group"
            aria-label="Filter findings"
            onKeyDown={onDialogKeyDown}
            className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-1 rounded-md border border-border bg-input/20 p-1 max-[240px]:mx-2"
          >
            {FILTER_OPTIONS.map((o) => {
              const count =
                o.id === 'all' ? classified.length : o.id === 'available' ? availableCount : manualCount
              const active = filter === o.id
              return (
                <button
                  key={o.id}
                  id={`guided-filter-${o.id}`}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setFilter(o.id)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    active ? 'bg-card font-medium text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {o.label} · {count}
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 px-5 max-[240px]:px-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={viewAvailableIds.length === 0}
              onClick={allViewSelected ? clearAvailableSelection : selectAllAvailable}
              className="max-[240px]:h-auto max-[240px]:max-w-full max-[240px]:whitespace-normal"
            >
              {allViewSelected
                ? 'Clear candidate selection'
                : 'Select all candidates in this view'}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin max-[240px]:px-2">
            {viewIds.size === 0 && (
              <p className="text-[13px] leading-[19px] text-muted-foreground">
                {filter === 'available' && manualCount > 0
                  ? 'No findings are candidates for Guided Fixes. Choose Manual correction required to view the other findings.'
                  : 'No findings in this view.'}
              </p>
            )}
            <ul className="space-y-1.5">
              {classified.map(({ v, pres }) => {
                if (!viewIds.has(v.id)) return null
                const label = locationLabels?.get(v.id) ?? pres.friendlyLocation
                const checkboxLabel = `${pres.friendlyName}, ${label ?? 'location unavailable'}`
                const checked = selectedIds.includes(v.id)
                const atCap = !checked && selectedIds.length >= MAX_SELECTED
                return (
                  <li key={v.id}>
                    <div className="flex items-start gap-3 rounded-md border border-border bg-input/10 px-3 py-2 max-[240px]:gap-1 max-[240px]:px-2">
                      {pres.supported ? (
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={atCap}
                          onChange={() => toggle(v.id)}
                          aria-label={checkboxLabel}
                          className="mt-1 h-4 w-4 shrink-0 accent-primary"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="mt-1 h-4 w-4 shrink-0 rounded-sm border border-border bg-muted"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{pres.friendlyName}</p>
                        <p className="mt-0.5 text-[11px] leading-[16px] text-muted-foreground">
                          {label ?? 'Location unavailable'}
                        </p>
                        {pres.supported ? (
                          <>
                            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
                              Current: {pres.current} · Proposed: {pres.proposed}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-[16px] text-muted-foreground">
                              Candidate only — safety review required
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
                            ACA cannot safely correct this finding automatically. Follow its Required action in the audit report.
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="shrink-0 border-t border-border px-5 py-3 max-[240px]:px-2 max-[240px]:[&_button]:h-auto max-[240px]:[&_button]:w-full max-[240px]:[&_button]:min-w-0 max-[240px]:[&_button]:whitespace-normal">
            <p className="text-[13px] text-muted-foreground">{guidedCountLine(selectedIds.length, availableCount)}</p>
            {limitNotice && (
              <p className="mt-1 text-[13px] text-warning">{limitNotice}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                disabled={selectedIds.length === 0}
              >
                Clear selection
              </Button>
              <Button type="button" onClick={openReview} disabled={selectedIds.length === 0}>
                {guidedReviewLabel(selectedIds.length)}
              </Button>
            </div>
          </div>
        </GuidedDialog>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement ?? guidedCountLine(selectedIds.length, availableCount)}
        </span>
      </>
    )
  }

  // Review is shown ONLY after the server validates the uploaded source and
  // confirms complete targets for every selected finding.
  if (stage === 'reviewing' && review) {
    const cancelReview = () => {
      revokeReview()
      setStage('ready_to_upload')
    }
    return (
      <>
        {trigger}
        <GuidedDialog label="Guided Fixes — review confirmed changes" onDismiss={cancelReview}>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 max-[240px]:gap-1 max-[240px]:px-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Review confirmed changes</h2>
              {workflow}
            </div>
            <Button variant="ghost" size="icon" onClick={cancelReview}
              aria-label="Cancel safety review" data-dialog-initial-focus>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin max-[240px]:px-2">
            <p className="text-sm text-foreground" role="status">
              Safety review passed for {review.items.length} selected {review.items.length === 1 ? 'finding' : 'findings'}. Nothing has been changed yet.
            </p>
            <ul className="mt-3 space-y-2">
              {review.items.map((item) => {
                const finding = selected.find((v) => v.id === item.violation_id)
                return (
                  <li key={item.violation_id} className="rounded-md border border-border bg-input/20 px-3 py-2">
                    <p className="text-sm font-medium text-foreground">{finding ? reviewLabelFor(finding) : 'Formatting change'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Property to change: {item.property}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Current: {item.before}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Required and proposed: {item.after}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.affected_count} affected {item.affected_count === 1 ? 'location' : 'locations'}: {item.locations.join(', ')}
                    </p>
                  </li>
                )
              })}
            </ul>
            <div className="mt-3 space-y-1 text-[13px] leading-[19px] text-muted-foreground">
              <p>Scope: Only the confirmed formatting property at the listed locations will change. Text, other formatting, document parts and your original file are preserved.</p>
              <p>Layout risk: Font and paragraph formatting can reflow pages. ACA checks preservation and re-audits the corrected copy before permitting download.</p>
              {review.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
              <p>Proposed filename: <span className="break-all font-medium text-foreground">{correctedFilename(review.output_filename, downloadedNames)}</span></p>
              <p>Review expires at {new Date(review.expires_at).toLocaleString()}.</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-[240px]:px-2 max-[240px]:[&_button]:h-auto max-[240px]:[&_button]:w-full max-[240px]:[&_button]:min-w-0 max-[240px]:[&_button]:whitespace-normal">
            <Button variant="ghost" onClick={cancelReview}>Cancel review</Button>
            <Button onClick={() => void applyFixes()}>Apply and verify changes</Button>
          </div>
        </GuidedDialog>
      </>
    )
  }

  // ------------------------------------------------------------------
  // Upload (and its error state — same surface, selection preserved)
  // ------------------------------------------------------------------
  if (stage === 'ready_to_upload' || stage === 'error') {
    return (
      <>
        {trigger}
        <GuidedDialog
          label="Guided Fixes Beta — upload the original DOCX"
          onDismiss={() => setStage('selecting')}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3 max-[240px]:gap-1 max-[240px]:px-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Upload the original DOCX</h2>
              {workflow}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setStage('selecting')}
              aria-label="Back to findings"
              data-dialog-initial-focus
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin max-[240px]:px-2">
            <p className="text-[13px] leading-[19px] text-muted-foreground">
              ACA does not keep your original document. Upload the same DOCX that was used for this
              audit so ACA can verify it before creating a corrected copy.
            </p>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
              Accepted format: .docx · Maximum size: 10 MB
            </p>
            {stage === 'error' && errorMessage && (
              <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                <p className="text-[13px] leading-[19px] text-destructive"><strong>{errorHeading}.</strong> {errorMessage}</p>
              </div>
            )}
            <label htmlFor="guided-fixes-file-input" className="mt-4 block text-sm font-medium text-foreground">
              Original document (.docx)
            </label>
            <input
              id="guided-fixes-file-input"
              type="file"
              accept=".docx"
              className="mt-2 block w-full text-sm text-foreground file:mr-3 file:rounded file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-muted"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            {selectedFile && (
              <p className="mt-2 break-all text-[13px] text-muted-foreground" role="status">
                Selected file: {selectedFile.name} — you can replace it before safety review.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-[240px]:px-2 max-[240px]:[&_button]:h-auto max-[240px]:[&_button]:w-full max-[240px]:[&_button]:min-w-0 max-[240px]:[&_button]:whitespace-normal">
            <Button variant="ghost" onClick={() => setStage('selecting')}>Back to findings</Button>
            <Button onClick={() => void reviewFixes()} disabled={!selectedFile}>
              Review safety and locations
            </Button>
          </div>
        </GuidedDialog>
      </>
    )
  }

  // ------------------------------------------------------------------
  // Server safety review and verification are separate non-dismissible steps.
  // ------------------------------------------------------------------
  if (stage === 'checking' || stage === 'applying') {
    const checking = stage === 'checking'
    return (
      <>
        {trigger}
        <GuidedDialog label={checking ? 'Checking safety and locations' : 'Applying and verifying'}
          onDismiss={() => undefined} dismissible={false}>
          <div className="p-5 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-foreground">
              {checking ? 'Checking safety and locations…' : 'Applying changes and re-auditing…'}
            </h2>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground" role="status">
              {checking
                ? 'ACA is checking the original document and every selected target. No change has been made.'
                : 'ACA is checking the corrected copy against the original and re-auditing it. A failed check prevents download.'}
            </p>
            {workflow}
          </div>
        </GuidedDialog>
      </>
    )
  }

  // Only a passed backend verification issues a token. No copy exists in the
  // browser until the user explicitly requests the one-use download.
  return (
    <>
      {trigger}
      <GuidedDialog label="Fix applied; re-audit passed" onDismiss={closeToIdle}>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 max-[240px]:p-2" tabIndex={0} aria-label="Re-audit results">
          <div className="flex items-center gap-2">
            <Check className="h-5 w-5 text-success" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">Fix applied; re-audit passed</h2>
          </div>
          <p className="mt-2 text-sm text-foreground">
            {verification?.resolved.length ?? 0} selected {verification?.resolved.length === 1 ? 'finding' : 'findings'} resolved · No new findings.
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Score: {verification?.before_score} → {verification?.after_score}.
          </p>
          <div className="mt-2 grid gap-3 text-[13px] text-muted-foreground sm:grid-cols-2">
            {([
              ['Before', verification?.before_findings ?? []],
              ['After', verification?.after_findings ?? []],
            ] as const).map(([label, findings]) => (
              <div key={label} className="min-w-0 rounded-md border border-border p-3">
                <p className="font-medium text-foreground">{label} re-audit findings</p>
                {findings.length === 0
                  ? <p className="mt-1">None</p>
                  : <ul className="mt-1 space-y-1">
                    {findings.map((finding, index) => (
                      <li key={`${finding.rule_code}-${index}`}>
                        {finding.rule_code === 'REFERENCE_HEADING_BOLD'
                          ? REFERENCE_HEADING_BOLD_PROPERTY
                          : friendlyRuleTitle(finding.rule_code) ?? 'Finding'}: {finding.count}
                        {finding.locations.length > 0 && ` · ${finding.locations.join(', ')}`}
                      </li>
                    ))}
                  </ul>}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
            Your original document and its History entry are unchanged. This verified result is session-only;
            uploading the corrected copy from the Dashboard creates a separate, independent audit ID.
          </p>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
            Review the corrected document in Word before submission. Download expires at {verification && new Date(verification.expires_at).toLocaleString()}.
          </p>
          <p className="mt-1 break-all text-[13px] text-muted-foreground">
            Filename: {downloadFilename ?? correctedFilename(verification?.output_filename, downloadedNames)}
          </p>
          <span role="status" aria-live="polite" className="sr-only">
            {downloading ? 'Downloading…' : null}
          </span>
          {errorMessage && <p role="alert" className="mt-2 text-[13px] text-destructive">{errorMessage}</p>}
          {downloaded && !errorMessage && <p role="status" className="mt-2 text-[13px] text-success">Downloaded. The one-use link has expired.</p>}
          {workflow}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3 max-[240px]:px-2 max-[240px]:[&_button]:h-auto max-[240px]:[&_button]:w-full max-[240px]:[&_button]:min-w-0 max-[240px]:[&_button]:whitespace-normal">
          <Button variant="ghost" onClick={closeToIdle} data-dialog-initial-focus>Close</Button>
          <Button variant="outline" onClick={() => navigate('/dashboard')}>Audit corrected copy</Button>
          <Button onClick={() => void downloadResult()} disabled={!verification || downloading || downloaded}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {downloading ? 'Downloading…' : 'Download corrected document'}
          </Button>
        </div>
      </GuidedDialog>
    </>
  )
}
