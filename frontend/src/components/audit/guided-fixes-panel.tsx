/**
 * Guided Fixes (Beta) — workspace entry point and dialog flow.
 *
 * The entry trigger lives in the completed Audit Workspace action row (visible
 * at every supported desktop width). Every workflow stage after it is a
 * modal dialog, so selection, review, upload, applying, and success work
 * identically at 1366/1280/1024 widths. The workspace findings list is
 * untouched — evidence navigation keeps its normal behavior.
 *
 * Selection lives in React state ONLY — never browser storage — and is
 * cleared whenever the audit id changes. Nothing here exposes run indexes,
 * raw rule codes as primary labels, or internal OOXML terminology. The
 * client sends violation IDs only; all targets come from persisted data.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Check, Download, Loader2, Wand2, X } from 'lucide-react'
import { api, downloadBlob } from '../../services/api'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import {
  GF_INTRO,
  GF_SECONDARY,
  MAX_SELECTED,
  WORKFLOW_STEPS,
  correctedFilename,
  deselectInView,
  friendlyGuidedFixError,
  guidedCountLine,
  guidedLimitNotice,
  guidedPresentationFor,
  guidedReviewLabel,
  selectAllInView,
  workflowStepForStage,
} from '../../lib/guided-fixes'
import type { Violation } from '../../types/api'

export type GuidedFixStage =
  | 'idle'
  | 'selecting'
  | 'reviewing'
  | 'ready_to_upload'
  | 'applying'
  | 'completed'
  | 'error'

/** Presentation filter over the findings already classified by the helper. */
export type GuidedFilter = 'all' | 'available' | 'manual'

const FILTER_OPTIONS: Array<{ id: GuidedFilter; label: string }> = [
  { id: 'all', label: 'All findings' },
  { id: 'available', label: 'Available for Guided Fix' },
  { id: 'manual', label: 'Manual correction required' },
]

const REVIEW_TITLES: Record<string, string> = {
  FONT_CONSISTENCY: 'Font',
  FONT_SIZE: 'Font size',
  ALIGNMENT: 'Alignment',
  LINE_SPACING: 'Line spacing',
  SPACE_BEFORE: 'Space before paragraph',
  SPACE_AFTER: 'Space after paragraph',
}

function formatValueForPanel(v: Violation): { current: string; proposed: string } {
  const pres = guidedPresentationFor(v)
  const current = pres.current
  let proposed = pres.proposed
  if (v.rule_code === 'FONT_SIZE') proposed = `${proposed} text`
  if (v.rule_code === 'FONT_CONSISTENCY') proposed = `${proposed} font`
  if (v.rule_code === 'SPACE_BEFORE') proposed = `${proposed} this paragraph`
  if (v.rule_code === 'SPACE_AFTER') proposed = `${proposed} this paragraph`
  return { current, proposed }
}

