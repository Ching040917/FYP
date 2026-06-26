from fastapi import APIRouter, UploadFile, File, BackgroundTasks, HTTPException, Depends, Query
from sqlalchemy.orm import Session
from typing import List, Optional
import logging
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
    ScoreBreakdownResponse,
    DocumentStatsResponse,
)
from app.services.layout_engine import run_static_rules_engine
from app.services.scoring import calculate_weighted_score, calculate_weighted_score_detailed
from app.services.ai_citation import async_ai_citation_task, extract_citation_text
from app.services.document_parser import parse_document, extract_paragraphs, extract_document_stats

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/audit", response_model=AuditSubmitResponse)
async def audit_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    cloud: bool = Query(False, description="Enable cloud AI citation audit (Gemini)"),
    db: Session = Depends(get_db),
):
    # Validate file type
    if not file.filename.endswith('.docx'):
        raise HTTPException(status_code=400, detail="Unsupported file format. Only .docx files are accepted.")

    # Read file
    file_bytes = await file.read()
    if len(file_bytes) > settings.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File size exceeds the 10MB security boundary.")

    # Determine deploy mode: request flag overrides env default for this audit
    deploy_mode = "CLOUD" if cloud else settings.DEPLOY_MODE

    # Create audit record with "processing" status
    audit = AuditRecord(
        id=str(uuid.uuid4()),
        filename=file.filename,
        file_size=len(file_bytes),
        weighted_score=0,
        deploy_mode=deploy_mode,
        status="processing",
    )
    db.add(audit)
    db.commit()
    db.refresh(audit)

    try:
        # ---- Parse once, reuse for rules + stats ----
        doc = parse_document(file_bytes)
        paragraphs = extract_paragraphs(doc)

        # ---- Static rules engine ----
        layout_violations = run_static_rules_engine(file_bytes)

        # ---- Authoritative scoring with per-category breakdown ----
        score_result = calculate_weighted_score_detailed(layout_violations)

        # ---- Document stats (single source of truth) ----
        doc_stats = extract_document_stats(doc)

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
        audit.weighted_score = score_result.total
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

        breakdown_responses = [
            ScoreBreakdownResponse(**b.to_dict())
            for b in score_result.breakdown
        ]
        stats_response = DocumentStatsResponse(**doc_stats)

        # Extract citation text for AI analysis
        citation_text = extract_citation_text(paragraphs)

        # Dispatch background AI task with cloud flag
        background_tasks.add_task(
            async_ai_citation_task,
            citation_text,
            audit.id,
            db,
            cloud,  # Pass cloud flag for layer-2 routing
        )

        return AuditSubmitResponse(
            status="Success",
            audit_id=audit.id,
            weighted_compliance_score=score_result.total,
            physical_layout_errors=violation_responses,
            ai_citation_tooltips=[],
            score_breakdown=breakdown_responses,
            document_stats=stats_response,
            major_count=score_result.major_count,
            minor_count=score_result.minor_count,
        )

    except Exception as e:
        logger.exception("Audit processing failed for audit_id=%s", audit.id)
        audit.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")


@router.get("/api/audit/{audit_id}", response_model=AuditResponse)
async def get_audit(audit_id: str, db: Session = Depends(get_db)):
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    logger.info(
        "get_audit id=%s status=%s violations=%d",
        audit_id, audit.status, len(audit.violations or []),
    )

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

    # Recompute breakdown on the fly from persisted violations (keeps the
    # detail page in sync even if the AI task added citation findings later)
    from app.services.layout_violation import LayoutViolation
    reconstructed = [
        LayoutViolation(
            rule_code=v.rule_code,
            severity=v.severity,
            location=v.location or {},
            message=v.message,
            expected_value=v.expected_value,
            actual_value=v.actual_value,
        )
        for v in audit.violations
    ]
    score_result = calculate_weighted_score_detailed(
        reconstructed,
        citation_tip_count=len(citation_responses) if audit.deploy_mode == "CLOUD" else 0,
    )
    breakdown_responses = [
        ScoreBreakdownResponse(**b.to_dict())
        for b in score_result.breakdown
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
        score_breakdown=breakdown_responses,
        document_stats=DocumentStatsResponse(
            paragraphs=0, headings=0, tables=0, images=0, sections=0, words=0
        ),  # stats not persisted on the record; submit response carries them
        major_count=score_result.major_count,
        minor_count=score_result.minor_count,
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


@router.delete("/api/audits/{audit_id}", status_code=204)
async def delete_audit(audit_id: str, db: Session = Depends(get_db)):
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    db.delete(audit)
    db.commit()
    return None
