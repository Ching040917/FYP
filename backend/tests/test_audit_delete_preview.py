"""DELETE /api/audit/{id} rendered-preview cleanup tests (Build 9A, Blocker 2).

Verifies that deleting an audit:
  - removes the persisted rendered PDF when one exists;
  - succeeds when the preview is missing (best-effort cleanup);
  - does not restore the DB record when file deletion fails;
  - returns 404 for unknown audits;
  - cannot target arbitrary files via invalid UUIDs;
  - never touches unrelated previews.
"""
import io
import uuid

import pytest
from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.models.audit import AuditRecord
from app.services import preview_storage


# ---------------------------------------------------------------------------
# helpers
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


@pytest.fixture
def converter_ok(monkeypatch):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf(page_count=2))


def _seed_preview(test_engine, preview_root, *, store=True, audit_id=None):
    """Create an audit row (+ stored file + matching metadata) directly."""
    Session = sessionmaker(bind=test_engine)
    s = Session()
    aid = audit_id or str(uuid.uuid4())
    s.add(AuditRecord(
        id=aid, filename="doc.docx", file_size=10, weighted_score=90,
        deploy_mode="LOCAL", status="completed",
        rendered_preview_status="AVAILABLE",
    ))
    s.commit()
    if store:
        meta = preview_storage.store_pdf(aid, _make_pdf())
        row = s.query(AuditRecord).filter_by(id=aid).first()
        row.rendered_preview_sha256 = meta.sha256
        row.rendered_preview_size = meta.size
        row.rendered_preview_pages = meta.pages
        row.rendered_preview_converted_at = meta.converted_at
        s.commit()
    s.close()
    return aid


def _row_exists(test_engine, aid):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(AuditRecord).filter_by(id=aid).first()
    s.close()
    return row is not None


# ---------------------------------------------------------------------------
# success paths
# ---------------------------------------------------------------------------

def test_delete_removes_available_preview(client, test_engine, preview_root, converter_ok):
    aid = _seed_preview(test_engine, preview_root)
    final = preview_root / f"{aid}.pdf"
    assert final.exists()

    resp = client.delete(f"/api/audit/{aid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    assert not _row_exists(test_engine, aid)
    assert not final.exists()
    assert list((preview_root / ".tmp").iterdir()) == []


def test_delete_with_missing_preview_still_succeeds(client, test_engine, preview_root, converter_ok):
    aid = _seed_preview(test_engine, preview_root, store=False)
    assert not (preview_root / f"{aid}.pdf").exists()

    resp = client.delete(f"/api/audit/{aid}")
    assert resp.status_code == 200
    assert not _row_exists(test_engine, aid)


def test_delete_unrelated_previews_untouched(client, test_engine, preview_root, converter_ok):
    aid = _seed_preview(test_engine, preview_root)
    other = _seed_preview(test_engine, preview_root)
    other_file = preview_root / f"{other}.pdf"
    assert other_file.exists()

    resp = client.delete(f"/api/audit/{aid}")
    assert resp.status_code == 200

    assert not (preview_root / f"{aid}.pdf").exists()
    assert other_file.exists()  # unrelated preview survives


def test_delete_unknown_audit_returns_404(client, preview_root, converter_ok):
    resp = client.delete(f"/api/audit/{str(uuid.uuid4())}")
    assert resp.status_code == 404


def test_delete_invalid_uuid_cannot_target_arbitrary_files(client, test_engine, preview_root, converter_ok):
    # The route 404s on the missing record BEFORE any path derivation;
    # the invalid id is never converted into a filesystem path.
    resp = client.delete("/api/audit/not-a-uuid")
    assert resp.status_code == 404
    assert list(preview_root.glob("*.pdf")) == []
    tmp = preview_root / ".tmp"
    if tmp.exists():
        assert list(tmp.iterdir()) == []


# ---------------------------------------------------------------------------
# file-deletion failure does not restore the DB record
# ---------------------------------------------------------------------------

def test_delete_file_failure_keeps_deletion_successful(client, test_engine, preview_root, converter_ok, monkeypatch):
    aid = _seed_preview(test_engine, preview_root)
    final = preview_root / f"{aid}.pdf"
    assert final.exists()

    def _boom(audit_id):
        raise OSError("simulated file lock")
    monkeypatch.setattr(preview_storage, "remove_preview", _boom)

    resp = client.delete(f"/api/audit/{aid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"
    # DB record stays deleted — cleanup failure must not restore it.
    assert not _row_exists(test_engine, aid)
    # The file may remain (we could not remove it), which is the safe
    # best-effort outcome; nothing was rolled back.
