import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useToast } from '../hooks/useToast'
import { CheckCircle2, ChevronDown, Clock, Info, Loader2, MapPin, Quote, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import { ErrorList } from '../components/audit/error-list'
import { VerdictChecklist } from '../components/audit/verdict-checklist'
import { FindingDetail } from '../components/audit/finding-detail'
import { DocumentPreview } from '../components/audit/document-preview'
import { categoryForRuleCode, humanizeRuleCode, aiProviderLabel, normalizeAiProvider } from '../lib/audit/adapter'
import { gradeFor } from '../lib/audit/scoring'
import type { AuditDocumentStats, AuditResponse, DocumentBlock, Violation } from '../types/api'
import type { LayoutError } from '../types/audit'

// Poll every 2s; give up after 5 minutes (150 attempts).
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 150

function toLayoutError(v: Violation): LayoutError {
  const loc = (v.location ?? {}) as Record<string, unknown>
  const paragraphIndex = typeof loc.paragraph_index === 'number' ? loc.paragraph_index : -1
  const position = paragraphIndex >= 0 ? paragraphIndex + 1 : 0
  return {
    id: v.id,
    category: categoryForRuleCode(v.rule_code),
    severity: v.severity === 'MAJOR' ? 'major' : 'minor',
    position,
    title: humanizeRuleCode(v.rule_code),
    detail: v.message,
    suggestion: v.expected_value ?? v.actual_value ?? 'No automatic fix available — review manually.',
    snippet: (v.actual_value ?? '').toString().slice(0, 140) || undefined,
  }
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
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Document preview state — loaded once after audit is available.
  const [blocks, setBlocks] = useState<DocumentBlock[] | null>(null)
  const [blocksLoading, setBlocksLoading] = useState(false)
  const [blocksError, setBlocksError] = useState(false)
  const blocksFetchedRef = useRef(false)

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

  // Preselect the first finding once a completed audit arrives.
  useEffect(() => {
    if (!audit || audit.status !== 'completed') return
    if (selectedId === null && audit.violations.length > 0) {
      setSelectedId(audit.violations[0].id)
    }
  }, [audit, selectedId])

  // Load document blocks once the audit is available.
  useEffect(() => {
    if (!auditId || !audit || audit.status !== 'completed' || blocksFetchedRef.current) return
    blocksFetchedRef.current = true
    setBlocksLoading(true)
    api.getDocumentBlocks(auditId)
      .then((data) => setBlocks(data.blocks))
      .catch(() => {
        setBlocks(null)
        setBlocksError(true)
      })
      .finally(() => setBlocksLoading(false))
  }, [auditId, audit])

  const isProcessing = audit?.status === 'processing'
  const violations = audit?.violations ?? []
  const mappedErrors = violations.map(toLayoutError)
  const selectedViolation = violations.find((v) => v.id === selectedId) ?? null
  const grade = audit ? gradeFor(audit.weighted_score) : null

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#audit-report">
        Skip to audit report
      </a>
      <AppNav
        current="audit"
        title="Audit Report"
        subtitle={audit?.filename ?? 'Academic Compliance Auditor'}
        backTo="/dashboard"
      />

      <main id="audit-report" className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        {loading ? (
          <LoadingState />
        ) : error || !audit ? (
          <ErrorState error={error} onBack={() => navigate('/dashboard')} />
        ) : (
          <>
            {/* ────────────── Report header ────────────── */}
            <section className="border-b border-border pb-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="font-serif text-page-title leading-[34px] text-foreground">
                    {audit.filename}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
                    <StatusBadge status={audit.status} />
                    {audit.created_at && (
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        {new Date(audit.created_at).toLocaleString()}
                      </span>
                    )}
                    {audit.status === 'completed' && (
                      <span>
                        {audit.major_count ?? 0} major · {audit.minor_count ?? 0} minor findings
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Compliance score
                  </div>
                  <div className="mt-1 flex items-baseline justify-end gap-1.5">
                    <span className="font-mono text-section-title text-foreground">
                      {audit.weighted_score}
                    </span>
                    <span className="text-[13px] text-muted-foreground">/100</span>
                  </div>
                  {grade && (
                    <div className="mt-0.5 text-[13px] text-muted-foreground">
                      {grade.label} · grade {grade.grade}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {isProcessing && <ProcessingBanner pollAttempts={pollAttempts} />}
            {audit.status === 'failed' && <FailedBanner />}

            {/* ────────────── Workspace ────────────── */}
            <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[9fr_16fr] xl:grid-cols-[2fr_3fr]">
              {/* Master pane — verdicts + findings */}
              <div className="min-w-0 space-y-6">
                <VerdictChecklist breakdown={audit.score_breakdown ?? []} />
                {audit.status === 'completed' && violations.length === 0 ? (
                  <NoFindingsState />
                ) : (
                  <ErrorList
                    result={{ physical_layout_errors: mappedErrors }}
                    selectedId={selectedId}
                    onSelect={(e) => setSelectedId(e.id)}
                  />
                )}
              </div>

              {/* Detail pane — preview, evidence, secondary sections */}
              <div className="min-w-0 space-y-6">
                <DocumentPreview
                  blocks={blocks}
                  violations={audit.violations}
                  selectedViolationId={selectedId}
                  isLoading={blocksLoading}
                  loadError={blocksError}
                  onSelectViolation={setSelectedId}
                />
                {selectedViolation && (
                  <a
                    href="#finding-detail"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline lg:hidden"
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    Continue to finding detail
                  </a>
                )}
                <FindingDetail violation={selectedViolation} />
                <CitationSection
                  audit={audit}
                  isProcessing={isProcessing}
                  selectedViolation={selectedViolation}
                />
                <DocStats stats={audit.document_stats} />
              </div>
            </div>
          </>
        )}
      </main>

      <AppFooter />
    </div>
  )
}

/* ----------------------------- Report header pieces ----------------------------- */

function StatusBadge({ status }: { status: string }) {
  if (status === 'processing') {
    return (
      <Badge variant="outline" className="border-information/40 bg-information/10 text-information">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Processing
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
  return (
    <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
      <XCircle className="mr-1 h-3 w-3" /> Failed
    </Badge>
  )
}

/* ----------------------------- Page states ----------------------------- */

function LoadingState() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <div className="h-6 w-1/3 rounded bg-muted animate-pulse" />
      <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[9fr_16fr] xl:grid-cols-[2fr_3fr]">
        <div className="space-y-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 rounded bg-muted animate-pulse" />
          ))}
        </div>
        <div className="space-y-4">
          <div className="h-6 w-1/2 rounded bg-muted animate-pulse" />
          <div className="h-40 rounded bg-muted animate-pulse" />
          <div className="h-24 rounded bg-muted animate-pulse" />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ error, onBack }: { error: string | null; onBack: () => void }) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm text-foreground">{error || 'Audit not found'}</p>
      <Button onClick={onBack} variant="outline" className="mt-4 border-border">
        Back to Dashboard
      </Button>
    </div>
  )
}

