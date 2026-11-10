"""Stale Audit recovery — startup integration tests (Build 1).

Verifies the startup sequence calls reconciliation after database init,
that the disabled setting skips it, and that reconciliation refusal preserves
existing data and exposes only safe recovery guidance and a bounded category.
Never touches backend/audit.db.
"""
import sqlite3

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from tests.test_launcher import ownership_launcher

from app.main import app


def test_startup_calls_reconciliation_after_init(monkeypatch):
    """Reconcile runs at startup; order: init_db then reconcile."""
    calls = []
    monkeypatch.setattr("app.main.init_db", lambda: calls.append("init"))
    monkeypatch.setattr(
        "app.main.reconcile_stale_audits",
        lambda db, process_started_at, enabled=True: calls.append("reconcile"),
    )
    monkeypatch.setattr(app_main_settings(), "AUDIT_RECONCILE_ON_START", True)
    c = TestClient(app)
    with c:
        pass
    assert calls == ["init", "reconcile"]


def test_disabled_setting_skips_reconciliation(monkeypatch):
    calls = []
    monkeypatch.setattr("app.main.init_db", lambda: calls.append("init"))
    monkeypatch.setattr(
        "app.main.reconcile_stale_audits",
        lambda db, process_started_at, enabled=True: calls.append("reconcile"),
    )
    monkeypatch.setattr(app_main_settings(), "AUDIT_RECONCILE_ON_START", False)
    c = TestClient(app)
    with c:
        pass
    assert calls == ["init"]


def test_reconciliation_failure_fails_startup_with_migration_hint(
    monkeypatch, tmp_path, ownership_launcher,
):
    from app import launcher_support as ls

    root, attempt = _startup_attempt(monkeypatch, tmp_path)
    db_path = root.path / "audit.db"
    document_path = r"c:\private\student-draft.docx"
    with sqlite3.connect(db_path) as db:
        # An existing older schema must be refused, never silently replaced.
        db.execute("CREATE TABLE audit_records (id TEXT, filename TEXT, status TEXT)")
        db.execute(
            "INSERT INTO audit_records VALUES (?, ?, ?)",
            ("preserve-existing-audit", document_path, "processing"),
        )
    original = db_path.read_bytes()
    identity = db_path.stat()
    database_url = f"sqlite:///{db_path.as_posix()}"
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    monkeypatch.setattr("app.database.SessionLocal", sessionmaker(bind=engine))
    # Isolate reconciliation: schema creation/migration belongs to preflight.
    monkeypatch.setattr("app.main.init_db", lambda: None)
    monkeypatch.setattr("app.main.cleanup_guided_outputs", lambda: None)
    monkeypatch.setattr(app_main_settings(), "AUDIT_RECONCILE_ON_START", True)
    try:
        with pytest.raises(RuntimeError) as exc:
            with TestClient(app):
                pass
    finally:
        engine.dispose()

    assert isinstance(exc.value.__context__, OperationalError)
    assert db_path.read_bytes() == original
    assert (db_path.stat().st_dev, db_path.stat().st_ino) == (identity.st_dev, identity.st_ino)
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT * FROM audit_records").fetchall() == [
            ("preserve-existing-audit", document_path, "processing"),
        ]
    msg = str(exc.value)
    assert "not been replaced" in msg.lower()
    assert "close aca" in msg.lower()
    assert "recovery" in msg.lower() and "troubleshooting" in msg.lower()
    _assert_safe_public_message(msg, db_path, database_url, document_path)

    # The real application startup owner, not a mocked protocol API, wrote it.
    record = attempt.path.read_bytes()
    assert 0 < len(record) <= 1024
    assert b"DATABASE_RECONCILIATION_REFUSAL" in record
    assert document_path.encode() not in record
    assert database_url.encode() not in record
    category = ls.consume_startup_failure(attempt, root)
    assert category == "DATABASE_RECONCILIATION_REFUSAL"
    assert not attempt.path.exists()

    # Exercise real parent launcher classification using a real fake-child record.
    result = ownership_launcher(
        "new", first_owned=True, child_exit=3, failure_category=category,
    )
    assert result.rc == 1
    assert len(result.dialogs) == 1
    assert result.dialogs[0][1] == ls.MB_OK | ls.MB_ICONERROR
    public_message = result.dialogs[0][0]
    _assert_safe_public_message(public_message, db_path, database_url, document_path)
    assert "protect" in public_message.lower()
    assert "recovery" in public_message.lower()
    category_logs = [entry for entry in result.logs if category in entry]
    assert category_logs and all(len(entry) <= 512 for entry in category_logs)
    assert len([event for event in result.events if isinstance(event, tuple) and event[0] == "popen"]) == 1
    assert not any(
        isinstance(event, tuple) and event[0] in ("browser", "write_instance")
        for event in result.events
    )


