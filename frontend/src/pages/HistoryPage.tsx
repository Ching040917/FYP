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
  ShieldCheck,
  Lock,
  Cloud,
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

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ────────────────────────── Header ────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => navigate('/dashboard')}
              aria-label="Back to Dashboard"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
                <History className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">Audit History</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Academic Compliance Auditor
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-border text-muted-foreground"
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
      </header>

      {/* ────────────────────────── Hero ────────────────────────── */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6 md:py-10">
          <h1 className="max-w-3xl text-2xl font-bold tracking-tight md:text-3xl">
            Audit History
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
            Every audit you run is persisted to the local SQLite database. Click any record to
            view its full violation breakdown, AI citation findings, and document metadata.
          </p>
        </div>
      </section>

      {/* ────────────────────────── Main ────────────────────────── */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-6 md:py-8">
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
          <HistoryTable audits={audits} onView={(id) => navigate(`/audit/${id}`)} />
        )}
      </main>

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

/* ----------------------------- History table ----------------------------- */

function HistoryTable({
  audits,
  onView,
}: {
  audits: AuditListItem[]
  onView: (id: string) => void
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
              Most recent first · click any row to view the full detail report
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
          <div className="col-span-1 text-right">Action</div>
        </div>

        {/* Rows */}
        <ul className="divide-y divide-border">
          {audits.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onView(a.id)}
                className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left transition-colors hover:bg-input/30 md:grid-cols-12 md:items-center md:gap-3"
              >
                {/* Filename */}
                <div className="col-span-5 flex min-w-0 items-center gap-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {a.filename}
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {a.id.slice(0, 8)}…
                    </div>
                  </div>
                </div>

                {/* Score */}
                <div className="col-span-2 flex items-center gap-2">
                  <ScoreBadge score={a.weighted_score} />
                  <span className="md:hidden text-xs text-muted-foreground">/ 100</span>
                </div>

                {/* Status */}
                <div className="col-span-2">
                  <StatusBadge status={a.status} />
                </div>

                {/* Timestamp */}
                <div className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{formatDate(a.created_at)}</span>
                </div>

                {/* Action */}
                <div className="col-span-1 flex justify-end">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    View
                    <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </button>
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
