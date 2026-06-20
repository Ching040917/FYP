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


class AuditSubmitResponse(BaseModel):
    status: str
    audit_id: str
    weighted_compliance_score: int
    physical_layout_errors: List[ViolationResponse]
    ai_citation_tooltips: List[CitationIssueResponse]


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


class AuditListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    weighted_score: int
    status: str
    created_at: datetime