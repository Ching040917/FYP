/**
 * HistoryPage — the audit register (Build 5).
 *
 * Server-backed pagination against GET /api/audits (limit/offset). The
 * backend returns no total count, so next-page existence is probed
 * truthfully by requesting PAGE_SIZE + 1 records and rendering only 25.
 *
 * Desktop: real semantic <table>. Mobile: stacked record list (only one
 * view is exposed per breakpoint; both derive from the same data).
 * Delete uses a custom accessible alertdialog (no dialog dependency).
 */

import { useEffect, useState, useCallback, useRef, type Ref } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  History,
  Trash2,
  X,
  PauseCircle,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import { api, TimeoutError } from '../services/api'
import { useToast } from '../hooks/useToast'
import { formatAuditDateTime, auditDateTimeAttr } from '../lib/format-date'
import { dropRenderedPdfCache } from '../hooks/use-rendered-pdf'
import { isScoreAvailable } from '../lib/score-display'
import type { AuditListItem } from '../types/api'

type LoadState = 'loading' | 'success' | 'error' | 'empty'

const PAGE_SIZE = 25
/** One extra record probes whether another page exists (no backend total). */
const REQUEST_LIMIT = PAGE_SIZE + 1

export function HistoryPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [records, setRecords] = useState<AuditListItem[]>([])
  const [hasNext, setHasNext] = useState(false)
  const [page, setPage] = useState(0)
  const [state, setState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AuditListItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Guards against stale responses overwriting a newer page selection.
  const requestRef = useRef(0)
  // Post-delete focus: the triggered Delete button is detached on success,
  // so focus moves to the register container (or the page heading when the
  // register is not rendered, e.g. empty history).
  const registerRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusAfterDeleteRef = useRef(false)

  const fetchPage = useCallback(
    async (pageIndex: number, quiet = false) => {
      const reqId = ++requestRef.current
      if (!quiet) {
        setState('loading')
        setErrorMsg(null)
      }
      try {
        const list = await api.listAudits(REQUEST_LIMIT, pageIndex * PAGE_SIZE)
        if (reqId !== requestRef.current) return // stale response
        if (list.length === 0 && pageIndex > 0) {
          setPage(0) // empty probe beyond page 0 — never strand the user
          return
        }
        setRecords(list.slice(0, PAGE_SIZE))
        setHasNext(list.length > PAGE_SIZE)
        setState(list.length === 0 ? 'empty' : 'success')
      } catch (err: any) {
        if (reqId !== requestRef.current) return
        const msg =
          err instanceof TimeoutError
            ? 'Request timed out. Is the backend running?'
            : err.message || 'Failed to load audit history.'
        setErrorMsg(msg)
        setState('error')
        showToast(msg, 'error')
      }
    },
    [showToast],
  )

  useEffect(() => {
    void fetchPage(page)
  }, [page, fetchPage])

  // Invalidate in-flight requests on unmount.
  useEffect(() => () => void requestRef.current++, [])

  // Focus a stable element after a successful deletion once the refreshed
  // page has rendered. Cancel and failed deletes never set the flag, so the
  // dialog's own trigger-restore behavior applies to them.
  useEffect(() => {
    if (!focusAfterDeleteRef.current) return
    if (state === 'loading') return // wait for the refreshed page
    focusAfterDeleteRef.current = false
    if (registerRef.current) registerRef.current.focus()
    else headingRef.current?.focus()
  }, [records, state])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchPage(page, true)
    setRefreshing(false)
  }

  const handleDelete = async (audit: AuditListItem) => {
    setDeleting(true)
    try {
      await api.deleteAudit(audit.id)
      // Cache invalidation ONLY after the API deletion succeeded — a failed
      // deletion must not clear local state or the rendered-PDF cache.
      dropRenderedPdfCache(audit.id)
      setDeleteTarget(null)
      focusAfterDeleteRef.current = true
      showToast(`Deleted audit record: ${audit.filename}`, 'success')
      if (records.length === 1 && page > 0) {
        // Deleted the final visible record on a non-first page — move back.
        setPage(page - 1)
      } else {
        await fetchPage(page, true)
      }
    } catch (err: any) {
      const msg =
        err instanceof TimeoutError
          ? 'Request timed out. Is the backend running?'
          : err.message || 'Failed to delete audit.'
      showToast(`Delete failed. ${msg}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#history-main">
        Skip to audit history
      </a>
      <AppNav
        current="history"
        title="Audit History"
        subtitle="Academic Compliance Auditor"
        backTo="/dashboard"
      />

      <main id="history-main" className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        {/* Page header */}
        <section className="border-b border-border pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="font-serif text-page-title leading-[34px] text-foreground outline-none"
              >
                Audit history
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-[21px] text-muted-foreground">
                Previous document audits, stored locally. Open a record for the full evidence
                report, or delete a record when it is no longer needed.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-border text-muted-foreground hover:text-foreground"
              onClick={handleRefresh}
              disabled={refreshing || state === 'loading'}
            >
              {refreshing ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </div>
        </section>

        {state === 'loading' && <LoadingSkeleton />}

        {state === 'error' && (
          <ErrorState
            message={errorMsg}
            onRetry={handleRefresh}
            onBackHome={() => navigate('/dashboard')}
          />
        )}

        {state === 'empty' && <EmptyState />}

        {state === 'success' && (
          <HistoryRegister
            records={records}
            hasNext={hasNext}
            page={page}
            registerRef={registerRef}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
            onDelete={(a) => setDeleteTarget(a)}
            onUploadAgain={() => navigate('/dashboard')}
          />
        )}

        {/* Delete confirmation dialog */}
        {deleteTarget && (
          <DeleteDialog
            audit={deleteTarget}
            deleting={deleting}
            onConfirm={() => handleDelete(deleteTarget)}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
      </main>

      <AppFooter />
    </div>
  )
}

/* ----------------------------- Register (desktop table + mobile records) ----------------------------- */

function HistoryRegister({
  records,
  hasNext,
  page,
  registerRef,
  onPrev,
  onNext,
  onDelete,
  onUploadAgain,
}: {
  records: AuditListItem[]
  hasNext: boolean
  page: number
  registerRef: Ref<HTMLDivElement>
  onPrev: () => void
  onNext: () => void
  onDelete: (audit: AuditListItem) => void
  onUploadAgain: (audit: AuditListItem) => void
}) {
  const start = page * PAGE_SIZE + 1
  const end = page * PAGE_SIZE + records.length

  return (
    <div
      ref={registerRef}
      tabIndex={-1}
      className="rounded-md border border-border outline-none"
    >
      {/* Desktop — semantic table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Audit history records</caption>
          <thead>
            <tr className="border-b border-border bg-input/20 text-left">
              <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Document
              </th>
              <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Audit date
              </th>
              <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </th>
              <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Compliance score
              </th>
              <th scope="col" className="px-4 py-2.5 text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {records.map((a) => (
              <tr key={a.id} className="hover:bg-muted/50">
                <td className="max-w-[260px] px-4 py-3 align-top">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground" title={a.filename}>
                        {a.filename}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground">{a.id}</div>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top">
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    <time dateTime={auditDateTimeAttr(a.created_at) ?? undefined}>
                      {formatDate(a.created_at)}
                    </time>
                  </span>
                </td>
                <td className="px-4 py-3 align-top">
                  <StatusBadge status={a.status} />
                </td>
                <td className="px-4 py-3 align-top">
                  <ScoreCell status={a.status} score={a.weighted_score} />
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      to={`/audit/${a.id}`}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
                    >
                      Open report
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                    {a.status === 'interrupted' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[13px] border-border text-foreground"
                        onClick={() => onUploadAgain(a)}
                      >
                        Upload document again
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => onDelete(a)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Delete
                    </Button>
                  </div>
                  {a.status === 'interrupted' && (
                    <p className="mt-1.5 text-right text-xs leading-[16px] text-muted-foreground">
                      This audit stopped before processing was completed. Upload the document
                      again to start a new audit.
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile — stacked records */}
      <div className="md:hidden">
        <ul className="divide-y divide-border">
          {records.map((a) => (
            <li key={a.id} className="px-4 py-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="break-words text-sm font-medium text-foreground">{a.filename}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{a.id}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <StatusBadge status={a.status} />
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  <time dateTime={auditDateTimeAttr(a.created_at) ?? undefined}>
                    {formatDate(a.created_at)}
                  </time>
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <ScoreCell status={a.status} score={a.weighted_score} />
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <Link
                    to={`/audit/${a.id}`}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
                  >
                    Open report
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                  {a.status === 'interrupted' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[13px] border-border text-foreground"
                      onClick={() => onUploadAgain(a)}
                    >
                      Upload document again
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[13px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onDelete(a)}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </div>
              {a.status === 'interrupted' && (
                <p className="mt-2 text-xs leading-[16px] text-muted-foreground">
                  This audit stopped before processing was completed. Upload the document
                  again to start a new audit.
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-[13px] text-muted-foreground">
          {records.length > 0
            ? `Showing records ${start}–${end}`
            : 'No records on this page'}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground"
            disabled={page === 0}
            onClick={onPrev}
          >
            <ArrowRight className="mr-1.5 h-3.5 w-3.5 rotate-180" aria-hidden="true" />
            Previous page
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground"
            disabled={!hasNext}
            onClick={onNext}
          >
            Next page
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------- Cells and badges ----------------------------- */

function ScoreCell({ status, score }: { status: string; score: number | null | undefined }) {
  if (status !== 'completed' || !isScoreAvailable(score)) {
    return <span className="text-[13px] text-muted-foreground">Unavailable</span>
  }
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono text-[13px] text-foreground">{score}</span>
      <span className="ml-1 text-[11px] text-muted-foreground">/100 for enabled checks</span>
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'processing') {
    return (
      <Badge variant="outline" className="border-information/40 bg-information/10 text-information">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Processing
      </Badge>
    )
  }
  if (status === 'interrupted') {
    return (
      <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
        <PauseCircle className="mr-1 h-3 w-3" aria-hidden="true" /> Interrupted
      </Badge>
    )
  }
  if (status === 'completed') {
    return (
      <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Completed
      </Badge>
    )
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
        <XCircle className="mr-1 h-3 w-3" /> Failed
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-border text-muted-foreground">
      Unknown status
    </Badge>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Unavailable'
  return formatAuditDateTime(iso)
}

/* ----------------------------- States ----------------------------- */

function LoadingSkeleton() {
  return (
    <Card className="border-border bg-card" role="status" aria-busy="true">
      <CardContent className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-md border border-border bg-input/20 px-4 py-3"
          >
            <div className="h-4 w-4 animate-pulse rounded bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-2 w-1/5 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-6 w-12 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
          <History className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <div className="text-base font-semibold text-foreground">No audit records yet</div>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            Run your first audit from the Dashboard. Completed and in-progress audits are
            stored locally and will appear here.
          </p>
        </div>
        <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
          <Link to="/dashboard">
            <ArrowRight className="mr-2 h-4 w-4 rotate-180" aria-hidden="true" />
            Go to Dashboard
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function ErrorState({
  message,
  onRetry,
  onBackHome,
}: {
  message: string | null
  onRetry: () => void
  onBackHome: () => void
}) {
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-md bg-destructive/15 text-destructive ring-1 ring-destructive/30">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <div className="text-base font-semibold text-foreground">Could not load audit history</div>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {message ?? 'An unexpected error occurred.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="border-border text-foreground" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
          <Button type="button" variant="ghost" className="text-muted-foreground" onClick={onBackHome}>
            <ArrowRight className="mr-2 h-4 w-4 rotate-180" aria-hidden="true" />
            Back to Dashboard
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Delete confirmation (accessible alertdialog) ----------------------------- */

function DeleteDialog({
  audit,
  deleting,
  onConfirm,
  onCancel,
}: {
  audit: AuditListItem
  deleting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  // Initial focus on Cancel; restore focus to the trigger on close; lock body scroll.
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      triggerRef.current?.focus?.()
    }
  }, [])

  // Escape closes (unless deletion is in progress); Tab/Shift+Tab stay inside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleting, onCancel])

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-description"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={deleting ? undefined : onCancel}
    >
      <div
        className="w-full max-w-md rounded-md border border-border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive ring-1 ring-destructive/30">
            <Trash2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h2 id="delete-dialog-title" className="text-base font-semibold text-foreground">
              Delete audit record
            </h2>
            <p id="delete-dialog-description" className="mt-1 text-sm text-muted-foreground">
              This will permanently delete the audit record and its stored findings. Your
              original Word document is never modified or deleted.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 rounded-md border border-border bg-input/20 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 break-words text-sm font-medium text-foreground">
              {audit.filename}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="font-mono">{audit.id}</span>
            <time dateTime={auditDateTimeAttr(audit.created_at) ?? undefined}>
              {formatDate(audit.created_at)}
            </time>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            className="border-border text-foreground"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete audit record
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
