from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Query, Response
from sqlalchemy.orm import Session
from typing import List
import logging
import time
import uuid
from datetime import datetime

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
    SectionMetadata,
)
from app.services.layout_engine import run_static_rules_engine
from app.services.scoring import calculate_weighted_score, calculate_weighted_score_detailed
from app.services.ai_citation import async_ai_citation_task
from app.services.document_parser import (
    parse_document,
    extract_paragraphs,
    extract_document_stats,
    extract_document_blocks,
    extract_sections,
)
from app.services.docx_pdf_converter import convert_docx_to_pdf, DocxConversionError
from app.services import preview_storage
from app.services.pdf_report import generate_audit_pdf, build_export_filename

router = APIRouter()
logger = logging.getLogger(__name__)

# Converter error categories -> persisted safe preview categories.
# Only the allowed non-sensitive set may ever reach the database.
_CONVERTER_ERROR_MAP = {
    "libreoffice_unavailable": "libreoffice_missing",
    "invalid_docx": "conversion_failed",
    "timeout": "timeout",
    "conversion_failed": "conversion_failed",
    "invalid_pdf": "conversion_failed",
}


def _preview_error_category(exc: Exception) -> str:
    """Map any preview failure to one safe persisted category."""
    if isinstance(exc, DocxConversionError):
        return _CONVERTER_ERROR_MAP.get(exc.category, "conversion_failed")
    return "persistence_failed"


