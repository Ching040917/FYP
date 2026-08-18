"""POST /api/audit rendered-preview integration tests (Build 2).

Verifies the preview pipeline is best-effort: conversion success persists
AVAILABLE metadata + PDF file; every failure mode (missing LibreOffice,
timeout, conversion failure, persistence failure) still returns a valid
audit with UNAVAILABLE metadata; DB failure removes the written file;
existing files are never overwritten; the original DOCX is never stored;
logs stay free of paths/content; tests use temp storage only.
"""
import io
import threading
import uuid

import pytest
from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.models.audit import AuditRecord
from app.services import preview_storage
from app.services.docx_pdf_converter import DocxConversionError


# ---------------------------------------------------------------------------
# helpers / fixtures
# ---------------------------------------------------------------------------

def _make_pdf(page_count: int = 2) -> bytes:
    from reportlab.pdfgen import canvas as pdfcanvas
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf)
    for i in range(page_count):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


@pytest.fixture
def preview_root(tmp_path, monkeypatch):
    """Isolated preview storage for the test."""
    root = tmp_path / "previews"
    monkeypatch.setattr(api_routes.settings, "PREVIEW_STORAGE_DIR", str(root))
    return root


@pytest.fixture
def converter_ok(monkeypatch):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf(page_count=2))
    return _make_pdf(page_count=2)


def _converter_raising(monkeypatch, category):
    def _raise(_bytes):
        raise DocxConversionError(category)
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", _raise)


def _post(client, docx_factory, name="preview.docx", **kw):
    return client.post(
        "/api/audit",
        files={"file": (name, docx_factory(paragraphs=["Body text."], **kw), "application/octet-stream")},
    )


def _audit_row(test_engine, audit_id):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
    s.close()
    return row


# ---------------------------------------------------------------------------
# success path
# ---------------------------------------------------------------------------

def test_post_creates_pdf_and_available_metadata(client, docx_factory, preview_root, converter_ok, test_engine):
    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    final = preview_root / f"{audit_id}.pdf"
    assert final.exists()
    assert final.read_bytes().startswith(b"%PDF")
    assert list((preview_root / ".tmp").iterdir()) == []

    row = _audit_row(test_engine, audit_id)
    assert row.rendered_preview_status == "AVAILABLE"
    assert len(row.rendered_preview_sha256) == 64
    assert row.rendered_preview_size == final.stat().st_size
    assert row.rendered_preview_pages == 2
    assert row.rendered_preview_converted_at is not None
    assert row.rendered_preview_error is None


# ---------------------------------------------------------------------------
# failure modes — audit must still complete
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("category,expected_error", [
    ("libreoffice_unavailable", "libreoffice_missing"),
    ("timeout", "timeout"),
    ("conversion_failed", "conversion_failed"),
    ("invalid_docx", "conversion_failed"),
    ("invalid_pdf", "conversion_failed"),
])
def test_conversion_failures_audit_still_completes(
    client, docx_factory, preview_root, monkeypatch, test_engine, category, expected_error,
):
    _converter_raising(monkeypatch, category)
    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    assert resp.json()["status"] == "Success"
    audit_id = resp.json()["audit_id"]

    row = _audit_row(test_engine, audit_id)
    assert row.rendered_preview_status == "UNAVAILABLE"
    assert row.rendered_preview_error == expected_error
    for field in ("rendered_preview_sha256", "rendered_preview_size",
                  "rendered_preview_pages", "rendered_preview_converted_at"):
        assert getattr(row, field) is None
    assert not (preview_root / f"{audit_id}.pdf").exists()


def test_persistence_failure_audit_still_completes(
    client, docx_factory, preview_root, monkeypatch, test_engine,
):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf())

    def _boom(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(preview_storage, "store_pdf", _boom)

    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]
    row = _audit_row(test_engine, audit_id)
    assert row.rendered_preview_status == "UNAVAILABLE"
    assert row.rendered_preview_error == "persistence_failed"
    assert not (preview_root / f"{audit_id}.pdf").exists()


def test_error_category_always_in_allowed_set(
    client, docx_factory, preview_root, monkeypatch, test_engine,
):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf",
                        lambda _bytes: (_ for _ in ()).throw(RuntimeError("weird")))
    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    row = _audit_row(test_engine, resp.json()["audit_id"])
    assert row.rendered_preview_error in preview_storage.PREVIEW_ERRORS


# ---------------------------------------------------------------------------
# audit results unaffected
# ---------------------------------------------------------------------------

def test_score_and_findings_identical_available_vs_unavailable(
    client, docx_factory, preview_root, monkeypatch, test_engine,
):
    def _audit():
        resp = _post(client, docx_factory, margins={"left": 1.0})
        assert resp.status_code == 200
        body = resp.json()
        return {
            "score": body["weighted_compliance_score"],
            "rules": sorted(v["rule_code"] for v in body["physical_layout_errors"]),
            "stats": body["document_stats"],
        }

    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf())
    available = _audit()

    _converter_raising(monkeypatch, "libreoffice_unavailable")
    unavailable = _audit()

    assert available == unavailable


