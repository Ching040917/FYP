"""Stale Audit recovery — startup integration tests (Build 1).

Verifies the startup sequence calls reconciliation after database init,
that the disabled setting skips it, and that a schema mismatch produces a
clear migration-oriented failure. Never touches backend/audit.db.
"""
import pytest
from fastapi.testclient import TestClient

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


def test_reconciliation_failure_fails_startup_with_migration_hint(monkeypatch):
    monkeypatch.setattr("app.main.init_db", lambda: None)

    def _boom(db, process_started_at, enabled=True):
        raise RuntimeError("no such column: interruption_reason")
    monkeypatch.setattr("app.main.reconcile_stale_audits", _boom)
    monkeypatch.setattr(app_main_settings(), "AUDIT_RECONCILE_ON_START", True)
    c = TestClient(app)
    with pytest.raises(RuntimeError) as exc:
        with c:
            pass
    msg = str(exc.value)
    assert "alembic upgrade head" in msg
    # No document content / paths leak into the public error.
    assert ".docx" not in msg
    assert "c:\\" not in msg.lower()


def app_main_settings():
    from app.main import settings
    return settings


