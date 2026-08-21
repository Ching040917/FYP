from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Query, Response, Form, Body
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from typing import List, Any, Optional
import json
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
from app.services.profile_resolver import (
    resolve_request_profile,
    restore_snapshot,
    ProfileResolveError,
)
from app.services.custom_profile_validation import validate_custom_profile

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
    profile_id: Optional[str] = Query(None, description="Built-in formatting profile id"),
    custom_profile: Optional[str] = Form(None, description="Validated custom formatting profile payload (JSON string)"),
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

    # ---- Resolve the immutable formatting profile snapshot BEFORE any
    # deterministic processing begins (Build 3). Missing input → recommended
    # SUC built-in (transitional compatibility); unknown id / malformed
    # custom payload → friendly 400 with safe field-path messages.
    custom_payload = None
    if custom_profile is not None:
        try:
            custom_payload = json.loads(custom_profile)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=400,
                detail="custom_profile must be a valid JSON object",
            )
    try:
        profile_snapshot = resolve_request_profile(
            profile_id=profile_id,
            custom_profile=custom_payload,
        )
    except ProfileResolveError as exc:
        detail = "; ".join(f"{path}: {msg}" for path, msg in exc.errors) if exc.errors else str(exc)
        raise HTTPException(status_code=400, detail=detail)

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

        # ---- Static rules engine (Build 4: snapshot-derived config) ----
        # The resolved immutable snapshot drives every supported deterministic
        # rule — global PresetConfig defaults are never read during a
        # production audit. Nullable snapshot requirements skip their check.
        from app.services.profile_preset_adapter import EffectiveProfileConfig
        layout_violations = run_static_rules_engine(
            file_bytes,
            config=EffectiveProfileConfig(profile_snapshot),
        )

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

        # Immutable Document Formatting Profile snapshot (Build 3): resolved
        # BEFORE deterministic processing and persisted in the SAME
        # transaction as the audit row, violations, and score. A processing
        # failure rolls back audit + snapshot together — no partial row.
        # Never stores document text, filenames, paths, or credentials.
        audit.profile_snapshot = profile_snapshot.to_dict()

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
            profile_snapshot=profile_snapshot.to_dict(),
        )

    except HTTPException:
        # Re-raise validation errors (400 from .docx/size) untouched
        raise
    except Exception:
        # Privacy-safe server-side log: exception details (traceback, SQL,
        # paths, document content, provider responses) stay in the server
        # log — never in the HTTP response or the database.
        logger.exception("Audit processing failed for audit_id=%s", audit.id)
        # PDF persisted but the audit transaction failed: remove the final
        # file so no orphan remains; preserve the original failure behavior.
        if preview_pdf_written:
            preview_storage.remove_preview(audit.id)
            audit.rendered_preview_status = preview_storage.PREVIEW_STATUS_UNAVAILABLE
            audit.rendered_preview_error = "persistence_failed"
        audit.status = "failed"
        db.commit()
        # Stable general-user message — no exception text, stack trace,
        # paths, commands, SQL, or document content is exposed.
        raise HTTPException(
            status_code=500,
            detail="The document could not be processed. Please try again. "
            "If the problem continues, use a different DOCX file.",
        )


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
        # Stale Audit recovery (Build 1): safe interruption metadata, null
        # for non-interrupted audits. Never exposes paths or error internals.
        interruption_reason=audit.interruption_reason,
        interrupted_at=audit.interrupted_at,
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
        # GET returns the STORED snapshot, never a re-resolution (Build 3).
        # Null for historical audits → future UI shows "Legacy formatting
        # requirements". Corrupt stored data stays null — never crashes,
        # never re-scored.
        profile_snapshot=(
            audit.profile_snapshot
            if isinstance(audit.profile_snapshot, dict)
            and restore_snapshot(audit.profile_snapshot) is not None
            else None
        ),
    )


@router.post("/api/formatting-profiles/validate")
async def validate_formatting_profile(payload: dict = Body(...)):
    """Presentation-safe validation of ONE custom Document Formatting Profile
    (Build 2).

    Pure and side-effect free: creates no Audit, writes no database row,
    changes no profile registry, writes no files, retains no submitted
    profile, and logs no profile content. Uses the authoritative backend
    `profile_from_dict` + `resolve_snapshot` and their schema ranges and
    compatibility checks.

    Success → {"valid": true, "profile": <normalized custom profile>}.
    Invalid → {"valid": false, "errors": [{field, message}, ...]} where
    `field` is a stable frontend identifier (never a raw Python path) and
    `message` is friendly English (never a stack trace, exception name,
    filesystem path, fingerprint, or registry internals).
    """
    result = validate_custom_profile(payload)
    if result["valid"]:
        return result
    return JSONResponse(status_code=422, content=result)


@router.get("/api/formatting-profiles")
async def list_formatting_profiles():
    """Read-only listing of available built-in Document Formatting Profiles
    (Build 5). Presentation-safe only: identity, version, source, description,
    recommended flag, citation style, and a concise key-requirements summary.
    Never exposes internal types, validation internals, fingerprints, or
    mutable registry objects. Uses the authoritative backend registry.
    """
    from app.services.profile_registry import list_profile_listings
    return {"profiles": list_profile_listings()}


@router.get("/api/formatting-profiles/{profile_id}/payload")
async def get_builtin_profile_payload(profile_id: str):
    """Read-only canonical payload of ONE built-in Document Formatting
    Profile (Build 3 custom-profile editor).

    Enables an authoritative copy of a built-in profile into a custom
    profile: the full canonical payload (identity, requirements, role
    policy) with built-in identity/source intact. Read-only and
    presentation-safe — no snapshot fingerprint, no internal objects, no
    registry mutation. Unknown or non-built-in ids → 404.
    """
    from app.services.profile_registry import BUILTIN_PROFILES
    profile = BUILTIN_PROFILES.get(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Built-in profile not found")
    return {"profile": profile.to_dict()}


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
    if audit.status == "interrupted":
        raise HTTPException(
            status_code=409,
            detail="This audit was interrupted and did not complete, so there is nothing to export.",
        )
    if audit.status == "failed" and not (audit.violations or audit.citation_issues):
        raise HTTPException(
            status_code=409,
            detail="This audit failed and produced no findings, so there is nothing to export.",
        )

    try:
        pdf_bytes = generate_audit_pdf(
            audit,
            list(audit.violations),
            list(audit.citation_issues),
            profile_snapshot=audit.profile_snapshot,
        )
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

    After the database record is committed, the persisted rendered PDF
    preview is removed as best-effort cleanup: a missing file, file-lock, or
    deletion failure never fails the audit deletion — only the audit ID and
    a safe outcome category are logged, never absolute paths.
    """
    audit = db.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    filename = audit.filename
    db.delete(audit)
    db.commit()

    # Best-effort rendered-preview cleanup AFTER the DB commit. The path is
    # derived from the validated audit UUID only — invalid IDs are a safe
    # no-op and can never target arbitrary files. Failures are logged with
    # the audit ID and a fixed category; the deletion stays successful.
    try:
        if preview_storage.remove_preview(audit_id):
            logger.info("audit delete audit=%s preview=removed", audit_id)
        else:
            logger.info("audit delete audit=%s preview=absent_or_failed", audit_id)
    except Exception:
        # remove_preview already swallows OSError, but never let any
        # unexpected cleanup failure flip a successful deletion into an
        # error response.
        logger.warning("audit delete audit=%s preview=cleanup_failed", audit_id)

    logger.info("Deleted audit id=%s filename=%s", audit_id, filename)
    return {"status": "deleted", "audit_id": audit_id, "filename": filename}
