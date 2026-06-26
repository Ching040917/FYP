from pydantic import BaseModel, ConfigDict
from datetime import datetime
from typing import Optional, List, Any


class ViolationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    rule_code: str
    severity: str
    location: Optional[Any] = None
    message: str
    expected_value: Optional[str] = None
    actual_value: Optional[str] = None


class CitationIssueResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    paragraph_index: int
    text_snippet: str
    issue_type: str
    message: str
    suggestion: Optional[str] = None
    confidence: Optional[float] = None


# NEW — per-category score breakdown row
class ScoreBreakdownResponse(BaseModel):
    category: str
    label: str
    major: int
    minor: int
    deduction: int
    remaining: int


# NEW — document-level stats for the dashboard hero
class DocumentStatsResponse(BaseModel):
    paragraphs: int
    headings: int
    tables: int
    images: int
    sections: int
    words: int


class AuditSubmitResponse(BaseModel):
    status: str
    audit_id: str
    weighted_compliance_score: int
    physical_layout_errors: List[ViolationResponse]
    ai_citation_tooltips: List[CitationIssueResponse]
    # NEW — kills the frontend adapter.ts residual hack
    score_breakdown: List[ScoreBreakdownResponse] = []
    # NEW — kills the frontend mammoth-based stats.ts
    document_stats: DocumentStatsResponse = DocumentStatsResponse(
        paragraphs=0, headings=0, tables=0, images=0, sections=0, words=0
    )
    major_count: int = 0
    minor_count: int = 0


class AuditResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    file_size: int
    weighted_score: int
    deploy_mode: str
    status: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    violations: List[ViolationResponse] = []
    citation_issues: List[CitationIssueResponse] = []
    # NEW — included here too so the polling detail page gets the same data
    score_breakdown: List[ScoreBreakdownResponse] = []
    document_stats: DocumentStatsResponse = DocumentStatsResponse(
        paragraphs=0, headings=0, tables=0, images=0, sections=0, words=0
    )
    major_count: int = 0
    minor_count: int = 0


class AuditListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    weighted_score: int
    status: str
    created_at: datetime
