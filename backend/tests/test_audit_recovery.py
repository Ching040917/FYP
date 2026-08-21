"""Stale Audit recovery — reconciliation service tests (Build 1).

Pure service-level coverage against an in-memory DB. Never touches the real
backend/audit.db. Verifies the exact startup stale definition, conditional
status guard, idempotency, preview metadata convergence, and best-effort
preview-file deletion ordering.
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.audit import AuditRecord
from app.services.audit_recovery import (
    reconcile_stale_audits,
    REASON_APPLICATION_RESTART,
)
from app.services import preview_storage


@pytest.fixture
def db_session(tmp_path, monkeypatch):
    """In-memory DB + preview root under tmp_path, per test."""
    monkeypatch.setattr(preview_storage.settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "previews"))
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _add(session, **overrides):
    defaults = dict(
        id="row-1", filename="doc.docx", file_size=100,
        status="processing",
        created_at=datetime.utcnow() - timedelta(minutes=5),
        weighted_score=0,
    )
    defaults.update(overrides)
    row = AuditRecord(**defaults)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def test_stale_row_before_process_start_becomes_interrupted(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="stale", created_at=process_start - timedelta(minutes=10))
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 1
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "stale").one()
    assert row.status == "interrupted"
    assert row.interruption_reason == REASON_APPLICATION_RESTART
    assert row.interrupted_at is not None
    assert row.interrupted_at.tzinfo is None  # naive UTC


def test_row_created_at_or_after_process_start_stays_processing(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="at", created_at=process_start)
    _add(db_session, id="after", created_at=process_start + timedelta(seconds=1))
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 0
    for rid in ("at", "after"):
        row = db_session.query(AuditRecord).filter(AuditRecord.id == rid).one()
        assert row.status == "processing"
        assert row.interruption_reason is None


def test_future_timestamp_stays_processing(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="future", created_at=process_start + timedelta(hours=1))
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 0
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "future").one()
    assert row.status == "processing"


def test_malformed_unprovable_timestamp_unchanged(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="none", created_at=None)
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 0
    assert db_session.query(AuditRecord).filter(AuditRecord.id == "none").one().status == "processing"


def test_aware_timestamp_never_interrupted_direct_guard():
    """The `_created_before` guard rejects aware datetimes directly.

    SQLite drops tzinfo on round-trip, so this is exercised at the service
    helper level, not through a persisted row.
    """
    from app.services.audit_recovery import _created_before
    from datetime import timezone
    now = datetime.utcnow()
    aware = (now - timedelta(minutes=10)).replace(tzinfo=timezone.utc)
    assert _created_before(aware, now) is False
    assert _created_before(None, now) is False
    assert _created_before("not-a-date", now) is False
    assert _created_before(now - timedelta(minutes=1), now) is True


def test_completed_failed_interrupted_rows_untouched(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="c", status="completed", created_at=process_start - timedelta(hours=1))
    _add(db_session, id="f", status="failed", created_at=process_start - timedelta(hours=1))
    _add(db_session, id="i", status="interrupted", created_at=process_start - timedelta(hours=1))
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 0
    for rid, exp in (("c", "completed"), ("f", "failed"), ("i", "interrupted")):
        row = db_session.query(AuditRecord).filter(AuditRecord.id == rid).one()
        assert row.status == exp
        assert row.interruption_reason is None


def test_double_reconciliation_idempotent(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="a", created_at=process_start - timedelta(minutes=5))
    first = reconcile_stale_audits(db_session, process_start, enabled=True)
    second = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert first == 1
    assert second == 0
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "a").one()
    assert row.status == "interrupted"
    assert row.interrupted_at is not None


def test_conditional_guard_never_overwrites_completed(db_session):
    """A row flipped to completed between select and update is not overwritten."""
    process_start = datetime.utcnow()
    _add(db_session, id="b", created_at=process_start - timedelta(minutes=5))
    # Simulate the row being claimed by another writer (lazy-complete path).
    db_session.query(AuditRecord).filter(AuditRecord.id == "b").update(
        {"status": "completed"}, synchronize_session=False
    )
    db_session.commit()
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 0
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "b").one()
    assert row.status == "completed"
    assert row.interruption_reason is None


def test_preview_metadata_converges_in_same_transaction(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="p",
         created_at=process_start - timedelta(minutes=5),
         rendered_preview_status=preview_storage.PREVIEW_STATUS_AVAILABLE,
         rendered_preview_sha256="a" * 64,
         rendered_preview_size=1234,
         rendered_preview_pages=3,
         rendered_preview_converted_at=datetime.utcnow() - timedelta(minutes=1),
         rendered_preview_error=None)
    reconcile_stale_audits(db_session, process_start, enabled=True)
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "p").one()
    assert row.status == "interrupted"
    assert row.rendered_preview_status == preview_storage.PREVIEW_STATUS_UNAVAILABLE
    assert row.rendered_preview_sha256 is None
    assert row.rendered_preview_size is None
    assert row.rendered_preview_pages is None
    assert row.rendered_preview_converted_at is None
    assert row.rendered_preview_error is not None


def test_profile_snapshot_and_metadata_preserved(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="s", created_at=process_start - timedelta(minutes=5),
         profile_snapshot={"profile_id": "custom-x"}, filename="keep.docx", file_size=42)
    reconcile_stale_audits(db_session, process_start, enabled=True)
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "s").one()
    assert row.status == "interrupted"
    assert row.profile_snapshot == {"profile_id": "custom-x"}
    assert row.filename == "keep.docx"
    assert row.file_size == 42


def test_no_findings_or_scores_fabricated(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="n", created_at=process_start - timedelta(minutes=5), weighted_score=0)
    reconcile_stale_audits(db_session, process_start, enabled=True)
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "n").one()
    assert row.weighted_score == 0
    assert len(row.violations) == 0


def test_disabled_configuration_noop(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="d", created_at=process_start - timedelta(minutes=5))
    n = reconcile_stale_audits(db_session, process_start, enabled=False)
    assert n == 0
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "d").one()
    assert row.status == "processing"


def test_preview_file_removed_after_commit(db_session, tmp_path):
    """Derived PDF exists → removed after the DB transition commits."""
    pid = "0f3c2e6d-0000-4000-8000-000000000001"
    process_start = datetime.utcnow()
    _add(db_session, id=pid, created_at=process_start - timedelta(minutes=5),
         rendered_preview_status=preview_storage.PREVIEW_STATUS_AVAILABLE)
    # Write a real preview file at the derived path.
    path = preview_storage.preview_path(pid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-fake")
    assert path.exists()
    reconcile_stale_audits(db_session, process_start, enabled=True)
    assert not path.exists()
    row = db_session.query(AuditRecord).filter(AuditRecord.id == pid).one()
    assert row.status == "interrupted"
    assert row.rendered_preview_status == preview_storage.PREVIEW_STATUS_UNAVAILABLE


def test_missing_preview_file_is_harmless(db_session, tmp_path):
    process_start = datetime.utcnow()
    _add(db_session, id="mp", created_at=process_start - timedelta(minutes=5))
    reconcile_stale_audits(db_session, process_start, enabled=True)
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "mp").one()
    assert row.status == "interrupted"


def test_removal_failure_keeps_db_unavailable(db_session, tmp_path, monkeypatch):
    """Deletion failure never rolls back / restores availability."""
    process_start = datetime.utcnow()
    _add(db_session, id="rf", created_at=process_start - timedelta(minutes=5),
         rendered_preview_status=preview_storage.PREVIEW_STATUS_AVAILABLE)
    def _boom(_):
        raise OSError("disk")
    monkeypatch.setattr(preview_storage, "remove_preview", _boom)
    # Must not raise — best-effort.
    n = reconcile_stale_audits(db_session, process_start, enabled=True)
    assert n == 1
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "rf").one()
    assert row.status == "interrupted"
    assert row.rendered_preview_status == preview_storage.PREVIEW_STATUS_UNAVAILABLE


def test_sibling_preview_untouched(db_session, tmp_path):
    process_start = datetime.utcnow()
    target = "0f3c2e6d-0000-4000-8000-000000000002"
    other = "0f3c2e6d-0000-4000-8000-000000000003"
    _add(db_session, id=target, created_at=process_start - timedelta(minutes=5))
    _add(db_session, id=other, status="completed", created_at=process_start - timedelta(hours=1))
    other_path = preview_storage.preview_path(other)
    other_path.parent.mkdir(parents=True, exist_ok=True)
    other_path.write_bytes(b"%PDF-other")
    reconcile_stale_audits(db_session, process_start, enabled=True)
    assert other_path.exists()  # sibling untouched
    assert db_session.query(AuditRecord).filter(AuditRecord.id == other).one().status == "completed"


def test_invalid_audit_id_cannot_escape_preview_root(db_session):
    process_start = datetime.utcnow()
    _add(db_session, id="invalid-id-not-uuid", created_at=process_start - timedelta(minutes=5))
    # remove_preview is a safe no-op for non-UUID ids — must not raise.
    reconcile_stale_audits(db_session, process_start, enabled=True)
    row = db_session.query(AuditRecord).filter(AuditRecord.id == "invalid-id-not-uuid").one()
    assert row.status == "interrupted"