def test_database_initialization_failure_records_category_and_preserves_exception(monkeypatch, tmp_path):
    from app import launcher_support as ls

    root, attempt = _startup_attempt(monkeypatch, tmp_path)
    original = RuntimeError(r"sqlite:///c:\private\student-draft.docx")
    calls = []

    def fail_init():
        raise original

    monkeypatch.setattr("app.main.init_db", fail_init)
    monkeypatch.setattr("app.main.cleanup_guided_outputs", lambda: calls.append("cleanup"))
    monkeypatch.setattr("app.main.reconcile_stale_audits", lambda *args, **kwargs: calls.append("reconcile"))
    with pytest.raises(RuntimeError) as exc:
        with TestClient(app):
            pass
    assert exc.value is original
    assert calls == []
    record = attempt.path.read_bytes()
    assert 0 < len(record) <= 1024
    assert b"private" not in record and b".docx" not in record
    assert ls.consume_startup_failure(attempt, root) == "DATABASE_UPGRADE_OR_VERIFICATION_FAILURE"


@pytest.mark.parametrize("owner", ["init", "reconcile"])
@pytest.mark.parametrize("writer_raises", [False, True])
def test_failure_record_problem_does_not_hide_startup_failure(monkeypatch, owner, writer_raises):
    from app import launcher_support as ls

    original = RuntimeError("sensitive original failure")
    categories = []

    def fail_startup(*args, **kwargs):
        raise original

    def fail_record(category):
        categories.append(category)
        if writer_raises:
            raise OSError("sensitive status path")
        return False

    monkeypatch.setattr(ls, "write_startup_failure", fail_record)
    monkeypatch.setattr("app.main.init_db", fail_startup if owner == "init" else lambda: None)
    monkeypatch.setattr("app.main.cleanup_guided_outputs", lambda: None)
    monkeypatch.setattr("app.main.reconcile_stale_audits", fail_startup)
    monkeypatch.setattr(app_main_settings(), "AUDIT_RECONCILE_ON_START", True)
    with pytest.raises(RuntimeError) as exc:
        with TestClient(app):
            pass
    if owner == "init":
        assert exc.value is original
        assert categories == ["DATABASE_UPGRADE_OR_VERIFICATION_FAILURE"]
    else:
        assert exc.value.__context__ is original
        assert "sensitive" not in str(exc.value)
        assert "recovery" in str(exc.value).lower()
        assert categories == ["DATABASE_RECONCILIATION_REFUSAL"]


def _startup_attempt(monkeypatch, tmp_path):
    from app import launcher_support as ls

    root = ls.get_user_data_root(tmp_path / "startup-root")
    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT", str(root.path))
    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT_DEV", str(root.dev))
    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT_INO", str(root.ino))
    attempt = ls.new_startup_attempt(root)
    for name, value in attempt.environment().items():
        monkeypatch.setenv(name, value)
    return root, attempt


def _assert_safe_public_message(message, db_path, database_url, document_path):
    lowered = message.lower()
    for sensitive in (
        "alembic", "upgrade head", str(db_path), database_url, document_path,
        "traceback", "operationalerror", "no such column", "sqlite://",
        "preserve-existing-audit", ".docx", "c:\\",
    ):
        assert sensitive.lower() not in lowered


def app_main_settings():
    from app.main import settings
    return settings


