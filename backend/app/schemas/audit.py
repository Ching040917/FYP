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


# Document-level stats for the dashboard hero. Fields are nullable because
# the retrieval endpoint serves audit records from the database, and records
# created before stats were persisted have NULL values — the UI must render
# those as "unavailable", not as zero counts.
class DocumentStatsResponse(BaseModel):
    paragraphs: Optional[int] = None
    headings: Optional[int] = None
    tables: Optional[int] = None
    images: Optional[int] = None
    sections: Optional[int] = None
    words: Optional[int] = None


class AuditSubmitResponse(BaseModel):
    status: str
    audit_id: str
    weighted_compliance_score: int
    physical_layout_errors: List[ViolationResponse]
    ai_citation_tooltips: List[CitationIssueResponse]
    # NEW — kills the frontend adapter.ts residual hack
    score_breakdown: List[ScoreBreakdownResponse] = []
    # NEW — kills the frontend mammoth-based stats.ts
    document_stats: DocumentStatsResponse = DocumentStatsResponse()
    major_count: int = 0
    minor_count: int = 0
    # NEW — AI-assisted citation review execution summary (Build 7D).
    # Nullable for historical compatibility; the UI must never treat NULL as
    # "ran" or "unavailable" — it means "status not recorded".
    ai_review_status: Optional[str] = None
    ai_provider: Optional[str] = None


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
    document_stats: DocumentStatsResponse = DocumentStatsResponse()
    major_count: int = 0
    minor_count: int = 0
    # NEW — AI-assisted citation review execution summary (Build 7D).
    ai_review_status: Optional[str] = None
    ai_provider: Optional[str] = None


class AuditListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    weighted_score: int
    status: str
    created_at: datetime