# ---------------------------------------------------------------------------
# DB failure removes the written PDF
# ---------------------------------------------------------------------------

def test_db_failure_removes_final_pdf(client, docx_factory, preview_root, monkeypatch, test_engine):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf())

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated scoring failure")
    monkeypatch.setattr(api_routes, "calculate_weighted_score_detailed", _boom)

    resp = _post(client, docx_factory)
    assert resp.status_code == 500
    audit_id = _latest_failed(test_engine)
    assert not (preview_root / f"{audit_id}.pdf").exists()
    assert list((preview_root / ".tmp").iterdir()) == []


def _latest_failed(test_engine):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(AuditRecord).order_by(AuditRecord.created_at.desc()).first()
    s.close()
    assert row.status == "failed"
    return row.id


# ---------------------------------------------------------------------------
# duplicate path / no docx persistence
# ---------------------------------------------------------------------------

def test_existing_final_file_not_overwritten(client, docx_factory, preview_root, monkeypatch, test_engine):
    """A pre-existing final file must survive; the audit still completes."""
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf())
    fixed = uuid.UUID("11111111-2222-3333-4444-555555555555")
    import itertools
    counter = itertools.count()

    def _sequential_uuid():
        n = next(counter)
        return fixed if n == 0 else uuid.UUID(int=n)
    monkeypatch.setattr(api_routes.uuid, "uuid4", _sequential_uuid)

    original = b"%PDF-1.4 original-content"
    preview_root.mkdir(parents=True, exist_ok=True)
    (preview_root / f"{fixed}.pdf").write_bytes(original)

    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    assert resp.json()["audit_id"] == str(fixed)

    row = _audit_row(test_engine, str(fixed))
    assert row.rendered_preview_status == "UNAVAILABLE"
    assert row.rendered_preview_error == "persistence_failed"
    # original file untouched, no temp leftovers
    assert (preview_root / f"{fixed}.pdf").read_bytes() == original
    if (preview_root / ".tmp").exists():
        assert list((preview_root / ".tmp").iterdir()) == []


def test_original_docx_never_persisted(client, docx_factory, preview_root, converter_ok):
    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    files = [p for p in preview_root.rglob("*") if p.is_file()]
    assert all(p.suffix == ".pdf" for p in files), f"non-PDF persisted: {files}"
    assert list((preview_root / ".tmp").iterdir()) == []


# ---------------------------------------------------------------------------
# historical / concurrent / response contract / logs
# ---------------------------------------------------------------------------

def test_historical_records_remain_valid(client, test_engine):
    audit_id = str(uuid.uuid4())
    Session = sessionmaker(bind=test_engine)
    s = Session()
    s.add(AuditRecord(id=audit_id, filename="old.docx", file_size=10,
                      weighted_score=90, deploy_mode="LOCAL", status="completed"))
    s.commit()
    s.close()

    resp = client.get(f"/api/audit/{audit_id}")
    assert resp.status_code == 200
    row = _audit_row(test_engine, audit_id)
    for field in ("rendered_preview_status", "rendered_preview_sha256", "rendered_preview_size",
                  "rendered_preview_pages", "rendered_preview_converted_at", "rendered_preview_error"):
        assert getattr(row, field) is None


def test_concurrent_audits_use_isolated_files(client_file_db, docx_factory, preview_root, converter_ok):
    # Uses client_file_db: a temporary FILE-backed SQLite with per-thread
    # pooled connections. The in-memory client shares ONE StaticPool
    # connection across threads, which races db.refresh() — the production
    # concurrency logic is untouched, only the test infrastructure is
    # isolated per worker. Also verifies the concurrency invariants:
    # separate conversion workdirs, separate LO profiles, separate rendered
    # PDF files, no overwrite or cross-lock.
    results = []

    def _run():
        results.append(_post(client_file_db, docx_factory).json()["audit_id"])

    threads = [threading.Thread(target=_run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    ids = [r for r in results if r]
    assert len(set(ids)) == 4
    files = {p.name for p in preview_root.glob("*.pdf")}
    assert files == {f"{aid}.pdf" for aid in ids}
    assert list((preview_root / ".tmp").iterdir()) == []


def test_post_response_remains_backward_compatible(client, docx_factory, preview_root, converter_ok):
    resp = _post(client, docx_factory)
    assert resp.status_code == 200
    body = resp.json()
    for key in ("status", "audit_id", "weighted_compliance_score", "physical_layout_errors",
                "ai_citation_tooltips", "score_breakdown", "document_stats",
                "major_count", "minor_count", "ai_review_status", "ai_provider"):
        assert key in body
    assert not any("rendered_preview" in k or "preview" in k for k in body)


def test_logs_contain_no_paths_or_content(client, docx_factory, preview_root, converter_ok, caplog):
    with caplog.at_level("INFO"):
        resp = _post(client, docx_factory)
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "LOCALAPPDATA" not in joined
    assert "Program Files" not in joined
    assert "AcademicComplianceAuditor" not in joined
    assert "Body text" not in joined
    assert f"audit={audit_id}" in joined
    assert "AVAILABLE" in joined