@router.post("/api/audit", response_model=AuditSubmitResponse)
async def audit_document(
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

    # True once *we* wrote the rendered preview file — the only case where
    # cleanup (removal) is ours to perform.
    preview_pdf_written = False

    try:
        # ---- Rendered PDF preview (Build 2): best-effort, never fails the audit ----
        # Reuses the in-memory DOCX bytes; converts and persists atomically.
        # Any failure marks the preview UNAVAILABLE with a safe category and
        # the audit continues normally. The original DOCX is never stored.
        preview_started = time.perf_counter()
        try:
            pdf_bytes = convert_docx_to_pdf(file_bytes)
            meta = preview_storage.store_pdf(audit.id, pdf_bytes)
            preview_pdf_written = True
            audit.rendered_preview_status = preview_storage.PREVIEW_STATUS_AVAILABLE
            audit.rendered_preview_sha256 = meta.sha256
            audit.rendered_preview_size = meta.size
            audit.rendered_preview_pages = meta.pages
            audit.rendered_preview_converted_at = meta.converted_at
            audit.rendered_preview_error = None
            logger.info(
                "preview render audit=%s status=AVAILABLE duration_ms=%d pages=%d",
                audit.id, int((time.perf_counter() - preview_started) * 1000), meta.pages,
            )
        except Exception as exc:
            # Clean up only a file we created (e.g. store succeeded but a
            # later step in this block failed); never touch pre-existing files.
            if preview_pdf_written:
                preview_storage.remove_preview(audit.id)
            audit.rendered_preview_status = preview_storage.PREVIEW_STATUS_UNAVAILABLE
            audit.rendered_preview_error = _preview_error_category(exc)
            logger.info(
                "preview render audit=%s status=UNAVAILABLE error=%s duration_ms=%d",
                audit.id, audit.rendered_preview_error,
                int((time.perf_counter() - preview_started) * 1000),
            )

        # ---- Parse once, reuse for rules + stats ----
        doc = parse_document(file_bytes)
        paragraphs = extract_paragraphs(doc)

        # ---- Section boundary metadata (PoC) — persisted with the audit ----
        # Captured from the DOCX at creation time so GET / refresh / History
        # keep it (never reconstructed from PDF text after the DOCX is gone).
        section_metadata = extract_sections(doc)

        # ---- Static rules engine ----
        layout_violations = run_static_rules_engine(file_bytes)

        # ---- Authoritative scoring with per-category breakdown ----
        score_result = calculate_weighted_score_detailed(layout_violations)

        # ---- Document stats (single source of truth) ----
        doc_stats = extract_document_stats(doc)

        # Persist stats with the record so GET /api/audit/{id} can serve them
        # instead of zeros. Older records (no columns populated) stay NULL.
        audit.paragraph_count = doc_stats["paragraphs"]
        audit.heading_count = doc_stats["headings"]
        audit.table_count = doc_stats["tables"]
        audit.image_count = doc_stats["images"]
        audit.section_count = doc_stats["sections"]
        audit.word_count = doc_stats["words"]

        # Evidence-Linked Document Preview: ordered paragraph-only blocks.
        # Stored as JSON on the parent row (automatic cascade on delete).
        # The original DOCX is never stored; block text is never logged.
        audit.document_blocks = extract_document_blocks(doc)

        # Section boundary metadata (PoC): persisted so POST, GET, refresh,
        # and History all see identical metadata. Historical rows stay NULL.
        audit.section_metadata = section_metadata

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

        # ---- Deterministic-first AI citation guidance (Build 7F) ----
        # Collect only confirmed CITATION_MISMATCH findings from the
        # deterministic sensor. AI provides correction guidance only —
        # it never adds, removes, or reclassifies findings.
        # A request-local finding_key (UUID) is attached to each finding
        # so the provider can uniquely identify every item — even when
        # multiple findings share the same paragraph_index.
        citation_findings = []
        for v in layout_violations:
            if v.rule_code == "CITATION_MISMATCH":
                paragraph_index = v.location.get("paragraph_index") if v.location else None
                citation_findings.append({
                    "finding_key": str(uuid.uuid4()),
                    "paragraph_index": paragraph_index,
                    "rule_code": v.rule_code,
                    "severity": v.severity,
                    "snippet": v.actual_value or "",
                    "message": v.message,
                    "expected_value": v.expected_value,
                    "actual_value": v.actual_value,
                })

        ai_result = await async_ai_citation_task(
            audit_id=audit.id,
            db=db,
            cloud=cloud,
            citation_findings=citation_findings,
        )

        # Persist AI execution summary so GET retrieval stays truthful.
        audit.ai_review_status = ai_result.status
        audit.ai_provider = ai_result.provider
        db.commit()

        # Mark audit completed now that AI pass is done
        audit.status = "completed"
        audit.completed_at = datetime.utcnow()
        db.commit()
        db.refresh(audit)

        # Build response payloads — use issue_dicts directly (matches
        # CitationIssueResponse shape exactly; see ai_citation.py return)
        citation_responses = [CitationIssueResponse(**row) for row in ai_result.suggestions]

        breakdown_responses = [
            ScoreBreakdownResponse(**b.to_dict())
            for b in score_result.breakdown
        ]
        stats_response = DocumentStatsResponse(**doc_stats)

        return AuditSubmitResponse(
            status="Success",
            audit_id=audit.id,
            weighted_compliance_score=score_result.total,
            physical_layout_errors=violation_responses,
            ai_citation_tooltips=citation_responses,
            score_breakdown=breakdown_responses,
            document_stats=stats_response,
            major_count=score_result.major_count,
            minor_count=score_result.minor_count,
            ai_review_status=ai_result.status,
            ai_provider=ai_result.provider,
            sections=[SectionMetadata(**s) for s in section_metadata],
        )

    except HTTPException:
        # Re-raise validation errors (400 from .docx/size) untouched
        raise
    except Exception as e:
        logger.exception("Audit processing failed for audit_id=%s", audit.id)
        # PDF persisted but the audit transaction failed: remove the final
        # file so no orphan remains; preserve the original failure behavior.
        if preview_pdf_written:
            preview_storage.remove_preview(audit.id)
            audit.rendered_preview_status = preview_storage.PREVIEW_STATUS_UNAVAILABLE
            audit.rendered_preview_error = "persistence_failed"
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
    score_result = calculate_weighted_score_detailed(reconstructed)
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
            paragraphs=audit.paragraph_count,
            headings=audit.heading_count,
            tables=audit.table_count,
            images=audit.image_count,
            sections=audit.section_count,
            words=audit.word_count,
        ),
        major_count=score_result.major_count,
        minor_count=score_result.minor_count,
        ai_review_status=audit.ai_review_status,
        ai_provider=audit.ai_provider,
        sections=(
            [SectionMetadata(**s) for s in audit.section_metadata]
            if isinstance(audit.section_metadata, list)
            else None
        ),
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


@router.get("/api/audit/{audit_id}/document-blocks")
async def get_audit_document_blocks(audit_id: str, db: Session = Depends(get_db)):
    """Read-only Evidence-Linked Document Preview blocks (Build 8B).

    Distinguishes:
      - blocks available  → {"audit_id": ..., "blocks": [...]}
      - historical audit  → {"audit_id": ..., "blocks": null} (no preview data)
      - audit not found   → 404

    Stored data is validated defensively: anything that is not a list is
    treated as unavailable rather than surfaced as a broken document.
    Block text is never logged.
    """
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    blocks = audit.document_blocks if isinstance(audit.document_blocks, list) else None
    return {"audit_id": audit_id, "blocks": blocks}


