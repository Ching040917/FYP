import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useToast } from '../hooks/useToast'
import { ArrowLeft, CheckCircle, Loader2, ChevronDown, AlertTriangle, Info, Clock } from 'lucide-react'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import type { AuditResponse, Violation, CitationIssue } from '../types/api'

// Poll every 2s; give up after 5 minutes (150 attempts).
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 150

function relatedCitations(violation: Violation, citations: CitationIssue[]): CitationIssue[] {
  const paraIdx = (violation.location as any)?.paragraph_index
  if (typeof paraIdx !== 'number') return []
  return citations.filter(c => c.paragraph_index === paraIdx)
}

function getSeverityBadge(severity: string) {
  return severity === 'MAJOR'
    ? <Badge variant="destructive">Major</Badge>
    : <Badge variant="secondary">Minor</Badge>
}

function getScoreColor(score: number) {
  return score >= 80 ? 'text-secondary' : score >= 50 ? 'text-amber-500' : 'text-error'
}

export function AuditPage() {
  const { auditId } = useParams<{ auditId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [audit, setAudit] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, setPolling] = useState(false)
  const [pollAttempts, setPollAttempts] = useState(0)
  const [expandedViolations, setExpandedViolations] = useState<Set<string>>(new Set())

  // Refs guard against stale closures in setInterval + double-fire under StrictMode.
  const attemptsRef = useRef(0)
  const pollingRef = useRef(false)
  const inFlightRef = useRef(false)

  const fetchAudit = useCallback(async () => {
    if (!auditId || inFlightRef.current) return
    inFlightRef.current = true
    try {
      const data = await api.getAudit(auditId)
      setAudit(data)
      if (data.status === 'processing') {
        pollingRef.current = true
        setPolling(true)
        attemptsRef.current += 1
        setPollAttempts(attemptsRef.current)
      } else {
        pollingRef.current = false
        setPolling(false)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load audit')
      pollingRef.current = false
      setPolling(false)
      showToast(err.message || 'Failed to load audit', 'error')
    } finally {
      setLoading(false)
      inFlightRef.current = false
    }
  }, [auditId, showToast])

  // Initial fetch + polling lifecycle.
  useEffect(() => {
    if (!auditId) return
    attemptsRef.current = 0
    pollingRef.current = false
    setPollAttempts(0)

    fetchAudit()
    const interval = setInterval(() => {
      if (!pollingRef.current) return
      if (attemptsRef.current >= POLL_MAX_ATTEMPTS) {
        pollingRef.current = false
        setPolling(false)
        const msg = 'Audit is taking longer than expected. Please refresh or try again later.'
        setError(msg)
        showToast(msg, 'error')
        return
      }
      fetchAudit()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [auditId, fetchAudit, showToast])

  const toggleViolation = (id: string) => {
    setExpandedViolations(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
                <CheckCircle className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">Audit Results</div>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </main>
      </div>
    )
  }

  if (error || !audit) {
    return (
      <div className="min-h-screen flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
                <CheckCircle className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">Audit Results</div>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-error mx-auto mb-4" />
            <p className="text-body-lg text-error mb-4">{error || 'Audit not found'}</p>
            <Button onClick={() => navigate('/')}>Back to Dashboard</Button>
          </div>
        </main>
      </div>
    )
  }

  const isProcessing = audit.status === 'processing'

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Sticky header */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => navigate('/')}
              aria-label="Back to Dashboard"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
                <CheckCircle className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-semibold tracking-tight">Audit Results</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {audit.filename}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-border text-muted-foreground">
              {isProcessing ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Processing
                </>
              ) : (
                <span className="capitalize">{audit.status}</span>
              )}
            </Badge>
            <Badge variant="outline" className="border-border text-muted-foreground">
              {audit.deploy_mode}
            </Badge>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold tracking-tight md:text-2xl">
                Compliance Score: <span className={`${getScoreColor(audit.weighted_score)} font-mono`}>{audit.weighted_score}</span> / 100
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Weighted score based on layout violations. Major violations deduct more heavily.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="border-error/30 bg-error/10 text-error">
                {audit.violations.filter(v => v.severity === 'MAJOR').length} Major
              </Badge>
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-500">
                {audit.violations.filter(v => v.severity === 'MINOR').length} Minor
              </Badge>
            </div>
          </div>
        </div>
      </section>

      {/* Main content */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-6 md:py-8">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold">Compliance Score</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-6">
                  <div className="relative w-32 h-32 flex-shrink-0">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none" className="text-border" />
                      <circle
                        cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8"
                        strokeDasharray={352}
                        strokeDashoffset={352 - (352 * audit.weighted_score) / 100}
                        strokeLinecap="round" fill="none"
                        className={getScoreColor(audit.weighted_score)}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className={`text-headline-xl font-bold ${getScoreColor(audit.weighted_score)}`}>
                        {audit.weighted_score}
                      </span>
                    </div>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground mb-4">
                      Weighted compliance score based on layout violations. Major violations deduct more heavily than minor ones.
                    </p>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-error" /> Major</span>
                      <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-500" /> Minor</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold">
                  Layout Violations ({audit.violations.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {audit.violations.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    <CheckCircle className="w-12 h-12 text-secondary mx-auto mb-3" />
                    <p className="text-base">No layout violations found. Great job!</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {audit.violations.map((v) => {
                      const expanded = expandedViolations.has(v.id)
                      const fixes = relatedCitations(v, audit.citation_issues)
                      return (
                        <div
                          key={v.id}
                          className="bg-muted/40 rounded-lg border border-border overflow-hidden"
                        >
                          <button
                            onClick={() => toggleViolation(v.id)}
                            aria-expanded={expanded}
                            className="w-full p-3 flex items-center gap-3 text-left hover:bg-muted transition-colors"
                          >
                            {getSeverityBadge(v.severity)}
                            <span className="font-mono text-xs text-muted-foreground">{v.rule_code}</span>
                            <span className="text-sm text-foreground truncate flex-1">{v.message}</span>
                            <ChevronDown
                              className={`w-5 h-5 text-muted-foreground transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
                            />
                          </button>
                          {expanded && (
                            <div className="px-3 pb-3 pt-3 border-t border-border bg-muted/20 animate-slide-down space-y-3">
                              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                                <div>
                                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Expected</p>
                                  <p className="font-mono text-xs text-foreground break-words">
                                    {v.expected_value || '—'}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Actual</p>
                                  <p className="font-mono text-xs text-foreground break-words">
                                    {v.actual_value || '—'}
                                  </p>
                                </div>
                                <div className="sm:col-span-2">
                                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Location</p>
                                  <pre className="font-mono text-xs text-muted-foreground bg-muted p-2 rounded overflow-x-auto">
                                    {JSON.stringify(v.location, null, 2)}
                                  </pre>
                                </div>
                              </div>

                              {fixes.length > 0 && (
                                <div className="border-t border-border pt-3">
                                  <p className="text-xs text-primary uppercase tracking-wide mb-2 flex items-center gap-1.5">
                                    <Info className="w-3.5 h-3.5" /> AI Fix Suggestion
                                  </p>
                                  <div className="space-y-2">
                                    {fixes.map(fix => (
                                      <div key={fix.id} className="p-2.5 bg-primary/5 border border-primary/20 rounded text-sm">
                                        <p className="text-foreground">{fix.message}</p>
                                        {fix.suggestion && (
                                          <p className="text-muted-foreground mt-1 italic">
                                            → {fix.suggestion}
                                          </p>
                                        )}
                                        {typeof fix.confidence === 'number' && (
                                          <p className="text-xs text-muted-foreground mt-1">
                                            {Math.round(fix.confidence * 100)}% confidence
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Document Info</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Filename</dt>
                    <dd className="text-foreground font-mono text-xs break-all text-right">{audit.filename}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Size</dt>
                    <dd className="text-foreground">{(audit.file_size / 1024).toFixed(1)} KB</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Mode</dt>
                    <dd className="text-foreground">{audit.deploy_mode}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd className="text-foreground capitalize">{audit.status}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Submitted</dt>
                    <dd className="text-foreground">{new Date(audit.created_at).toLocaleString()}</dd>
                  </div>
                  {isProcessing && (
                    <div className="flex justify-between text-muted-foreground">
                      <dt className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" /> Poll
                      </dt>
                      <dd className="font-mono">{pollAttempts}/{POLL_MAX_ATTEMPTS}</dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>

            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">AI Citation Check</CardTitle>
              </CardHeader>
              <CardContent>
                {isProcessing ? (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    <span>Analyzing citations...</span>
                  </div>
                ) : audit.citation_issues.length === 0 ? (
                  <div className="text-center text-muted-foreground py-4">
                    <CheckCircle className="w-10 h-10 text-secondary mx-auto mb-2" />
                    <p className="text-base">No citation issues detected</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {audit.citation_issues.map((issue) => (
                      <div key={issue.id} className="p-3 bg-muted/40 rounded-lg border border-border">
                        <div className="flex items-start gap-2">
                          <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground">{issue.message}</p>
                            {issue.suggestion && (
                              <p className="text-sm text-muted-foreground mt-1">→ {issue.suggestion}</p>
                            )}
                            <p className="text-xs text-muted-foreground mt-2">
                              Para {issue.paragraph_index + 1} • {issue.issue_type}
                              {typeof issue.confidence === 'number' && ` • ${Math.round(issue.confidence * 100)}% confidence`}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {isProcessing && (
              <Card className="border-border bg-card border-l-4 border-l-primary">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-primary flex-shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="text-foreground font-medium">AI citation analysis in progress</p>
                      <p className="text-muted-foreground mt-1">
                        Layout checks complete. Citations are being processed in the background.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border bg-background/60">
        <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">
          <div className="flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <span>Auditra · Read-only formatting checker.</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}