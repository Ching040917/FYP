/**
 * Shared audit domain types — ported from reference_project/src/types/audit.ts.
 * Mirrors the shape the in-page ScoreDashboard / ErrorList / CitationTips consume.
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

export interface ScoreBreakdown {
  category: AuditCategory
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
}