@router.get("/api/audit/{audit_id}/export-pdf")
async def export_audit_pdf(audit_id: str, db: Session = Depends(get_db)):
    """Download the audit report as a PDF (Phase 1, backend only).

    Deterministic and offline: reads persisted findings/stats only — never
    calls Ollama or Gemini, never touches the original document bytes.
    """
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    if audit.status == "processing":
        raise HTTPException(
            status_code=409,
            detail="This audit is still being processed. Please try again shortly.",
        )
    if audit.status == "failed" and not (audit.violations or audit.citation_issues):
        raise HTTPException(
            status_code=409,
            detail="This audit failed and produced no findings, so there is nothing to export.",
        )

    try:
        pdf_bytes = generate_audit_pdf(audit, list(audit.violations), list(audit.citation_issues))
    except Exception:
        logger.exception("PDF export failed for audit_id=%s", audit_id)
        raise HTTPException(
            status_code=500,
            detail="Could not generate the PDF report. Please try again.",
        )

    filename = build_export_filename(audit.filename)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/audit/{audit_id}/rendered-preview")
async def get_rendered_preview(audit_id: str, db: Session = Depends(get_db)):
    """Serve a persisted rendered PDF preview (Build 3).

    Read-only and offline: never triggers conversion, never touches the
    original DOCX. The path is derived from the validated audit UUID only —
    no filesystem path is ever accepted from the request. Every byte is
    revalidated against the persisted metadata before serving.

    Byte-range requests are NOT supported (full-body response). This is
    reported rather than simulated: previews are local files served once,
    and the frontend loads them as Blobs, so ranges are unnecessary.

    Error mapping:
      404 — unknown audit, or NULL preview status (historical record)
      409 — UNAVAILABLE status, or stored file fails hash/size/magic/page
            revalidation
      410 — metadata says AVAILABLE but the file is gone
    """
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    # Paths derive only from canonical UUIDs — anything else is not found.
    try:
        preview_storage.validate_audit_id(audit_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Audit not found")

    if audit.rendered_preview_status is None:
        raise HTTPException(
            status_code=404,
            detail="Rendered preview is unavailable for this older audit.",
        )
    if audit.rendered_preview_status != preview_storage.PREVIEW_STATUS_AVAILABLE:
        category = audit.rendered_preview_error or "unknown"
        logger.info("rendered preview audit=%s status=UNAVAILABLE error=%s", audit_id, category)
        raise HTTPException(
            status_code=409,
            detail=(
                "The page-rendered preview could not be created. "
                "The extracted-text preview remains available."
            ),
            headers={"X-Preview-Error-Category": category},
        )

    try:
        pdf_bytes = preview_storage.read_validated_pdf(
            audit_id,
            expected_sha256=audit.rendered_preview_sha256,
            expected_size=audit.rendered_preview_size,
            expected_pages=audit.rendered_preview_pages,
        )
    except FileNotFoundError:
        logger.info("rendered preview audit=%s status=missing", audit_id)
        raise HTTPException(
            status_code=410,
            detail=(
                "The rendered preview is no longer available. "
                "The extracted-text preview remains available."
            ),
        )
    except ValueError:
        logger.info("rendered preview audit=%s status=corrupt", audit_id)
        raise HTTPException(
            status_code=409,
            detail=(
                "The rendered preview is no longer available. "
                "The extracted-text preview remains available."
            ),
        )

    logger.info("rendered preview audit=%s status=served", audit_id)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="preview.pdf"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/api/audit/{audit_id}")
async def delete_audit(audit_id: str, db: Session = Depends(get_db)):
    """Delete a single audit record and all its child violations + citation issues.

    The cascade="all, delete-orphan" on the Violation and CitationIssue
    relationships means SQLAlchemy automatically deletes the children when
    the parent AuditRecord is deleted.
    """
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    filename = audit.filename
    db.delete(audit)
    db.commit()

    logger.info("Deleted audit id=%s filename=%s", audit_id, filename)
    return {"status": "deleted", "audit_id": audit_id, "filename": filename}
