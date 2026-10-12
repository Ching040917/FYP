/**
 * Shared audit domain types — ported from reference_project/src/types/audit.ts.
 * Mirrors the shape the in-page workspace components consume.
 * Wire-level types live in ../types/api.ts (separate; not modified here).
 */

// 'review' = manual-review finding (never scored, never counted as
// major/minor — the backend emits it as severity token REVIEW).
// 'unknown' = compatibility value for an unrecognized or malformed backend
// severity token: rendered neutrally as "Unclassified" and excluded from
// every count and from score interpretation. Never a scored severity.
export type ViolationSeverity = 'major' | 'minor' | 'review' | 'unknown'

export type AuditCategory =
  | 'font_consistency'
  | 'font_size'
  | 'paragraph_typography'
  | 'page_margins'
  | 'heading_hierarchy'
  | 'media_captions'
  | 'citation_apa'

/**
 * Score-breakdown category. The 7 known categories plus two presentation-only
 * buckets:
 *  - `'unknown'`       backend categories the UI doesn't recognise yet.
 *  - `'legacy_spacing'` the presentation-only "Legacy spacing adjustment"
 *    row attached to historical audits that completed under an earlier
 *    spacing-scoring contract. It explains the stored score; it is not a
 *    real layout category and never maps to a finding.
 * Kept separate from AuditCategory so layout errors (always mapped to a
 * known category) never take a presentation bucket, and so the closed
 * AuditCategory union stays intact.
 */
export type ScoreCategory = AuditCategory | 'unknown' | 'legacy_spacing'

export interface LayoutError {
  id: string
  category: AuditCategory
  severity: ViolationSeverity
  /** 1-indexed paragraph / block index in the document body */
  position: number
  title: string
  detail: string
  suggestion: string
  snippet?: string
  /** One-line evidence preview for the findings card (full text in Details). */
  evidencePreview?: string
  /** "14 pt → 12 pt", or a labelled fallback; null when neither exists. */
  comparison?: string | null
  /** "3 occurrences" for a consolidated finding; null when it repeats once. */
  occurrences?: string | null
}

export interface CitationTip {
  position: number
  text: string
  issue: string
  fix: string
  confidence: 'high' | 'medium' | 'low'
}

/**
 * AI-assisted citation review execution status (Build 7D). Unknown future
 * backend values normalize to 'UNKNOWN' — never to a successful state.
 * null on a domain result means "status not recorded".
 */
export type AiReviewStatus =
  | 'COMPLETED_WITH_SUGGESTIONS'
  | 'COMPLETED_NO_SUGGESTIONS'
  | 'UNAVAILABLE'
  | 'UNKNOWN'

/** Provider path that actually executed the AI-assisted review. */
export type AiProvider = 'LOCAL_OLLAMA' | 'UNKNOWN'
/**
 * Historical scoring-contract reconciliation status (normalised domain form).
 * Present only for completed audits on the GET surface; absent/unknown on
 * payloads that predate the field, so it stays optional everywhere.
 */
export type ScoreConsistencyStatus =
  | 'consistent'
  | 'legacy_spacing'
  | 'inconsistent'

export interface ScoreBreakdown {
  category: ScoreCategory
  label: string
  major: number
  minor: number
  deduction: number
  remaining: number
}

export interface DocumentStats {
  paragraphs: number
  headings: number
  tables: number
  images: number
  sections: number
  words: number
}

export interface AuditResult {
  status: 'Success' | 'Partial' | 'Error'
  weighted_compliance_score: number
  score_breakdown: ScoreBreakdown[]
  major_count: number
  minor_count: number
  physical_layout_errors: LayoutError[]
  ai_citation_tooltips: CitationTip[]
  document_stats: DocumentStats
  audited_at: string
  /** Stable handle for the polling detail page */
  audit_id?: string
  filename?: string
  message?: string
  /** AI-assisted citation review execution summary; null = not recorded. */
  ai_review_status?: AiReviewStatus | null
  ai_provider?: AiProvider | null
  /** Historical scoring-contract reconciliation; null/absent = not recorded. */
  score_consistency?: { status: ScoreConsistencyStatus; note?: string | null } | null
}