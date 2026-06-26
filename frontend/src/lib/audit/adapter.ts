/**
 * Adapter: backend wire shape (AuditSubmitResponse) → reference AuditResult.
 *
 * SIMPLIFIED: backend now returns `score_breakdown` and `document_stats`
 * directly (per the scoring centralisation work). This file no longer
 * re-derives scoring client-side — the residual hack that padded the
 * citation_apa bucket is GONE.
 *
 * Backend is the single source of truth for scoring. The frontend just
 * maps wire types to the dashboard's display types.
 */

import type { AuditCategory, AuditResult, CitationTip, LayoutError, DocumentStats } from '../../types/audit'
import type { AuditSubmitResponse, CitationIssue, Violation } from '../../types/api'

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

/** Map backend string category to frontend AuditCategory union. */
function mapCategory(cat: string): AuditCategory {
  const c = cat.toLowerCase()
  if (c.includes('citation') || c.includes('apa')) return 'citation_apa'
  if (c.includes('margin') || c.includes('page')) return 'page_margins'
  if (c.includes('heading') || c.includes('hierarchy')) return 'heading_hierarchy'
  if (c.includes('caption') || c.includes('media') || c.includes('image')) return 'media_captions'
  if (c.includes('font_size') || c.includes('size')) return 'font_size'
  if (c.includes('font')) return 'font_consistency'
  if (c.includes('paragraph') || c.includes('line') || c.includes('spacing') || c.includes('align')) return 'paragraph_typography'
  return 'paragraph_typography'
}

export interface AdaptInput {
  raw: AuditSubmitResponse
  auditedAt?: string
}

const ZERO_STATS: DocumentStats = {
  paragraphs: 0, headings: 0, tables: 0, images: 0, sections: 0, words: 0,
}

export function adaptAuditResponse(input: AdaptInput): AuditResult {
  const { raw, auditedAt } = input
  const errors = raw.physical_layout_errors.map(adaptViolation)

  // AI citation tips — if cloud mode was off, the server skipped the AI
  // call; we still expose an empty array so the panel renders the
  // "Cloud mode was off" locked state.
  const tips = (raw.ai_citation_tooltips ?? []).map(adaptCitation)

  // Use backend-provided breakdown + stats directly (single source of truth).
  // Fallback to empty array / zero stats if backend didn't send them
  // (backward compat with older backend versions).
  // Map backend string category to frontend AuditCategory union.
  const breakdown = (raw.score_breakdown ?? []).map(b => ({
    ...b,
    category: mapCategory(b.category),
  }))
  const documentStats = raw.document_stats ?? ZERO_STATS

  return {
    status: 'Success',
    weighted_compliance_score: raw.weighted_compliance_score,
    score_breakdown: breakdown,
    major_count: raw.major_count ?? errors.filter((e) => e.severity === 'major').length,
    minor_count: raw.minor_count ?? errors.filter((e) => e.severity === 'minor').length,
    physical_layout_errors: errors,
    ai_citation_tooltips: tips,
    document_stats: documentStats,
    audited_at: auditedAt ?? new Date().toISOString(),
    audit_id: raw.audit_id,
  }
}
