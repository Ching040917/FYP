/**
 * Compliance summary — the Dashboard's concise completed-audit summary
 * (Build 4). Replaces the old ScoreDashboard (radar, bar charts, rings).
 *
 * Full evidence (findings, expected vs actual, guidance, AI suggestions)
 * lives in the Audit Workspace (/audit/:id) — this component deliberately
 * does not duplicate it. Scoring is never recalculated: the backend's
 * weighted score, counts, and per-category breakdown are shown as-is.
 */

import { useNavigate } from 'react-router-dom'
import { ArrowRight, ClipboardCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { Button } from '../ui/button'
import { VerdictChecklist } from './verdict-checklist'
import { aiProviderLabel } from '../../lib/audit/adapter'
import { gradeFor } from '../../lib/audit/scoring'
import type { AuditResult, DocumentStats } from '../../types/audit'

const STAT_LABELS: Array<[keyof DocumentStats, string]> = [
  ['paragraphs', 'Paragraphs'],
  ['headings', 'Headings'],
  ['tables', 'Tables'],
  ['images', 'Images'],
  ['sections', 'Sections'],
  ['words', 'Words'],
]

export function ComplianceSummary({
  result,
}: {
  result: AuditResult
}) {
  const navigate = useNavigate()
  const grade = gradeFor(result.weighted_compliance_score)
  const majorCount = result.major_count ?? 0
  const minorCount = result.minor_count ?? 0
  const hasFindings = majorCount + minorCount > 0
  const auditId = result.audit_id

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          Compliance summary
        </CardTitle>
        <CardDescription>
          Audit complete · {new Date(result.audited_at).toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* One authoritative score */}
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Compliance score
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-section-title text-foreground">
                {result.weighted_compliance_score}
              </span>
              <span className="text-[13px] text-muted-foreground">/100</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Grade
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground">
              {grade.grade} · {grade.label}
            </div>
          </div>
        </div>

        <p className="text-[13px] text-muted-foreground">
          {majorCount} major findings · {minorCount} minor findings
        </p>

        <VerdictChecklist breakdown={result.score_breakdown} showDerivedNote />

        <DocStats stats={result.document_stats} />

        {aiSummaryLine(result) && (
          <p className="text-[13px] leading-[19px] text-muted-foreground">{aiSummaryLine(result)}</p>
        )}

        {!hasFindings && (
          <p className="rounded-md border border-border bg-input/20 px-3 py-2 text-[13px] leading-[19px] text-muted-foreground">
            No supported compliance findings were detected in this document. This does not
            certify the document as academically correct in all respects.
          </p>
        )}

        {auditId ? (
          <Button
            type="button"
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => navigate(`/audit/${auditId}`)}
          >
            Open full audit report
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            The full report link is unavailable for this audit record.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Concise, truthful AI-review status line for the Dashboard summary.
 * Returns null when the status is unknown/unrecorded so no guessing line
 * is ever shown (full detail lives in the audit report).
 */
function aiSummaryLine(result: AuditResult): string | null {
  const status = result.ai_review_status
  const provider = aiProviderLabel(result.ai_provider)
  if (status === 'COMPLETED_WITH_SUGGESTIONS') {
    return `Optional AI-assisted citation review (${provider}) completed; suggestions are available in the full audit report.`
  }
  if (status === 'COMPLETED_NO_SUGGESTIONS') {
    return `Optional AI-assisted citation review (${provider}) completed with no additional suggestions.`
  }
  if (status === 'UNAVAILABLE') {
    return 'Optional AI-assisted citation review was unavailable; deterministic results are unaffected.'
  }
  return null
}

function DocStats({ stats }: { stats: DocumentStats }) {  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Document statistics
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {STAT_LABELS.map(([key, label]) => (
          <div
            key={key}
            className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1"
          >
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="font-mono text-[13px] text-foreground">{stats[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