function ProcessingBanner({ pollAttempts }: { pollAttempts: number }) {
  return (
    <section className="mt-6 rounded-md border border-border bg-input/20 px-4 py-3">
      <div className="flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-information" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">Audit in progress</p>
          <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">
            Layout checks are complete. Citations are being processed in the background — the
            report updates as checks finish. Poll attempt {pollAttempts}/{POLL_MAX_ATTEMPTS}.
          </p>
        </div>
      </div>
    </section>
  )
}

function FailedBanner() {
  return (
    <section className="mt-6 rounded-md border border-border bg-input/20 px-4 py-3">
      <div className="flex items-start gap-3">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">Audit did not complete</p>
          <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">
            This audit failed partway through. Findings shown below, if any, may be incomplete.
            Re-run the audit to get a fresh result.
          </p>
        </div>
      </div>
    </section>
  )
}

function NoFindingsState() {
  return (
    <section className="rounded-md border border-border px-4 py-6">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <h2 className="text-component-title text-foreground">No supported findings detected</h2>
          <p className="mt-1 text-sm leading-[21px] text-muted-foreground">
            This audit detected no supported compliance violations in the document. It does not
            certify the document as academically correct in all respects.
          </p>
        </div>
      </div>
    </section>
  )
}

/* ----------------------------- Secondary sections ----------------------------- */

