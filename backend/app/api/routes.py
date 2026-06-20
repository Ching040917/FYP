from fastapi import APIRouter, UploadFile, File, BackgroundTasks, HTTPException, Depends, Query
from sqlalchemy.orm import Session
from typing import List
import uuid

from app.database import get_db
from app.config import settings
from app.models.audit import AuditRecord, Violation, CitationIssue
from app.schemas.audit import (
    AuditSubmitResponse,
    AuditResponse,
    AuditListResponse,
    ViolationResponse,
    CitationIssueResponse,
)
from app.services.layout_engine import run_static_rules_engine
from app.services.scoring import calculate_weighted_score
from app.services.ai_citation import async_ai_citation_task, extract_citation_text
from app.services.document_parser import parse_document, extract_paragraphs

router = APIRouter()


@router.post("/api/audit", response_model=AuditSubmitResponse)
async def audit_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    # Validate file type
    if not file.filename.endswith('.docx'):
        raise HTTPException(status_code=400, detail="Unsupported file format. Only .docx files are accepted.")

    # Read file
    file_bytes = await file.read()
    if len(file_bytes) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File size exceeds the 10MB security boundary.")

    # Create audit record with "processing" status
    audit = AuditRecord(
        id=str(uuid.uuid4()),
        filename=file.filename,
        file_size=len(file_bytes),
        weighted_score=0,
        deploy_mode=settings.DEPLOY_MODE,
        status="processing",
    )
    db.add(audit)
    db.commit()
    db.refresh(audit)

    try:
        # Run static layout engine (synchronous)
        layout_violations = run_static_rules_engine(file_bytes)
        weighted_score = calculate_weighted_score(layout_violations)

        # Persist violations
        for v in layout_violations:
            violation = Violation(
                id=str(uuid.uuid4()),
                audit_id=audit.id,
                rule_code=v.rule_code,
                severity=v.severity,
                location=v.location,
                message=v.message,
                expected_value=v.expected_value,
                actual_value=v.actual_value,
            )
            db.add(violation)

        # Update audit with score
        audit.weighted_score = weighted_score
        db.commit()

        # Prepare immediate response
        violation_responses = [
            ViolationResponse(
                id=v.id,
                rule_code=v.rule_code,
                severity=v.severity,
                location=v.location,
                message=v.message,
                expected_value=v.expected_value,
                actual_value=v.actual_value,
            )
            for v in audit.violations
        ]

        # Extract citation text for AI analysis
        doc = parse_document(file_bytes)
        paragraphs = extract_paragraphs(doc)
        citation_text = extract_citation_text(paragraphs)

        # Dispatch background AI task
        background_tasks.add_task(
            async_ai_citation_task,
            citation_text,
            audit.id,
            db,
        )

        return AuditSubmitResponse(
            status="Success",
            audit_id=audit.id,
            weighted_compliance_score=weighted_score,
            physical_layout_errors=violation_responses,
            ai_citation_tooltips=[],
        )

    except Exception as e:
        audit.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")


@router.get("/api/audit/{audit_id}", response_model=AuditResponse)
async def get_audit(audit_id: str, db: Session = Depends(get_db)):
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    # Update status to completed if AI task done (has citation issues)
    if audit.status == "processing" and audit.citation_issues:
        audit.status = "completed"
        from datetime import datetime
        audit.completed_at = datetime.utcnow()
        db.commit()

    violation_responses = [
        ViolationResponse(
            id=v.id,
            rule_code=v.rule_code,
            severity=v.severity,
            location=v.location,
            message=v.message,
            expected_value=v.expected_value,
            actual_value=v.actual_value,
        )
        for v in audit.violations
    ]

    citation_responses = [
        CitationIssueResponse(
            id=c.id,
            paragraph_index=c.paragraph_index,
            text_snippet=c.text_snippet,
            issue_type=c.issue_type,
            message=c.message,
            suggestion=c.suggestion,
            confidence=c.confidence,
        )
        for c in audit.citation_issues
    ]

    return AuditResponse(
        id=audit.id,
        filename=audit.filename,
        file_size=audit.file_size,
        weighted_score=audit.weighted_score,
        deploy_mode=audit.deploy_mode,
        status=audit.status,
        created_at=audit.created_at,
        completed_at=audit.completed_at,
        violations=violation_responses,
        citation_issues=citation_responses,
    )


@router.get("/api/audits", response_model=List[AuditListResponse])
async def list_audits(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    audits = db.query(AuditRecord).order_by(AuditRecord.created_at.desc()).offset(offset).limit(limit).all()
    return [
        AuditListResponse(
            id=a.id,
            filename=a.filename,
            weighted_score=a.weighted_score,
            status=a.status,
            created_at=a.created_at,
        )
        for a in audits
    ]