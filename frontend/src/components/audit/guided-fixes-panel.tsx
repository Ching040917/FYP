/**
 * Guided Fixes (Beta) — workspace entry point and dialog flow.
 *
 * The entry trigger lives in the completed Audit Workspace toolbar (visible
 * at every supported desktop width). Every workflow stage after it is a
 * modal dialog, so selection, review, upload, applying, and success work
 * identically at 1366/1280/1024 widths. The original workspace findings
 * list is untouched — evidence navigation keeps its normal behavior.
 *
 * Selection lives in React state ONLY — never browser storage — and is
 * cleared whenever the audit id changes. Nothing here exposes run indexes,
 * raw rule codes as primary labels, or internal OOXML terminology. The
 * client sends violation IDs only; all targets come from persisted data.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Check, Download, Loader2, Wand2, X } from 'lucide-react'
import { api, downloadBlob } from '../../services/api'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import {
  BETA_SCOPE,
  BETA_WARNING,
  friendlyGuidedFixError,
  guidedPresentationFor,
  MAX_SELECTED,
  correctedFilename,
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

export function GuidedFixesPanel({
  auditId,
  violations,
  locationLabels,
}: {
  auditId: string
  violations: Violation[]
  /** Friendly location labels per finding id (Page N · Paragraph M). */
  locationLabels?: ReadonlyMap<string, string> | null
}) {
  const navigate = useNavigate()
  const [stage, setStage] = useState<GuidedFixStage>('idle')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [applied, setApplied] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultFilename, setResultFilename] = useState(correctedFilename(null))
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const [backToStage, setBackToStage] = useState<GuidedFixStage>('selecting')

  // Clear selection + upload + transient state when the audit changes.
  useEffect(() => {
    setStage('idle')
    setSelectedIds([])
    setSelectedFile(null)
    setErrorMessage(null)
    setApplied(0)
    setSkipped(0)
    setResultBlob(null)
    setResultFilename(correctedFilename(null))
    setBackToStage('selecting')
  }, [auditId])

  const selected = useMemo(
    () => violations.filter((v) => selectedIds.includes(v.id)),
    [violations, selectedIds],
  )

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

  const openReview = () => {
    if (selectedIds.length === 0) return
    announce(`Reviewing ${selectedIds.length} selected changes.`)
    setBackToStage('selecting')
    setStage('reviewing')
  }

  const clearSelection = () => {
    announce('Guided Fixes selection cleared.')
    setSelectedIds([])
  }

  const closeToIdle = () => {
    setStage('idle')
    setSelectedIds([])
    setSelectedFile(null)
    setErrorMessage(null)
  }

  const backToSelecting = () => {
    setStage('selecting')
  }

  const handleFile = (file: File | null) => {
    setSelectedFile(file)
    if (file) {
      announce(`Selected ${file.name}. Upload the original DOCX used for this audit.`)
    }
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
      setBackToStage('selecting')
      setStage('error')
      announce(`Guided Fixes failed. ${friendlyGuidedFixError(message)}`)
    }
  }

  const downloadResult = () => {
    if (!resultBlob) return
    downloadBlob(resultBlob, resultFilename)
    announce('Downloading the corrected document.')
  }

  const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (stage === 'selecting' || stage === 'reviewing' || stage === 'ready_to_upload' || stage === 'error') {
        backToSelecting()
      }
      // completed: Escape is not a destructive path — user must choose.
    }
  }

  // ------------------------------------------------------------------
  // Trigger (workspace toolbar, completed audits only)
  // ------------------------------------------------------------------
  const trigger = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        setSelectedIds([])
        setSelectedFile(null)
        setErrorMessage(null)
        setBackToStage('selecting')
        setStage('selecting')
      }}
    >
      <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
      Open Guided Fixes (Beta)
    </Button>
  )

  if (stage === 'idle') {
    return trigger
  }

  // ------------------------------------------------------------------
  // Selecting — findings checklist dialog
  // ------------------------------------------------------------------
  if (stage === 'selecting') {
    return (
      <>
        {trigger}
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Guided Fixes (Beta) — select supported findings"
          onKeyDown={onDialogKeyDown}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-md border border-border bg-card">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">Guided Fixes</h2>
                <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">Beta</Badge>
              </div>
              <Button variant="ghost" size="icon" onClick={closeToIdle} aria-label="Close Guided Fixes">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="shrink-0 px-5 pt-3">
              <p className="text-[13px] leading-[19px] text-muted-foreground">{BETA_WARNING}</p>
              <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">{BETA_SCOPE}</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">
              <ul className="space-y-1.5">
                {violations.map((v) => {
                  const pres = guidedPresentationFor(v)
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
              <p
                className="text-[13px] text-muted-foreground"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {selectedIds.length === 0
                  ? 'No findings selected.'
                  : `${selectedIds.length} of ${MAX_SELECTED} findings selected.`}
              </p>
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
                  Review selected changes
                </Button>
              </div>
              {announcement && (
                <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
              )}
            </div>
          </div>
        </div>
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Guided Fixes (Beta) — review selected changes"
          onKeyDown={onDialogKeyDown}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-md border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">Guided Fixes (Beta)</h2>
              <Button variant="ghost" size="icon" onClick={backToSelecting} aria-label="Close review panel">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              Selected changes: {selected.length}
            </p>
            <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
              These changes are proposed from your audit findings. Nothing has been changed yet.
            </p>
            <ul className="mt-3 space-y-2">
              {selected.map((v) => {
                const { current, proposed } = formatValueForPanel(v)
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
                        disabled={selected.length <= 1}
                        aria-label={`Remove ${REVIEW_TITLES[v.rule_code] ?? 'finding'} from selection`}
                      >
                        Remove from selection
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Current: {current} · Proposed: {proposed}
                    </p>
                  </li>
                )
              })}
            </ul>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={backToSelecting}>
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
          </div>
        </div>
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Guided Fixes (Beta) — upload the original DOCX"
          onKeyDown={onDialogKeyDown}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-xl rounded-md border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">Upload the original DOCX</h2>
              <Button variant="ghost" size="icon" onClick={backToSelecting} aria-label="Close upload panel">
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <p className="mt-2 text-[13px] leading-[19px] text-muted-foreground">
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
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setStage(backToStage)}>
                Back to findings
              </Button>
              <Button onClick={() => void applyFixes()} disabled={!selectedFile}>
                Create corrected copy
              </Button>
            </div>
          </div>
        </div>
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Creating your corrected copy"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="w-full max-w-md rounded-md border border-border bg-card p-5 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold text-foreground">Creating your corrected copy…</h2>
            <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground" role="status">
              ACA is verifying the document and applying your selected changes. This can take a moment.
            </p>
          </div>
        </div>
      </>
    )
  }

  // ------------------------------------------------------------------
  // Completed
  // ------------------------------------------------------------------
  return (
    <>
      {trigger}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Corrected copy created"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      >
        <div className="w-full max-w-md rounded-md border border-border bg-card p-5">
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
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={closeToIdle}>
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
        </div>
      </div>
    </>
  )
}
