export interface Violation {
  id: string
  rule_code: string
  severity: 'MAJOR' | 'MINOR'
  location: Record<string, unknown> | null
  message: string
  expected_value: string | null
  actual_value: string | null
}

export interface CitationIssue {
  id: string
  paragraph_index: number
  text_snippet: string
  issue_type: string
  message: string
  suggestion: string | null
  confidence: number | null
}

/** Per-category score breakdown row — mirrors backend ScoreBreakdownResponse. */
export interface ScoreBreakdown {
  category: string
  label: string
  major: number
  minor: number
  deduction: number
  remaining: number
}

/** Document-level stats — mirrors backend DocumentStatsResponse (submit path: always populated). */
export interface DocumentStats {
  paragraphs: number
  headings: number
  tables: number
  images: number
  sections: number
  words: number
}

/**
 * Stats as served by GET /api/audit/{id}. Fields are null for records whose
 * stats were never persisted (created before backend persistence existed).
 * Render as "unavailable" — never as factual zero counts.
 */
export type AuditDocumentStats = { [K in keyof DocumentStats]: number | null }

export interface AuditSubmitResponse {
  status: string
  audit_id: string
  weighted_compliance_score: number
  physical_layout_errors: Violation[]
  ai_citation_tooltips: CitationIssue[]
  /** NEW — authoritative per-category breakdown from backend (kills residual hack). */
  score_breakdown?: ScoreBreakdown[]
  /** NEW — document stats computed once on the backend (kills mammoth dep). */
  document_stats?: DocumentStats
  major_count?: number
  minor_count?: number
  /** NEW — AI-assisted citation review execution summary (Build 7D). Null = status not recorded. */
  ai_review_status?: string | null
  ai_provider?: string | null
}

/** Section boundary metadata (PoC) — mirrors backend SectionMetadata. */
export interface SectionMetadata {
  section_index: number
  start_paragraph_index: number | null
  end_paragraph_index: number | null
  break_type: string
  page_width: number | null
  page_height: number | null
  margin_left: number | null
  margin_right: number | null
  margin_top: number | null
  margin_bottom: number | null
}

export interface AuditResponse {
  id: string
  filename: string
  file_size: number
  weighted_score: number
  deploy_mode: string
  status: 'processing' | 'completed' | 'failed' | 'interrupted'
  created_at: string
  completed_at: string | null
  /** Stale Audit recovery (Build 1/2): safe interruption metadata. Null for
   * non-interrupted audits. reason is a safe category, never paths/errors. */
  interruption_reason?: string | null
  interrupted_at?: string | null
  violations: Violation[]
  citation_issues: CitationIssue[]
  score_breakdown?: ScoreBreakdown[]
  /** May contain null fields for records with unpersisted stats. */
  document_stats?: AuditDocumentStats
  major_count?: number
  minor_count?: number
  /** NEW — AI-assisted citation review execution summary (Build 7D). Null = status not recorded. */
  ai_review_status?: string | null
  ai_provider?: string | null
  /** Section boundary metadata (PoC). Null for historical audits. */
  sections?: SectionMetadata[] | null
  /** Immutable per-Audit Formatting Profile snapshot. Null for historical audits. */
  profile_snapshot?: ProfileSnapshot | null
}

export interface AuditListItem {
  id: string
  filename: string
  weighted_score: number
  status: string
  created_at: string
}

/** Presentation-safe built-in Document Formatting Profile listing (Build 5). */
export interface FormattingProfile {
  profile_id: string
  profile_name: string
  profile_version: number
  description: string
  profile_source: 'built_in' | 'custom'
  recommended: boolean
  citation_style: string
  key_requirements: string[]
}

/**
 * Result of POST /api/formatting-profiles/validate (Build 3). When the
 * endpoint is reachable it is either `valid: true` with a normalized
 * backend-confirmed profile, or `valid: false` with friendly per-field
 * errors. `unreachable: true` means the request could not be completed —
 * the editor shows a retryable generic message.
 */
export type ProfileValidationResult =
  | { valid: true; profile: Record<string, unknown> }
  | { valid: false; errors: ProfileValidationError[] }
  | { valid: false; unreachable: true }

export interface ProfileValidationError {
  field: string
  message: string
}

/**
 * Immutable per-Audit Formatting Profile snapshot (Build 3) as served by
 * GET/POST audit responses. `margins` uses `{left_in, right_in, top_in,
 * bottom_in}` — null means the corresponding deterministic Margin check is
 * disabled. Null snapshot = historical audit (legacy requirements).
 */
export interface ProfileSnapshot {
  profile_id: string
  profile_name: string
  profile_version: number
  profile_source: string
  description: string
  citation_style: string
  institution_specific: boolean
  margins: {
    left_in: number | null
    right_in: number | null
    top_in: number | null
    bottom_in: number | null
  }
}

/** Structured paragraph block from GET /api/audit/{id}/document-blocks — mirrors backend extract_document_blocks. */
export interface DocumentBlock {
  /** Document order — use for ordering, never array position. */
  order: number
  /** Block kind — backend currently emits "paragraph" only. */
  type: string
  /** Paragraph identity — equals the paragraph_index findings carry. */
  index: number
  text: string
  style_name: string | null
  heading_level: number | null
  /** Authoritative structural role (Phase 1 PoC). Null on historical audits. */
  role: string | null
}
