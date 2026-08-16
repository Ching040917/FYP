"""GET /api/audit/{audit_id}/rendered-preview tests (Build 3).

Verifies: valid serving + security headers; 404 (unknown / historical
NULL / non-UUID id); 409 (UNAVAILABLE with safe category, hash/size/magic/
page-count mismatch); 410 (metadata AVAILABLE but file missing); conversion
is never triggered; symlinks and arbitrary files are rejected; no paths or
content leak into errors/logs; audit data stays unchanged; temp storage and
in-memory DB only.
"""
import io
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.models.audit import AuditRecord
from app.services import preview_storage


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
    root = tmp_path / "previews"
    monkeypatch.setattr(api_routes.settings, "PREVIEW_STORAGE_DIR", str(root))
    return root


def _seed_preview(
    test_engine,
    preview_root,
    *,
    status="AVAILABLE",
    store=True,
    pdf=None,
    sha256=None,
    size=None,
    pages=None,
    error=None,
    audit_id=None,
):
    """Create an audit row (+ stored file + matching metadata) directly."""
    Session = sessionmaker(bind=test_engine)
    s = Session()
    aid = audit_id or str(uuid.uuid4())
    s.add(AuditRecord(
        id=aid, filename="doc.docx", file_size=10, weighted_score=90,
        deploy_mode="LOCAL", status="completed",
        rendered_preview_status=status, rendered_preview_error=error,
    ))
    s.commit()
    if store:
        pdf_bytes = pdf if pdf is not None else _make_pdf(pages or 2)
        meta = preview_storage.store_pdf(aid, pdf_bytes)
        row = s.query(AuditRecord).filter_by(id=aid).first()
        row.rendered_preview_sha256 = sha256 if sha256 is not None else meta.sha256
        row.rendered_preview_size = size if size is not None else meta.size
        row.rendered_preview_pages = pages if pages is not None else meta.pages
        row.rendered_preview_converted_at = meta.converted_at
        s.commit()
    s.close()
    return aid


def _get(client, audit_id):
    return client.get(f"/api/audit/{audit_id}/rendered-preview")


# ---------------------------------------------------------------------------
# success path
# ---------------------------------------------------------------------------

def test_serves_valid_pdf_with_headers(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root)
    pdf = (preview_root / f"{aid}.pdf").read_bytes()

    resp = _get(client, aid)
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content == pdf
    assert resp.content.startswith(b"%PDF")
    assert "inline" in resp.headers["content-disposition"]
    assert 'filename="preview.pdf"' in resp.headers["content-disposition"]
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in resp.headers["cache-control"]
    assert "private" in resp.headers["cache-control"]


def test_serving_does_not_change_audit_data(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root)
    before = client.get(f"/api/audit/{aid}").json()
    assert _get(client, aid).status_code == 200
    after = client.get(f"/api/audit/{aid}").json()
    assert after == before
    # no temp leftovers from serving
    if (preview_root / ".tmp").exists():
        assert list((preview_root / ".tmp").iterdir()) == []


# ---------------------------------------------------------------------------
# 404 states
# ---------------------------------------------------------------------------

def test_unknown_audit_returns_404(client, preview_root):
    resp = _get(client, str(uuid.uuid4()))
    assert resp.status_code == 404


def test_historical_null_status_returns_404_message(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root, store=False, status=None)
    resp = _get(client, aid)
    assert resp.status_code == 404
    assert "older audit" in resp.json()["detail"]


def test_non_uuid_audit_id_returns_404(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root, store=False, audit_id="not-a-uuid")
    resp = _get(client, aid)
    assert resp.status_code == 404
    # traversal-looking ids are equally rejected
    assert _get(client, "../evil").status_code == 404


# ---------------------------------------------------------------------------
# 409 states
# ---------------------------------------------------------------------------

def test_unavailable_returns_409_with_category_and_no_conversion(
    client, test_engine, preview_root, monkeypatch,
):
    def _must_not_run(_bytes):
        raise AssertionError("conversion must never be triggered by this endpoint")
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", _must_not_run)

    aid = _seed_preview(test_engine, preview_root, store=False,
                        status="UNAVAILABLE", error="timeout")
    resp = _get(client, aid)
    assert resp.status_code == 409
    assert resp.headers.get("x-preview-error-category") == "timeout"
    assert "extracted-text preview remains available" in resp.json()["detail"]


def test_hash_mismatch_returns_409(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root, sha256="0" * 64)
    resp = _get(client, aid)
    assert resp.status_code == 409
    assert "no longer available" in resp.json()["detail"]


def test_size_mismatch_returns_409(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root, size=12345)
    resp = _get(client, aid)
    assert resp.status_code == 409


def test_magic_mismatch_returns_409(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root)
    (preview_root / f"{aid}.pdf").write_bytes(b"garbage-not-a-pdf")
    resp = _get(client, aid)
    assert resp.status_code == 409


def test_page_count_mismatch_returns_409(client, test_engine, preview_root):
    # file has 2 pages but metadata claims 99
    aid = _seed_preview(test_engine, preview_root, pdf=_make_pdf(page_count=2), pages=99)
    resp = _get(client, aid)
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# 410 state
# ---------------------------------------------------------------------------

def test_available_but_file_missing_returns_410(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root)
    (preview_root / f"{aid}.pdf").unlink()
    resp = _get(client, aid)
    assert resp.status_code == 410
    assert "no longer available" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# security
# ---------------------------------------------------------------------------

def test_symlink_rejected(client, test_engine, preview_root):
    aid = _seed_preview(test_engine, preview_root)
    target = preview_root / "real-target.pdf"
    target.write_bytes(_make_pdf())
    link = preview_root / f"{aid}.pdf"
    link.unlink()
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable on this host")
    resp = _get(client, aid)
    assert resp.status_code == 409  # corrupt-class rejection, nothing served


def test_arbitrary_file_cannot_be_served(client, test_engine, preview_root):
    """Only <audit-id>.pdf is ever reachable — other names are never found."""
    aid = _seed_preview(test_engine, preview_root, store=False, status="AVAILABLE")
    # a valid PDF sitting under a non-derived name must NOT be served
    preview_root.mkdir(parents=True, exist_ok=True)
    (preview_root / "evil.pdf").write_bytes(_make_pdf())
    resp = _get(client, aid)
    assert resp.status_code == 410  # derived path missing -> gone


def test_errors_and_logs_contain_no_paths_or_content(client, test_engine, preview_root, caplog):
    aid = _seed_preview(test_engine, preview_root)
    (preview_root / f"{aid}.pdf").unlink()

    with caplog.at_level("INFO"):
        resp410 = _get(client, aid)
        resp409 = _get(client, _seed_preview(test_engine, preview_root,
                                             pdf=_make_pdf(page_count=2), pages=99))

    assert resp410.status_code == 410
    assert resp409.status_code == 409
    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    for secret in ("LOCALAPPDATA", "Program Files", "AcademicComplianceAuditor",
                   "previews", str(preview_root)):
        assert secret not in resp410.text and secret not in resp409.text
    for secret in ("LOCALAPPDATA", "Program Files", "AcademicComplianceAuditor", str(preview_root)):
        assert secret not in joined
