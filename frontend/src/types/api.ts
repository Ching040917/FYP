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

export interface AuditSubmitResponse {
  status: string
  audit_id: string
  weighted_compliance_score: number
  physical_layout_errors: Violation[]
  ai_citation_tooltips: CitationIssue[]
}

export interface AuditResponse {
  id: string
  filename: string
  file_size: number
  weighted_score: number
  deploy_mode: string
  status: 'processing' | 'completed' | 'failed'
  created_at: string
  completed_at: string | null
  violations: Violation[]
  citation_issues: CitationIssue[]
}

export interface AuditListItem {
  id: string
  filename: string
  weighted_score: number
  status: string
  created_at: string
}