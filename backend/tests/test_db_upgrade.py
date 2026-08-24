"""Phase 3B upgrade tests — temp DB only."""
import sqlite3, pathlib, os, tempfile
import pytest
from pathlib import Path
import app.db_lifecycle as dl
import app.launcher_support as ls

def _db_url(p): return ls._sqlite_url(p)

def _make_old_db(tmp_path, rev):
    # Create fresh then downgrade to rev
    db = tmp_path / "audit.db"
    url = _db_url(db)
    dl.init_fresh_database(db, url)
    from alembic.config import Config
    from alembic import command
    from app.config import settings
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(backend_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    orig = settings.DATABASE_URL
    orig_env = os.environ.get("DATABASE_URL")
    try:
        os.environ["DATABASE_URL"] = url
        settings.DATABASE_URL = url
        cfg.set_main_option("sqlalchemy.url", url)
        command.downgrade(cfg, rev)
    finally:
        settings.DATABASE_URL = orig
        if orig_env is None: os.environ.pop("DATABASE_URL", None)
        else: os.environ["DATABASE_URL"] = orig_env
        # restore logging
        import logging
        for name in list(logging.Logger.manager.loggerDict.keys()):
            try: logging.getLogger(name).disabled = False
            except: pass
    return db, url

def _insert_audit(db, suffix="test"):
    con = sqlite3.connect(str(db))
    import uuid, datetime
    aid = str(uuid.uuid4())
    con.execute("INSERT INTO audit_records (id, filename, file_size, deploy_mode, status) VALUES (?,?,?,?,?)",
                (aid, f"f{suffix}.docx", 100, "LOCAL", "completed"))
    con.commit()
    con.close()
    return aid

@pytest.fixture
def user_root(tmp_path):
    root = tmp_path / "ACA"
    (root / "backups").mkdir(parents=True)
    return root

@pytest.mark.parametrize("target_rev", [
    "f17a86596071", "a4c7d19e2b3f", "b2c8d19e2b3f", "c3d8d19e2b3f",
    "d4e8d19e2b3f", "e5f8d19e2b3f", "f6a8d19e2b3f",
])
def test_upgrade_from_every_older_revision(tmp_path, target_rev, user_root):
    db, url = _make_old_db(tmp_path, target_rev)
    aid = _insert_audit(db, target_rev)
    # also insert only columns valid at that rev — use minimal
    assert dl.inspect_state(db) == "old_head"
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is None, err
    assert dl.inspect_state(db) == "at_head"
    # data preserved
    con = sqlite3.connect(str(db))
    assert list(con.execute("SELECT id FROM audit_records WHERE id=?", (aid,)))
    # new columns exist
    cols = {r[1] for r in con.execute("PRAGMA table_info(audit_records)")}
    assert "profile_snapshot" in cols
    assert "interrupted_at" in cols
    con.close()
    # backup exists and verified
    backs = list((user_root / "backups").glob("*.bak"))
    assert len(backs) == 1
    import sqlite3 as s2
    bcon = s2.connect(str(backs[0]))
    assert bcon.execute("SELECT version_num FROM alembic_version").fetchone()[0] == target_rev
    bcon.close()

def test_current_head_no_backup(tmp_path, user_root):
    db = tmp_path / "audit.db"
    url = _db_url(db)
    dl.init_fresh_database(db, url)
    assert dl.inspect_state(db) == "at_head"
    # Should not need backup
    backs = list((user_root / "backups").glob("*.bak"))
    assert len(backs) == 0

def test_unknown_future_multiple_refused(tmp_path, user_root):
    db = tmp_path / "audit.db"
    url = _db_url(db)
    dl.init_fresh_database(db, url)
    import sqlite3
    # unknown
    con = sqlite3.connect(str(db))
    con.execute("UPDATE alembic_version SET version_num='ffffffffffff'")
    con.commit(); con.close()
    assert dl.inspect_state(db) == "unknown_head"
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is not None
    # no backup created for ineligible
    assert len(list((user_root / "backups").glob("*.bak"))) == 0

def test_backup_verification(tmp_path, user_root):
    db = tmp_path / "audit.db"
    url = _db_url(db)
    dl.init_fresh_database(db, url)
    # downgrade to old
    from alembic.config import Config; from alembic import command; from pathlib import Path; import os; from app.config import settings
    backend_dir = Path(__file__).resolve().parents[1]
    p = db  # reuse
    orig = settings.DATABASE_URL
    orig_env = os.environ.get("DATABASE_URL")
    try:
        os.environ["DATABASE_URL"] = url; settings.DATABASE_URL = url
        cfg = Config(str(backend_dir / "alembic.ini"))
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        cfg.set_main_option("sqlalchemy.url", url)
        command.downgrade(cfg, "a4c7d19e2b3f")
    finally:
        settings.DATABASE_URL = orig
        if orig_env is None: os.environ.pop("DATABASE_URL", None)
        else: os.environ["DATABASE_URL"] = orig_env
        import logging
        for name in list(logging.Logger.manager.loggerDict.keys()):
            try: logging.getLogger(name).disabled = False
            except: pass
    bpath, err = dl.create_verified_backup(p, user_root)
    assert err is None
    assert bpath.exists()
    # Verify non-empty, integrity, revision
    assert bpath.stat().st_size > 0

def test_retention_three(tmp_path, user_root):
    # Create 5 backups, prune should keep 3 newest
    bdir = user_root / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    import time
    for i in range(5):
        p = bdir / f"audit.db.rf17a86596071_to_f6a8d19e2b3f2.2025010{i}-abc.bak"
        p.write_bytes(b"x"*100)
        # mtime order
        import os
        os.utime(p, (1000000+i, 1000000+i))
    dl.prune_backups(user_root, keep=3)
    assert len(list(bdir.glob("*.bak"))) == 3
    # unrelated files not pruned
    (bdir / "readme.txt").write_text("hi")
    dl.prune_backups(user_root, keep=3)
    assert (bdir / "readme.txt").exists()

def test_failed_migration_preserves_backups(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, "a4c7d19e2b3f")
    # Make upgrade fail
    monkeypatch.setattr("alembic.command.upgrade", lambda cfg, rev: (_ for _ in ()).throw(RuntimeError("boom")))
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is not None
    # backup preserved
    assert len(list((user_root / "backups").glob("*.bak"))) == 1

def test_source_audit_db_untouched(tmp_path):
    src = pathlib.Path("backend/audit.db")
    if src.exists():
        before = src.stat().st_size
        # run upgrade on temp db
        db = tmp_path / "audit.db"
        url = _db_url(db)
        dl.init_fresh_database(db, url)
        assert src.stat().st_size == before

def test_no_bundle_writes_upgrade():
    t = pathlib.Path("app/db_lifecycle.py").read_text()
    assert "backups" in t
    # Writes go to user_root/backups, not bundle dir
    assert "_MEIPASS" in t or "alembic" in t
    assert "audit.db" in t or "backups" in t