/** Modal shell: overlay, dialog semantics, Escape, initial focus, restore. */
function GuidedDialog({
  label,
  onDismiss,
  dismissible = true,
  children,
}: {
  label: string
  onDismiss: () => void
  /** false while applying — Escape must not abandon an in-flight request. */
  dismissible?: boolean
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation()
      onDismiss()
    }
  }

  return (
    <div
      role="presentation"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-card"
      >
        {children}
      </div>
    </div>
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
  const [applied, setApplied] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultFilename, setResultFilename] = useState(correctedFilename(null))
  const [announcement, setAnnouncement] = useState<string | null>(null)
  // The dialog is mounted for every non-idle stage; report that to the
  // workspace so focus-mode entry can be blocked while it is open.
  const guidedOpen = stage !== 'idle'
  useEffect(() => {
    onOpenChange?.(guidedOpen)
  }, [guidedOpen, onOpenChange])
  const [backToStage, setBackToStage] = useState<GuidedFixStage>('selecting')

  // Clear selection + upload + transient state when the audit changes.
  useEffect(() => {
    setStage('idle')
    setSelectedIds([])
    setFilter('available')
    setLimitNotice(null)
    setSelectedFile(null)
    setErrorMessage(null)
    setApplied(0)
    setSkipped(0)
    setResultBlob(null)
    setResultFilename(correctedFilename(null))
    setBackToStage('selecting')
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
    setBackToStage('selecting')
    setStage('reviewing')
  }

  const clearSelection = () => {
    setSelectedIds([])
    setLimitNotice(null)
    announce('All Guided Fixes selections cleared.')
  }

  const closeToIdle = () => {
    setStage('idle')
    setSelectedIds([])
    setLimitNotice(null)
    setSelectedFile(null)
    setErrorMessage(null)
    // Return focus to the trigger that opened the flow.
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const handleFile = (file: File | null) => {
    setSelectedFile(file)
    if (file) announce(`Selected ${file.name}. Upload the original DOCX used for this audit.`)
  }

  const applyFixes = async () => {
    if (!selectedFile) return
    setStage('applying')
    announce('Creating your corrected copy…')
    try {
      const { blob, filename, summary } = await api.applyGuidedFixes(
        auditId,
        selectedFile,
        selectedIds,
      )
      setApplied(summary?.applied ?? 1)
      setSkipped(summary?.skipped ?? 0)
      setResultBlob(blob)
      setResultFilename(correctedFilename(filename))
      setStage('completed')
      announce('Corrected copy created.')
    } catch (err: unknown) {
      // Keep the selection and the chosen file — a recoverable upload error
      // must never discard the user's work.
      const message = err instanceof Error ? err.message : undefined
      setErrorMessage(friendlyGuidedFixError(message))
      setBackToStage('ready_to_upload')
      setStage('error')
      announce(`Guided Fixes failed. ${friendlyGuidedFixError(message)}`)
    }
  }

  const downloadResult = () => {
    if (!resultBlob) return
    downloadBlob(resultBlob, resultFilename)
    announce('Downloading the corrected document.')
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
        setSelectedIds([])
        setFilter('available')
        setLimitNotice(null)
        setSelectedFile(null)
        setErrorMessage(null)
        setBackToStage('selecting')
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
        <GuidedDialog label="Guided Fixes Beta — select supported findings" onDismiss={closeToIdle}>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
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

          <div className="shrink-0 px-5 pt-3">
            <p className="text-[13px] leading-[19px] text-muted-foreground">{GF_INTRO}</p>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">{GF_SECONDARY}</p>
          </div>

          <div
            role="group"
            aria-label="Filter findings"
            onKeyDown={onDialogKeyDown}
            className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-1 rounded-md border border-border bg-input/20 p-1"
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

          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 px-5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={viewAvailableIds.length === 0}
              onClick={allViewSelected ? clearAvailableSelection : selectAllAvailable}
            >
              {allViewSelected
                ? 'Clear available selection'
                : filter === 'all'
                  ? 'Select all available'
                  : 'Select all available in this view'}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">
            <ul className="space-y-1.5">
              {classified.map(({ v, pres }) => {
                if (!viewIds.has(v.id)) return null
                const label = locationLabels?.get(v.id) ?? pres.friendlyLocation
                const checkboxLabel = `${pres.friendlyName}, ${label ?? 'location unavailable'}`
                const checked = selectedIds.includes(v.id)
                const atCap = !checked && selectedIds.length >= MAX_SELECTED
                return (
                  <li key={v.id}>
                    <div className="flex items-start gap-3 rounded-md border border-border bg-input/10 px-3 py-2">
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
                            <p className="mt-0.5 text-[11px] leading-[16px] text-success">
                              Available for Guided Fix
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
                            Manual correction required
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="shrink-0 border-t border-border px-5 py-3">
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

  // ------------------------------------------------------------------
  // Reviewing
  // ------------------------------------------------------------------
  if (stage === 'reviewing') {
    return (
      <>
        {trigger}
        <GuidedDialog
          label="Guided Fixes Beta — review selected changes"
          onDismiss={() => setStage('selecting')}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Review selected changes</h2>
              {workflow}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setStage('selecting')}
              aria-label="Close review panel"
              data-dialog-initial-focus
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">
            <p className="text-sm text-muted-foreground" role="status">
              Selected changes: {selected.length}
            </p>
            <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
              These changes are proposed from your audit findings. Nothing has been changed yet.
            </p>
            <ul className="mt-3 space-y-2">
              {selected.map((v) => {
                const { current, proposed } = formatValueForPanel(v)
                const label = locationLabels?.get(v.id) ?? guidedPresentationFor(v).friendlyLocation
                return (
                  <li key={v.id} className="rounded-md border border-border bg-input/20 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {REVIEW_TITLES[v.rule_code] ?? v.rule_code}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={() => setSelectedIds((cur) => cur.filter((x) => x !== v.id))}
                        aria-label={`Remove ${REVIEW_TITLES[v.rule_code] ?? 'finding'} from selection`}
                      >
                        Remove from selection
                      </Button>
                    </div>
                    {label && <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Current: {current} · Proposed: {proposed}
                    </p>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="ghost" onClick={() => setStage('selecting')}>
              Back to findings
            </Button>
            <Button onClick={() => {
              setErrorMessage(null)
              setBackToStage('reviewing')
              setStage('ready_to_upload')
            }}>
              Continue to upload original DOCX
            </Button>
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
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Upload the original DOCX</h2>
              {workflow}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setStage('selecting')}
              aria-label="Close upload panel"
              data-dialog-initial-focus
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">
            <p className="text-[13px] leading-[19px] text-muted-foreground">
              ACA does not keep your original document. Upload the same DOCX that was used for this
              audit so ACA can verify it before creating a corrected copy.
            </p>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
              Accepted format: .docx · Maximum size: 10 MB
            </p>
            {stage === 'error' && errorMessage && (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                <p className="text-[13px] leading-[19px] text-destructive">{errorMessage}</p>
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
              <p className="mt-2 text-[13px] text-muted-foreground" role="status">
                Selected file: {selectedFile.name} — you can replace it before creating the copy.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            <Button variant="ghost" onClick={() => setStage(backToStage === 'reviewing' ? 'reviewing' : 'selecting')}>
              Back to findings
            </Button>
            <Button onClick={() => void applyFixes()} disabled={!selectedFile}>
              Create corrected copy
            </Button>
          </div>
        </GuidedDialog>
      </>
    )
  }

  // ------------------------------------------------------------------
  // Applying
  // ------------------------------------------------------------------
  if (stage === 'applying') {
    return (
      <>
        {trigger}
        <GuidedDialog label="Creating your corrected copy" onDismiss={() => undefined} dismissible={false}>
          <div className="p-5 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-foreground">Creating your corrected copy…</h2>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground" role="status">
              ACA is verifying the document and applying your selected changes. This can take a moment.
            </p>
            {workflow}
          </div>
        </GuidedDialog>
      </>
    )
  }

  // ------------------------------------------------------------------
  // Completed
  // ------------------------------------------------------------------
  return (
    <>
      {trigger}
      <GuidedDialog label="Corrected copy created" onDismiss={closeToIdle}>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Check className="h-5 w-5 text-success" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">Corrected copy created</h2>
          </div>
          <p className="mt-2 text-sm text-foreground">
            Applied: {applied} · Skipped: {skipped}
          </p>
          {skipped > 0 && (
            <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
              Some selected findings were not changed. Unsupported or unverifiable formatting may
              require manual correction.
            </p>
          )}
          <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
            Your original document was not changed. Review the corrected copy before submission.
          </p>
          <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
            To verify the result, upload the corrected copy as a new audit from the Dashboard.
          </p>
          {workflow}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={closeToIdle} data-dialog-initial-focus>
            Close
          </Button>
          <Button variant="outline" onClick={() => navigate('/dashboard')}>
            Audit corrected copy
          </Button>
          <Button onClick={downloadResult}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download corrected document
          </Button>
        </div>
      </GuidedDialog>
    </>
  )
}
