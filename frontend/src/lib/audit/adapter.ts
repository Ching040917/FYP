/**
 * Adapter: backend wire shape (AuditSubmitResponse) → reference AuditResult.
 *
 * The backend exposes a flat Violation shape (rule_code, severity, location,
 * message, expected_value, actual_value) and a flat CitationIssue shape
 * (paragraph_index, text_snippet, issue_type, message, suggestion,
 * confidence). The reference Dashboard components consume a richer
 * LayoutError / CitationTip schema. This file is the single boundary that
 * keeps the two contract changes isolated.
 *
 * Backend is intentionally NOT touched — per the engine-protection rule.
 */

import type { AuditCategory, AuditResult, CitationTip, LayoutError } from '../../types/audit'
import type { AuditSubmitResponse, CitationIssue, Violation } from '../../types/api'
import type { DocumentStats } from '../../types/audit'
import { calculateWeightedScore } from './scoring'

/** Map backend rule_code to reference AuditCategory. Default = paragraph_typography. */
export function categoryForRuleCode(ruleCode: string): AuditCategory {
  const code = ruleCode.toUpperCase()
  if (code.includes('CITATION') || code.includes('APA')) return 'citation_apa'
  if (code.includes('MARGIN') || code.includes('PAGE_')) return 'page_margins'
  if (code.includes('HEADING') || code.includes('HIERARCHY')) return 'heading_hierarchy'
  if (code.includes('CAPTION') || code.includes('MEDIA') || code.includes('IMAGE')) return 'media_captions'
  if (code.includes('FONT_SIZE') || code.includes('SIZE_')) return 'font_size'
  if (code.includes('FONT')) return 'font_consistency'
  if (code.includes('PARAGRAPH') || code.includes('LINE') || code.includes('SPACING') || code.includes('ALIGN')) {
    return 'paragraph_typography'
  }
  return 'paragraph_typography'
}

/** Convert SHOUTY_SNAKE_CASE to Title Case for human display. */
export function humanizeRuleCode(ruleCode: string): string {
  return ruleCode
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function adaptViolation(v: Violation): LayoutError {
  const loc = (v.location ?? {}) as Record<string, unknown>
  const paragraphIndex = typeof loc.paragraph_index === 'number' ? loc.paragraph_index : -1
  const position = paragraphIndex >= 0 ? paragraphIndex + 1 : 0
  const snippet = (v.actual_value ?? '').toString().slice(0, 140) || undefined
  const suggestion =
    v.expected_value ??
    v.actual_value ??
    'No automatic fix available — review manually.'

  return {
    id: v.id,
    category: categoryForRuleCode(v.rule_code),
    severity: v.severity === 'MAJOR' ? 'major' : 'minor',
    position,
    title: humanizeRuleCode(v.rule_code),
    detail: v.message,
    suggestion,
    snippet,
  }
}

function adaptCitation(c: CitationIssue): CitationTip {
  const position = c.paragraph_index >= 0 ? c.paragraph_index + 1 : 0
  let confidence: 'high' | 'medium' | 'low' = 'low'
  if (typeof c.confidence === 'number') {
    if (c.confidence >= 0.7) confidence = 'high'
    else if (c.confidence >= 0.4) confidence = 'medium'
  }
  return {
    position,
    text: c.text_snippet,
    issue: c.message,
    fix: c.suggestion ?? 'Re-check APA 7 format manually.',
    confidence,
  }
}

export interface AdaptInput {
  raw: AuditSubmitResponse
  documentStats: DocumentStats
  auditedAt?: string
  cloudEnabled: boolean
}

export function adaptAuditResponse(input: AdaptInput): AuditResult {
  const { raw, documentStats, auditedAt, cloudEnabled } = input
  const errors = raw.physical_layout_errors.map(adaptViolation)

  // AI citation tips may not have arrived yet (background task async). We
  // treat any tooltips returned in the immediate response + any carried via
  // the `ai_citation_tooltips` array. If cloud mode was off, the server
  // skipped the AI call — we still expose an empty array so the panel
  // renders the "Cloud mode was off" locked state.
  const tips = (raw.ai_citation_tooltips ?? []).map(adaptCitation)
  const citationTipCount = cloudEnabled ? tips.length : 0

  const scoreResult = calculateWeightedScore(errors, citationTipCount)

  // Use the server's authoritative total; do NOT override with the
  // client-recomputed value (different scoring paths can drift).
  const total = raw.weighted_compliance_score
  // Recompute breakdown only — that part is derived from the same
  // error set so it stays consistent with the score's structure.
  const breakdown = scoreResult.breakdown
  // If our breakdown doesn't sum to the server total, surface the gap as
  // an "uncategorised" residual on the citation_apa bucket.
  const breakdownSum = breakdown.reduce((acc, b) => acc + b.deduction, 0)
  const residual = Math.max(0, 100 - total - breakdownSum)
  if (residual > 0) {
    const i = breakdown.findIndex((b) => b.category === 'citation_apa')
    if (i >= 0) {
      breakdown[i] = {
        ...breakdown[i],
        deduction: breakdown[i].deduction + residual,
        remaining: Math.max(0, breakdown[i].remaining - residual),
      }
    }
  }

  return {
    status: 'Success',
    weighted_compliance_score: total,
    score_breakdown: breakdown,
    major_count: scoreResult.majorCount,
    minor_count: scoreResult.minorCount,
    physical_layout_errors: errors,
    ai_citation_tooltips: tips,
    document_stats: documentStats,
    audited_at: auditedAt ?? new Date().toISOString(),
    audit_id: raw.audit_id,
  }
}