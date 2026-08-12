/**
 * Shared audit domain types — ported from reference_project/src/types/audit.ts.
 * Mirrors the shape the in-page workspace components consume.
 * Wire-level types live in ../types/api.ts (separate; not modified here).
 */

export type ViolationSeverity = 'major' | 'minor'

export type AuditCategory =
  | 'font_consistency'
  | 'font_size'
  | 'paragraph_typography'
  | 'page_margins'
  | 'heading_hierarchy'
  | 'media_captions'
  | 'citation_apa'

/**
 * Score-breakdown category. The 7 known categories plus a presentation-only
 * `'unknown'` bucket for backend categories the UI doesn't recognise yet.
 * Kept separate from AuditCategory so layout errors (always mapped to a known
 * category) never take the unknown bucket, and so the closed AuditCategory
 * union in scoring.ts stays intact.
 */
export type ScoreCategory = AuditCategory | 'unknown'

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
export type AiProvider =
  | 'LOCAL_OLLAMA'
  | 'CLOUD_GEMINI'
  | 'CLOUD_FALLBACK_LOCAL'
  | 'UNKNOWN'

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
}