function getParagraphIndex(v: Violation | null): number | null {
  if (!v) return null
  const loc = v.location as Record<string, unknown> | null
  const n = loc?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

function CitationSection({
  audit,
  isProcessing,
  selectedViolation,
}: {
  audit: AuditResponse
  isProcessing: boolean
  selectedViolation: Violation | null
}) {
  const issues = audit.citation_issues ?? []
  const status = audit.ai_review_status ?? null
  const provider = normalizeAiProvider(audit.ai_provider)

  // Guidance is shown only for the deterministic citation finding that is
  // currently selected. Matching uses persisted stable data — paragraph
  // index plus the exact deterministic message — never display order or
  // text search. Same-paragraph findings therefore stay distinct.
  const selectedPara = getParagraphIndex(selectedViolation)
  const isCitationSelected =
    selectedViolation !== null &&
    selectedViolation.rule_code === 'CITATION_MISMATCH' &&
    selectedPara !== null
  const matchedIssue =
    isCitationSelected && selectedViolation
      ? (issues.find(
          (i) => i.paragraph_index === selectedPara && i.message === selectedViolation.message,
        ) ?? null)
      : null

  let body: ReactNode
  if (isProcessing) {
    body = (
      <p className="mt-2 flex items-center gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-information" aria-hidden="true" />
        Citation review in progress — guidance appears when complete.
      </p>
    )
  } else if (!selectedViolation) {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Select a citation finding from the findings list to see AI-assisted guidance.
      </p>
    )
  } else if (!isCitationSelected) {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        This finding was verified by deterministic checks. AI-assisted guidance is available for
        citation findings — select one from the list to see it.
      </p>
    )
  } else if (matchedIssue) {
    body = (
      <>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-[19px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Paragraph {selectedPara + 1}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-ai-assisted" aria-hidden="true" />
            Human verification required
          </span>
        </div>
        {matchedIssue.text_snippet && (
          <blockquote className="mt-2 rounded border-l-2 border-ai-assisted/40 bg-ai-assisted/5 px-3 py-2 font-serif text-[13px] leading-[19px] text-foreground">
            “{matchedIssue.text_snippet}”
          </blockquote>
        )}
        <p className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 text-[13px] leading-[21px] text-foreground">
          {matchedIssue.suggestion}
        </p>
        <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Completed via {aiProviderLabel(provider)}. Guidance is AI-assisted and requires human
          verification of the source details.
        </p>
        {status === null && (
          <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            AI review status was not recorded for this audit.
          </p>
        )}
      </>
    )
  } else {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {status === 'UNAVAILABLE' ? (
          <>
            AI-assisted guidance was unavailable for this citation finding. Deterministic
            citation findings remain valid.
          </>
        ) : (
          <>No AI-assisted guidance is stored for this citation finding.</>
        )}
      </p>
    )
  }

  return (
    <section aria-label="AI-assisted citation guidance" className="border-t border-border pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-component-title text-foreground">
          {matchedIssue
            ? 'AI-assisted guidance for Citation Mismatch'
            : 'AI-assisted guidance'}
        </h3>
        <Badge variant="outline" className="border-ai-assisted/40 bg-ai-assisted/10 text-ai-assisted">
          <Quote className="mr-1 h-3 w-3" aria-hidden="true" /> AI-assisted
        </Badge>
      </div>
      {body}
    </section>
  )
}

const STAT_LABELS: Array<[keyof AuditDocumentStats, string]> = [
  ['paragraphs', 'Paragraphs'],
  ['headings', 'Headings'],
  ['tables', 'Tables'],
  ['images', 'Images'],
  ['sections', 'Sections'],
  ['words', 'Words'],
]

function DocStats({ stats }: { stats?: AuditDocumentStats | null }) {
  if (!stats) return null
  const rows = STAT_LABELS.filter(([key]) => stats[key] != null)
  if (rows.length === 0) return null

  return (
    <section aria-label="Document statistics" className="border-t border-border pt-5">
      <h3 className="text-component-title text-foreground">Document statistics</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {rows.map(([key, label]) => (
          <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
            <dd className="font-mono text-[13px] text-foreground">{stats[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
