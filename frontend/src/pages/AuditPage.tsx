import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useToast } from '../hooks/useToast'
import { ArrowLeft, CheckCircle, Loader2, ChevronDown, AlertTriangle, Info, Clock } from 'lucide-react'
import type { AuditResponse, Violation, CitationIssue } from '../types/api'

// Poll every 2s; give up after 5 minutes (150 attempts).
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 150

function relatedCitations(violation: Violation, citations: CitationIssue[]): CitationIssue[] {
  const paraIdx = (violation.location as any)?.paragraph_index
  if (typeof paraIdx !== 'number') return []
  return citations.filter(c => c.paragraph_index === paraIdx)
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
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  if (error || !audit) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-12 h-12 text-error mx-auto mb-4" />
          <p className="text-body-lg text-error mb-4">{error || 'Audit not found'}</p>
          <button onClick={() => navigate('/')} className="btn-primary">Back to Dashboard</button>
        </div>
      </div>
    )
  }

  const getScoreColor = (score: number) =>
    score >= 80 ? 'text-secondary' : score >= 50 ? 'text-amber-500' : 'text-error'

  const getSeverityBadge = (severity: string) =>
    severity === 'MAJOR'
      ? <span className="badge-error">Major</span>
      : <span className="badge-warning">Minor</span>

  const isProcessing = audit.status === 'processing'

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={() => navigate('/')} className="btn-ghost p-2">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-headline-lg font-bold text-on-surface">Audit Results</h1>
            <p className="text-body-md text-on-surface-variant flex items-center gap-2">
              {audit.filename}
              <span className="text-outline">•</span>
              {isProcessing ? (
                <span className="inline-flex items-center gap-1 text-primary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing
                </span>
              ) : (
                <span className="capitalize">{audit.status}</span>
              )}
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="card-elevated p-6">
              <h2 className="text-headline-md font-semibold text-on-surface mb-4">Compliance Score</h2>
              <div className="flex items-center gap-6">
                <div className="relative w-32 h-32 flex-shrink-0">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="none" className="text-surface-container-highest" />
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
                  <p className="text-body-md text-on-surface-variant mb-4">
                    Weighted compliance score based on layout violations. Major violations deduct more heavily than minor ones.
                  </p>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-error" /> Major</span>
                    <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-500" /> Minor</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="card-elevated">
              <h2 className="text-headline-md font-semibold text-on-surface p-4 border-b border-outline-variant">
                Layout Violations ({audit.violations.length})
              </h2>
              {audit.violations.length === 0 ? (
                <div className="p-8 text-center text-on-surface-variant">
                  <CheckCircle className="w-12 h-12 text-secondary mx-auto mb-3" />
                  <p className="text-body-md">No layout violations found. Great job!</p>
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {audit.violations.map((v) => {
                    const expanded = expandedViolations.has(v.id)
                    const fixes = relatedCitations(v, audit.citation_issues)
                    return (
                      <div
                        key={v.id}
                        className="bg-surface-container-low rounded-lg border border-outline-variant overflow-hidden"
                      >
                        <button
                          onClick={() => toggleViolation(v.id)}
                          aria-expanded={expanded}
                          className="w-full p-3 flex items-center gap-3 text-left hover:bg-surface-container transition-colors"
                        >
                          {getSeverityBadge(v.severity)}
                          <span className="font-mono text-code-sm text-on-surface-variant">{v.rule_code}</span>
                          <span className="text-body-md text-on-surface truncate flex-1">{v.message}</span>
                          <ChevronDown
                            className={`w-5 h-5 text-on-surface-variant transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {expanded && (
                          <div className="px-3 pb-3 pt-3 border-t border-outline-variant bg-surface-container-lowest animate-slide-down space-y-3">
                            <div className="grid gap-3 sm:grid-cols-2 text-sm">
                              <div>
                                <p className="text-label-md text-on-surface-variant">Expected</p>
                                <p className="font-mono text-code-sm text-on-surface break-words">
                                  {v.expected_value || '—'}
                                </p>
                              </div>
                              <div>
                                <p className="text-label-md text-on-surface-variant">Actual</p>
                                <p className="font-mono text-code-sm text-on-surface break-words">
                                  {v.actual_value || '—'}
                                </p>
                              </div>
                              <div className="sm:col-span-2">
                                <p className="text-label-md text-on-surface-variant">Location</p>
                                <pre className="font-mono text-code-sm text-on-surface-variant bg-surface p-2 rounded overflow-x-auto">
                                  {JSON.stringify(v.location, null, 2)}
                                </pre>
                              </div>
                            </div>

                            {fixes.length > 0 && (
                              <div className="border-t border-outline-variant pt-3">
                                <p className="text-label-md text-primary uppercase mb-2 flex items-center gap-1.5">
                                  <Info className="w-4 h-4" /> AI Fix Suggestion
                                </p>
                                <div className="space-y-2">
                                  {fixes.map(fix => (
                                    <div key={fix.id} className="p-2.5 bg-primary/5 border border-primary/20 rounded text-sm">
                                      <p className="text-on-surface">{fix.message}</p>
                                      {fix.suggestion && (
                                        <p className="text-on-surface-variant mt-1 italic">
                                          → {fix.suggestion}
                                        </p>
                                      )}
                                      {typeof fix.confidence === 'number' && (
                                        <p className="text-label-md text-on-surface-variant mt-1">
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
            </div>
          </div>

          <div className="space-y-6">
            <div className="card-elevated p-4">
              <h3 className="text-label-md text-on-surface-variant uppercase mb-3">Document Info</h3>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-on-surface-variant">Filename</dt>
                  <dd className="text-on-surface font-mono text-code-sm break-all text-right">{audit.filename}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-on-surface-variant">Size</dt>
                  <dd className="text-on-surface">{(audit.file_size / 1024).toFixed(1)} KB</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-on-surface-variant">Mode</dt>
                  <dd className="text-on-surface">{audit.deploy_mode}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-on-surface-variant">Status</dt>
                  <dd className="text-on-surface capitalize">{audit.status}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-on-surface-variant">Submitted</dt>
                  <dd className="text-on-surface">{new Date(audit.created_at).toLocaleString()}</dd>
                </div>
                {isProcessing && (
                  <div className="flex justify-between text-on-surface-variant">
                    <dt className="inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> Poll
                    </dt>
                    <dd className="font-mono">{pollAttempts}/{POLL_MAX_ATTEMPTS}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="card-elevated p-4">
              <h3 className="text-label-md text-on-surface-variant uppercase mb-3">AI Citation Check</h3>
              {isProcessing ? (
                <div className="flex items-center gap-3 text-on-surface-variant">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <span>Analyzing citations...</span>
                </div>
              ) : audit.citation_issues.length === 0 ? (
                <div className="text-center text-on-surface-variant py-4">
                  <CheckCircle className="w-10 h-10 text-secondary mx-auto mb-2" />
                  <p className="text-body-md">No citation issues detected</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {audit.citation_issues.map((issue) => (
                    <div key={issue.id} className="p-3 bg-surface-container-low rounded-lg border border-outline-variant">
                      <div className="flex items-start gap-2">
                        <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-body-md text-on-surface">{issue.message}</p>
                          {issue.suggestion && (
                            <p className="text-body-md text-on-surface-variant mt-1">→ {issue.suggestion}</p>
                          )}
                          <p className="text-label-md text-on-surface-variant mt-2">
                            Para {issue.paragraph_index + 1} • {issue.issue_type}
                            {typeof issue.confidence === 'number' && ` • ${Math.round(issue.confidence * 100)}% confidence`}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isProcessing && (
              <div className="card-elevated p-4 border-l-4 border-l-primary">
                <div className="flex items-start gap-3">
                  <Loader2 className="w-5 h-5 animate-spin text-primary flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="text-on-surface font-medium">AI citation analysis in progress</p>
                    <p className="text-on-surface-variant mt-1">
                      Layout checks complete. Citations are being processed in the background.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}