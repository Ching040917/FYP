"""Focused tests for rendered PDF preview storage (Build 1).

Covers: storage roots, auto-creation, atomic persistence, hash/size/pages
metadata, invalid input rejection, traversal safety, concurrency isolation,
no silent overwrite, cleanup guarantees, cleanup helper, historical
nullable model fields, migration roundtrip, and fresh-database init.
"""
import io
import os
import threading
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models.audit import AuditRecord
from app.services import preview_storage


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_pdf(page_count: int = 2) -> bytes:
    """Build a small valid PDF with the given number of pages."""
    from reportlab.pdfgen import canvas as pdfcanvas
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf)
    for i in range(page_count):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


@pytest.fixture
def storage(tmp_path, monkeypatch):
    """Storage isolated to a temp dir for the test."""
    monkeypatch.setattr(settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "previews"))
    return tmp_path / "previews"


# ---------------------------------------------------------------------------
# roots and auto-creation
# ---------------------------------------------------------------------------

def test_default_storage_root_uses_localappdata(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "PREVIEW_STORAGE_DIR", "")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    expected = tmp_path / "AcademicComplianceAuditor" / "rendered-previews"
    assert preview_storage.default_storage_dir() == expected
    assert preview_storage.storage_root() == expected


def test_override_storage_root(monkeypatch, tmp_path):
    custom = tmp_path / "custom-root"
    monkeypatch.setattr(settings, "PREVIEW_STORAGE_DIR", str(custom))
    assert preview_storage.storage_root() == custom


def test_root_and_tmp_auto_created(storage):
    audit_id = str(uuid.uuid4())
    preview_storage.store_pdf(audit_id, _make_pdf())
    assert storage.exists()
    assert (storage / ".tmp").exists()


# ---------------------------------------------------------------------------
# atomic persistence
# ---------------------------------------------------------------------------

def test_store_pdf_success_and_metadata(storage):
    audit_id = str(uuid.uuid4())
    pdf = _make_pdf(page_count=3)
    meta = preview_storage.store_pdf(audit_id, pdf)

    assert meta.status == "AVAILABLE"
    assert meta.size == len(pdf)
    assert meta.pages == 3
    assert len(meta.sha256) == 64
    assert meta.converted_at is not None

    final = storage / f"{audit_id}.pdf"
    assert final.exists()
    assert final.read_bytes() == pdf
    # no temp leftovers
    assert list((storage / ".tmp").iterdir()) == []


def test_store_pdf_rejects_invalid_uuid(storage):
    for bad in ("../evil", "not-a-uuid", "a" * 40, "", "C:\\Windows\\x"):
        with pytest.raises(ValueError):
            preview_storage.store_pdf(bad, _make_pdf())
        with pytest.raises(ValueError):
            preview_storage.preview_path(bad)
    # nothing was created — root may not even exist yet
    if storage.exists():
        leftovers = [p for p in storage.iterdir() if p.name != ".tmp"]
        assert leftovers == []
        if (storage / ".tmp").exists():
            assert list((storage / ".tmp").iterdir()) == []


def test_store_pdf_rejects_invalid_bytes(storage):
    audit_id = str(uuid.uuid4())
    for bad in (b"", b"not a pdf", b"%PDF-1.4 garbage-not-parseable" * 50):
        with pytest.raises(ValueError):
            preview_storage.store_pdf(audit_id, bad)
    assert not (storage / f"{audit_id}.pdf").exists()
    if (storage / ".tmp").exists():
        assert list((storage / ".tmp").iterdir()) == []


def test_store_pdf_does_not_overwrite_existing(storage):
    audit_id = str(uuid.uuid4())
    first = _make_pdf(page_count=1)
    preview_storage.store_pdf(audit_id, first)
    with pytest.raises(FileExistsError):
        preview_storage.store_pdf(audit_id, _make_pdf(page_count=5))
    # original content untouched
    assert (storage / f"{audit_id}.pdf").read_bytes() == first


