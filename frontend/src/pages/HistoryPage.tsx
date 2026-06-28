/**
 * HistoryPage — lists past audit records from the backend.
 *
 * Calls GET /api/audits on mount, renders a table of audit records with
 * filename, score, status, timestamp, and a "View" link to /audit/:id.
 *
 * LAYOUT BUDGET: page wrapper uses min-h-screen flex flex-col (matches
 * Dashboard + AuditPage pattern). No h-full inside grids, no min-h-screen
 * on inner containers. Scrollable list uses max-h-* with overflow-auto.
 */

import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
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
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import { api, TimeoutError } from '../services/api'
import { useToast } from '../hooks/useToast'
import type { AuditListItem } from '../types/api'

type LoadState = 'loading' | 'success' | 'error' | 'empty'

export function HistoryPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [audits, setAudits] = useState<AuditListItem[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AuditListItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchAudits = useCallback(async () => {
    setState('loading')
    setErrorMsg(null)
    try {
      const list = await api.listAudits(50, 0)
      setAudits(list)
      setState(list.length === 0 ? 'empty' : 'success')
    } catch (err: any) {
      const msg =
        err instanceof TimeoutError
          ? 'Request timed out. Is the backend running?'
          : err.message || 'Failed to load audit history.'
      setErrorMsg(msg)
      setState('error')
      showToast(msg, 'error')
    }
  }, [showToast])

  useEffect(() => {
    void fetchAudits()
  }, [fetchAudits])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchAudits()
    setRefreshing(false)
  }

  const handleDelete = async (audit: AuditListItem) => {
    setDeleting(true)
    try {
      await api.deleteAudit(audit.id)
      setAudits((prev) => prev.filter((a) => a.id !== audit.id))
      setDeleteTarget(null)
      showToast(`Deleted audit: ${audit.filename}`, 'success')
      // If we deleted the last audit, switch to empty state
      setAudits((prev) => {
        if (prev.length === 0) setState('empty')
        return prev
      })
    } catch (err: any) {
      const msg = err instanceof TimeoutError
        ? 'Request timed out. Is the backend running?'
        : err.message || 'Failed to delete audit.'
      showToast(`Delete failed. ${msg}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <AppNav
        current="history"
        title="Audit History"
        subtitle="Academic Compliance Auditor"
        backTo="/dashboard"
      />

      {/* ────────────────────────── Hero ────────────────────────── */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6 md:py-10">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="max-w-3xl text-2xl font-bold tracking-tight md:text-3xl">
                Audit History
              </h1>
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
                Every audit you run is persisted to the local SQLite database. Click any record to
                view its full violation breakdown, AI citation findings, and document metadata.
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
        </div>
      </section>

      {/* ────────────────────────── Main ────────────────────────── */}
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        {state === 'loading' && <LoadingSkeleton />}

        {state === 'error' && (
          <ErrorState
            message={errorMsg}
            onRetry={handleRefresh}
            onBackHome={() => navigate('/dashboard')}
          />
        )}

        {state === 'empty' && (
          <EmptyState onBackHome={() => navigate('/dashboard')} />
        )}

        {state === 'success' && (
          <HistoryTable
            audits={audits}
            onView={(id) => navigate(`/audit/${id}`)}
            onDelete={(a) => setDeleteTarget(a)}
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

      {/* ────────────────────────── Footer ────────────────────────── */}
      <AppFooter />
    </div>
  )
}

/* ----------------------------- History table ----------------------------- */

function HistoryTable({
  audits,
  onView,
  onDelete,
}: {
  audits: AuditListItem[]
  onView: (id: string) => void
  onDelete: (audit: AuditListItem) => void
}) {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-semibold">
              Past Audits ({audits.length})
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground">
              Most recent first · click any row to view the full detail report · trash icon to delete
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/* Table header (desktop only) */}
        <div className="hidden grid-cols-12 gap-3 border-b border-border bg-input/20 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
          <div className="col-span-5">Filename</div>
          <div className="col-span-2">Score</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Submitted</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        {/* Rows */}
        <ul className="divide-y divide-border">
          {audits.map((a) => (
            <li key={a.id} className="group">
              <div className="grid w-full grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-input/30 md:grid-cols-12 md:items-center md:gap-3">
                {/* Filename — clickable to view */}
                <button
                  type="button"
                  onClick={() => onView(a.id)}
                  className="col-span-5 flex min-w-0 items-center gap-2.5 text-left"
                >
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground hover:text-primary transition-colors">
                      {a.filename}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {a.id.slice(0, 8)}…
                    </div>
                  </div>
                </button>

                {/* Score — clickable to view */}
                <button
                  type="button"
                  onClick={() => onView(a.id)}
                  className="col-span-2 flex items-center gap-2 text-left"
                >
                  <ScoreBadge score={a.weighted_score} />
                  <span className="md:hidden text-xs text-muted-foreground">/ 100</span>
                </button>

                {/* Status */}
                <div className="col-span-2">
                  <StatusBadge status={a.status} />
                </div>

                {/* Timestamp */}
                <div className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{formatDate(a.created_at)}</span>
                </div>

                {/* Actions: View + Delete */}
                <div className="col-span-1 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onView(a.id)}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                    aria-label={`View ${a.filename}`}
                  >
                    View
                    <ArrowRight className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(a)}
                    className="inline-flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                    aria-label={`Delete ${a.filename}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Score badge ----------------------------- */

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 80
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : score >= 50
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : 'border-rose-500/30 bg-rose-500/10 text-rose-300'

  return (
    <Badge variant="outline" className={`font-mono text-sm font-semibold ${tone}`}>
      {score}
    </Badge>
  )
}

/* ----------------------------- Status badge ----------------------------- */

function StatusBadge({ status }: { status: string }) {
  if (status === 'processing') {
    return (
      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-300">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        Processing
      </Badge>
    )
  }
  if (status === 'completed') {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        Completed
      </Badge>
    )
  }
  if (status === 'failed') {
    return (
      <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300">
        <XCircle className="mr-1 h-3 w-3" />
        Failed
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-border text-muted-foreground">
      <span className="capitalize">{status}</span>
    </Badge>
  )
}

/* ----------------------------- Date formatter ----------------------------- */

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/* ----------------------------- Loading skeleton ----------------------------- */

function LoadingSkeleton() {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">Loading audit history…</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Fetching records from the local database.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
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
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Empty state ----------------------------- */

function EmptyState({ onBackHome }: { onBackHome: () => void }) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
          <History className="h-6 w-6" />
        </div>
        <div>
          <div className="text-base font-semibold text-foreground">No audit history yet</div>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            Run your first audit from the Dashboard to populate this page. Every audit you run
            is persisted to the local SQLite database and will appear here.
          </p>
        </div>
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onBackHome}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Go to Dashboard
        </Button>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Error state ----------------------------- */

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
    <Card className="border-rose-500/30 bg-rose-500/5">
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-md bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div>
          <div className="text-base font-semibold text-foreground">
            Could not load audit history
          </div>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {message ?? 'An unexpected error occurred.'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Make sure the FastAPI backend is running on the expected port and the database is
            initialised.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="border-border text-foreground"
            onClick={onRetry}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            onClick={onBackHome}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ----------------------------- Delete confirmation dialog ----------------------------- */

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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <Card
        className="w-full max-w-md border-rose-500/30 bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <CardContent className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30">
              <Trash2 className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-foreground">Delete this audit?</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                This will permanently delete the audit record and all its violations + citation
                issues from the database. This action cannot be undone.
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Audit summary */}
          <div className="rounded-md border border-border bg-input/20 px-3 py-2.5 space-y-1">
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-primary" />
              <span className="truncate text-sm font-medium text-foreground">{audit.filename}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono">{audit.id.slice(0, 8)}…</span>
              <span>Score: {audit.weighted_score}/100</span>
              <span>{formatDate(audit.created_at)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
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
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={onConfirm}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete audit
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
