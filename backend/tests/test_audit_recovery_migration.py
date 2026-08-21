"""Stale Audit recovery — migration tests (Build 1).

Verifies the `f6a8d19e2b3f2` migration adds/removes only the two nullable
recovery columns on a TEMPORARY SQLite database. Never touches the real
backend/audit.db.
"""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from app.config import settings as app_settings


def _columns(url):
    return {c["name"] for c in inspect(create_engine(url)).get_columns("audit_records")}


def test_migration_upgrade_adds_both_nullable_columns(tmp_path, monkeypatch):
    db_path = tmp_path / "recovery.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    monkeypatch.setattr(app_settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    cols = _columns(url)
    assert "interruption_reason" in cols
    assert "interrupted_at" in cols


def test_migration_downgrade_removes_only_those_columns(tmp_path, monkeypatch):
    db_path = tmp_path / "recovery2.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    monkeypatch.setattr(app_settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    command.downgrade(cfg, "f6a8d19e2b3f")
    cols = _columns(url)
    assert "interruption_reason" not in cols
    assert "interrupted_at" not in cols
    # Unrelated columns survive.
    assert "profile_snapshot" in cols
    assert "rendered_preview_status" in cols


def test_migration_reupgrade_succeeds(tmp_path, monkeypatch):
    db_path = tmp_path / "recovery3.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    monkeypatch.setattr(app_settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    command.downgrade(cfg, "f6a8d19e2b3f")
    command.upgrade(cfg, "head")
    cols = _columns(url)
    assert "interruption_reason" in cols
    assert "interrupted_at" in cols