def test_concurrent_writes_are_isolated(storage):
    ids = [str(uuid.uuid4()) for _ in range(8)]
    errors = []

    def _store(aid):
        try:
            preview_storage.store_pdf(aid, _make_pdf(page_count=1))
        except Exception as e:  # pragma: no cover - failure would fail the test
            errors.append((aid, e))

    threads = [threading.Thread(target=_store, args=(aid,)) for aid in ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    for aid in ids:
        assert (storage / f"{aid}.pdf").exists()
    assert list((storage / ".tmp").iterdir()) == []


def test_concurrent_same_audit_no_partial_files(storage):
    audit_id = str(uuid.uuid4())
    successes = []

    def _store():
        try:
            preview_storage.store_pdf(audit_id, _make_pdf(page_count=2))
            successes.append(True)
        except (FileExistsError, OSError):
            # Windows: a concurrent os.replace to the same target can fail
            # with PermissionError — both outcomes are acceptable as long as
            # the final file stays valid and no temp files remain.
            pass

    threads = [threading.Thread(target=_store) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(successes) >= 1
    final = storage / f"{audit_id}.pdf"
    assert final.exists()
    assert final.read_bytes().startswith(b"%PDF")
    assert list((storage / ".tmp").iterdir()) == []


# ---------------------------------------------------------------------------
# cleanup guarantees
# ---------------------------------------------------------------------------

def test_cleanup_after_failure_no_tmp_left(storage, monkeypatch):
    audit_id = str(uuid.uuid4())
    # Simulate a failure after the temp file is written (os.replace fails).
    def _boom(src, dst):
        raise OSError("simulated replace failure")
    monkeypatch.setattr(os, "replace", _boom)
    with pytest.raises(OSError):
        preview_storage.store_pdf(audit_id, _make_pdf())
    assert not (storage / f"{audit_id}.pdf").exists()
    assert list((storage / ".tmp").iterdir()) == []


def test_remove_preview_helper(storage):
    audit_id = str(uuid.uuid4())
    assert preview_storage.remove_preview(audit_id) is False
    preview_storage.store_pdf(audit_id, _make_pdf())
    assert (storage / f"{audit_id}.pdf").exists()
    assert preview_storage.remove_preview(audit_id) is True
    assert not (storage / f"{audit_id}.pdf").exists()
    # invalid id is a safe no-op
    assert preview_storage.remove_preview("../evil") is False


def test_preview_file_exists_helper(storage):
    audit_id = str(uuid.uuid4())
    assert preview_storage.preview_file_exists(audit_id) is False
    preview_storage.store_pdf(audit_id, _make_pdf())
    assert preview_storage.preview_file_exists(audit_id) is True
    assert preview_storage.preview_file_exists("../evil") is False


# ---------------------------------------------------------------------------
# model / database
# ---------------------------------------------------------------------------

PREVIEW_COLUMNS = (
    "rendered_preview_status",
    "rendered_preview_sha256",
    "rendered_preview_size",
    "rendered_preview_pages",
    "rendered_preview_converted_at",
    "rendered_preview_error",
)


def test_historical_rows_remain_nullable(test_engine):
    """Records without preview fields (historical) insert fine and stay NULL."""
    Session = sessionmaker(bind=test_engine)
    s = Session()
    rec = AuditRecord(id=str(uuid.uuid4()), filename="old.docx", file_size=10,
                      weighted_score=90, deploy_mode="LOCAL", status="completed")
    s.add(rec)
    s.commit()
    s.refresh(rec)
    for col in PREVIEW_COLUMNS:
        assert getattr(rec, col) is None
    s.close()


def test_fresh_database_has_preview_columns(tmp_path):
    """create_all on a fresh db (no pre-existing audit.db) includes the columns."""
    db_path = tmp_path / "fresh.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    from app.database import Base
    Base.metadata.create_all(bind=engine)
    cols = {c["name"] for c in inspect(engine).get_columns("audit_records")}
    for col in PREVIEW_COLUMNS:
        assert col in cols
    engine.dispose()


def test_migration_roundtrip_rendered_preview(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config

    db_path = tmp_path / "preview-mig.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]

    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))

    def _columns():
        return {c["name"] for c in inspect(create_engine(url)).get_columns("audit_records")}

    monkeypatch.setattr(settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    for col in PREVIEW_COLUMNS:
        assert col in _columns()

    command.downgrade(cfg, "c3d8d19e2b3f")
    for col in PREVIEW_COLUMNS:
        assert col not in _columns()

    command.upgrade(cfg, "head")
    for col in PREVIEW_COLUMNS:
        assert col in _columns()


def test_error_categories_are_fixed_and_non_sensitive():
    assert set(preview_storage.PREVIEW_ERRORS) == {
        "libreoffice_missing", "timeout", "conversion_failed",
        "persistence_failed", "file_missing",
    }
    assert preview_storage.PREVIEW_STATUS_AVAILABLE == "AVAILABLE"
    assert preview_storage.PREVIEW_STATUS_UNAVAILABLE == "UNAVAILABLE"
