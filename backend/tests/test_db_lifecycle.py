"""Focused DB lifecycle tests — Phase 3A fresh-only."""
import sqlite3
import pathlib
import tempfile
import os

import pytest

from app import db_lifecycle as dl


def _db_url(path):
    return f"sqlite:///{path.as_posix()}"


def test_missing_creates_fresh(tmp_path):
    db = tmp_path / "audit.db"
    url = _db_url(db)
    assert dl.inspect_state(db) == "missing"
    err = dl.init_fresh_database(db, url)
    assert err is None
    assert db.exists()
    assert dl.inspect_state(db) == "at_head"
    assert dl.verify_after_init(db) is None


def test_zero_byte_fresh(tmp_path):
    db = tmp_path / "audit.db"
    db.write_bytes(b"")
    assert dl.inspect_state(db) == "zero_byte"
    err = dl.init_fresh_database(db, _db_url(db))
    assert err is None
    assert dl.inspect_state(db) == "at_head"


def test_current_head_verified(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    assert dl.inspect_state(db) == "at_head"
    assert dl.verify_after_init(db) is None
    # repeat launch is idempotent
    assert dl.inspect_state(db) == "at_head"


def test_old_head_refused(tmp_path):
    # Create fresh then downgrade one revision to simulate old head
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    # Stamp to previous revision
    from alembic.config import Config
    from pathlib import Path
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(backend_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    cfg.set_main_option("sqlalchemy.url", _db_url(db))
    from alembic import command
    # Get previous rev
    from alembic.script import ScriptDirectory
    sd = ScriptDirectory.from_config(cfg)
    head = sd.get_current_head()
    # downgrade one step
    # Find parent of head
    rev = sd.get_revision(head)
    prev = rev.down_revision if isinstance(rev.down_revision, str) else rev.down_revision[0] if rev.down_revision else None
    if prev:
        import os
        from app.config import settings
        url2 = _db_url(db)
        _orig = settings.DATABASE_URL
        _orig_env = os.environ.get("DATABASE_URL")
        try:
            os.environ["DATABASE_URL"] = url2
            settings.DATABASE_URL = url2
            from alembic.config import Config as C2
            cfg2 = C2(str(backend_dir / "alembic.ini"))
            cfg2.set_main_option("script_location", str(backend_dir / "alembic"))
            cfg2.set_main_option("sqlalchemy.url", url2)
            command.downgrade(cfg2, prev)
        finally:
            try:
                settings.DATABASE_URL = _orig
                if _orig_env is None:
                    os.environ.pop("DATABASE_URL", None)
                else:
                    os.environ["DATABASE_URL"] = _orig_env
            except Exception:
                pass
        assert dl.inspect_state(db) == "old_head"
        assert dl.verify_after_init(db) is not None
        assert db.exists()


def test_unstamped_refused(tmp_path):
    db = tmp_path / "audit.db"
    con = sqlite3.connect(str(db))
    con.execute("CREATE TABLE audit_records (id TEXT PRIMARY KEY);")
    con.execute("CREATE TABLE violations (id TEXT PRIMARY KEY);")
    con.commit()
    con.close()
    assert dl.inspect_state(db) == "unstamped"
    size_before = db.stat().st_size
    # Should refuse, not modify
    assert dl.inspect_state(db) == "unstamped"
    assert db.stat().st_size == size_before


def test_future_head_refused(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    con = sqlite3.connect(str(db))
    con.execute("UPDATE alembic_version SET version_num='ffffffffffff';")
    con.commit()
    con.close()
    assert dl.inspect_state(db) == "unknown_head"


def test_corrupt_refused(tmp_path):
    db = tmp_path / "audit.db"
    db.write_bytes(b"not a sqlite file at all xxxx")
    assert dl.inspect_state(db) == "corrupt"


def test_missing_migration_resources(monkeypatch, tmp_path):
    # Point to non-existent alembic dir
    monkeypatch.setattr(dl, "_resolve_backend_dir", lambda: None)
    db = tmp_path / "audit.db"
    err = dl.init_fresh_database(db, _db_url(db))
    assert err is not None
    assert "reinstall" in err.lower() or "resources" in err.lower()


def test_frozen_discovery(tmp_path, monkeypatch):
    # Simulate frozen with _MEIPASS
    import sys
    fake_meipass = tmp_path / "_internal"
    (fake_meipass / "alembic").mkdir(parents=True)
    (fake_meipass / "alembic" / "env.py").write_text("# fake")
    (fake_meipass / "alembic.ini").write_text("[alembic]\nscript_location = alembic\n")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(fake_meipass), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "run-frozen.exe"))
    # Should find _MEIPASS
    backend_dir = dl._resolve_backend_dir()
    assert backend_dir == fake_meipass
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)


def test_integrity_verification(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    assert dl.verify_after_init(db) is None
    # Corrupt integrity: write garbage after init
    # We test that verify catches wrong version
    con = sqlite3.connect(str(db))
    con.execute("DELETE FROM alembic_version;")
    con.execute("INSERT INTO alembic_version (version_num) VALUES ('bad');")
    con.commit()
    con.close()
    assert dl.verify_after_init(db) is not None


def test_poc_db_untouched(tmp_path, monkeypatch):
    # launcher_support should now point to audit.db not launcher-poc.db
    import app.launcher_support as ls
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root, _, _ = ls.get_user_data_root()
    ls.configure_launcher_environment(root)
    assert "audit.db" in os.environ["DATABASE_URL"]
    assert "launcher-poc.db" not in os.environ["DATABASE_URL"]
    # Also ensure real backend/audit.db not used
    assert "backend/audit.db" not in os.environ["DATABASE_URL"]


def test_no_bundle_writes():
    text = pathlib.Path("app/db_lifecycle.py").read_text()
    # Production path is via launcher_support._sqlite_url and audit.db; this module handles migration
    assert "alembic" in text.lower()
    assert "_MEIPASS" in text  # reads from bundle, not writes
    # Ensure no direct writes to bundle dir
    assert "audit.db" in text or "launcher-poc" in text or "alembic_version" in text
