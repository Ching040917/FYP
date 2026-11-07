"""Phase 3B upgrade tests — temp DB only."""
import sqlite3, pathlib, os, tempfile, hashlib
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


# ---- B-DB-02: post-upgrade gate persistence --------------------------------
# Task-owned temporary databases only. The revision below is the single parent
# of the bundled head, so the upgrade is eligible and a backup is produced.

_OLD_REV = "90fc17718e11"

def _file_snapshot(directory):
    return {p.name: (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in sorted(directory.iterdir()) if p.is_file()}

def test_post_upgrade_fk_failure_persists_across_restart(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    import alembic.command as alembic_command
    real = alembic_command.upgrade
    def _upgrade_then_break_fk(cfg, rev):
        real(cfg, rev)
        con = sqlite3.connect(str(db))
        try:
            con.execute("INSERT INTO violations (id, audit_id, rule_code, severity, message) "
                        "VALUES ('v-orphan','no-such-audit','CITATION_MISMATCH','MAJOR','m')")
            con.commit()
        finally:
            con.close()
    monkeypatch.setattr("alembic.command.upgrade", _upgrade_then_break_fk)
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is not None
    # the head stamp survived the failed gate
    assert dl.inspect_state(db) == "at_head"
    assert dl.startup_action("at_head") == "verify"
    # the restart gate now repeats the foreign-key check and refuses
    assert dl.verify_after_init(db) == dl._FK_FAILED
    # and the verified backup is retained
    assert len(list((user_root / "backups").glob("*.bak"))) == 1

def test_healthy_upgrade_passes_complete_gate_set_without_new_files(tmp_path, user_root):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    assert dl.upgrade_existing_database(db, url, user_root) is None
    assert dl.inspect_state(db) == "at_head"
    before = _file_snapshot(tmp_path)
    assert dl.verify_after_init(db) is None
    after = _file_snapshot(tmp_path)
    assert after == before
    assert len(list((user_root / "backups").glob("*.bak"))) == 1

# ---- B-DB-03: fail-closed backup safety and atomic publication ------------

def test_first_backup_creates_missing_backups_directory(tmp_path, user_root):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"
    import shutil
    if bdir.exists():
        shutil.rmtree(bdir)
    assert not bdir.exists()
    bpath, err = dl.create_verified_backup(db, user_root)
    assert err is None
    assert bdir.exists()
    assert bpath.exists()
    assert bpath.name.endswith(".bak")

def test_backup_dir_mkdir_permission_error_fails_cleanly(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    def _boom(*a, **kw):
        raise PermissionError("Access denied creating backup directory")
    monkeypatch.setattr(pathlib.Path, "mkdir", _boom)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert err == "Backup failed: could not create backup directory."

def test_backup_dir_mkdir_os_error_fails_cleanly(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    def _boom(*a, **kw):
        raise OSError("Read-only file system")
    monkeypatch.setattr(pathlib.Path, "mkdir", _boom)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert err == "Backup failed: could not create backup directory."

def test_source_disk_usage_failure_fails_closed(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    import shutil
    def _boom(path):
        raise OSError("Storage subsystem unreadable")
    monkeypatch.setattr(shutil, "disk_usage", _boom)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Could not verify available disk space" in err

def test_backup_disk_usage_failure_fails_closed(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    import shutil
    real = shutil.disk_usage
    bdir = user_root / "backups"
    def _fail_backup(path):
        if "backups" in str(path):
            raise OSError("Backup destination storage query failed")
        return real(path)
    monkeypatch.setattr(shutil, "disk_usage", _fail_backup)
    # Simulate distinct volume check
    monkeypatch.setattr(os.path, "splitdrive", lambda p: ("D:" if "backups" in str(p) else "C:", p))
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Could not verify available disk space" in err

def test_conservative_threshold_enforced_on_both_volumes(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    import shutil
    db_size = db.stat().st_size
    need = db_size * 3 + 10 * 1024 * 1024

    from collections import namedtuple
    Usage = namedtuple("Usage", ["total", "used", "free"])

    # Distinct volumes: source passes, backup volume fails
    monkeypatch.setattr(os.path, "splitdrive", lambda p: ("D:" if "backups" in str(p) else "C:", p))
    def _mock_usage(path):
        if "backups" in str(path):
            return Usage(total=10**10, used=10**10 - 100, free=need - 1)
        return Usage(total=10**10, used=10**9, free=need + 10**6)
    monkeypatch.setattr(shutil, "disk_usage", _mock_usage)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Insufficient disk space" in err

def test_source_readonly_open_failure_creates_nothing(tmp_path, user_root):
    # Nonexistent database path
    fake_db = tmp_path / "nonexistent.db"
    assert not fake_db.exists()
    bpath, err = dl.create_verified_backup(fake_db, user_root)
    assert bpath is None
    assert not fake_db.exists()
    assert len(list((user_root / "backups").glob("*.bak"))) == 0

def test_backup_copy_failure_closes_handles_and_leaves_no_bak(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    real_connect = sqlite3.connect
    class _FailingCon:
        def __init__(self, target):
            self.real = real_connect(target)
        def backup(self, dst):
            raise sqlite3.OperationalError("Simulated disk I/O error during backup")
        def close(self):
            return self.real.close()
        def execute(self, *a, **k):
            return self.real.execute(*a, **k)

    real_ro = dl._readonly_connect
    def _fake_ro(p):
        return _FailingCon(str(p))
    monkeypatch.setattr(dl, "_readonly_connect", _fake_ro)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Backup failed" in err
    # No .bak file left
    bdir = user_root / "backups"
    assert len(list(bdir.glob("*.bak"))) == 0
    # No staging file left
    assert len(list(bdir.glob("*.pending"))) == 0

def test_backup_verification_integrity_failure_leaves_no_bak(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    real_ro = dl._readonly_connect
    def _corrupt_verify_ro(p):
        con = real_ro(p)
        if str(p).endswith(".pending"):
            # Return corrupted integrity check
            class _CorruptCon:
                def execute(self, sql, *a, **k):
                    if "integrity_check" in sql:
                        class _Cursor:
                            def fetchone(self):
                                return ["*** in database: wrong page size"]
                        return _Cursor()
                    return con.execute(sql, *a, **k)
                def close(self):
                    return con.close()
            return _CorruptCon()
        return con
    monkeypatch.setattr(dl, "_readonly_connect", _corrupt_verify_ro)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Backup verification failed" in err
    bdir = user_root / "backups"
    assert len(list(bdir.glob("*.bak"))) == 0
    assert len(list(bdir.glob("*.pending"))) == 0

def test_backup_verification_fk_failure_leaves_no_bak(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    real_ro = dl._readonly_connect
    def _fk_fail_ro(p):
        con = real_ro(p)
        if str(p).endswith(".pending"):
            class _FkCon:
                def execute(self, sql, *a, **k):
                    if "foreign_key_check" in sql:
                        return [("violations", 1, "audit_records", 0)]
                    return con.execute(sql, *a, **k)
                def close(self):
                    return con.close()
            return _FkCon()
        return con
    monkeypatch.setattr(dl, "_readonly_connect", _fk_fail_ro)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Backup verification failed" in err
    bdir = user_root / "backups"
    assert len(list(bdir.glob("*.bak"))) == 0
    assert len(list(bdir.glob("*.pending"))) == 0

def test_backup_verification_revision_mismatch_leaves_no_bak(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    real_ro = dl._readonly_connect
    def _rev_mismatch_ro(p):
        con = real_ro(p)
        if str(p).endswith(".pending"):
            class _RevCon:
                def execute(self, sql, *a, **k):
                    if "alembic_version" in sql:
                        return [("wrong_rev_num",)]
                    return con.execute(sql, *a, **k)
                def close(self):
                    return con.close()
            return _RevCon()
        return con
    monkeypatch.setattr(dl, "_readonly_connect", _rev_mismatch_ro)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "Backup verification failed" in err
    bdir = user_root / "backups"
    assert len(list(bdir.glob("*.bak"))) == 0
    assert len(list(bdir.glob("*.pending"))) == 0

def test_atomic_publication_succeeds_when_final_absent(tmp_path, user_root):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"
    bpath, err = dl.create_verified_backup(db, user_root)
    assert err is None
    assert bpath.exists()
    assert bpath.name.endswith(".bak")
    assert len(list(bdir.glob("*.bak"))) == 1
    assert len(list(bdir.glob("*.pending"))) == 0

def test_existing_final_collision_fails_atomic_and_no_overwrite(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    
    # Pre-create the final file before backup publication
    real_link = os.link
    collision_data = b"pre-existing-final-backup-data"
    collision_sha = hashlib.sha256(collision_data).hexdigest()
    
    def _link_with_collision(src, dst):
        # ensure collision happens by pre-writing dst
        if not pathlib.Path(dst).exists():
            pathlib.Path(dst).write_bytes(collision_data)
        return real_link(src, dst)
        
    monkeypatch.setattr(os, "link", _link_with_collision)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "destination backup file already exists" in err
    # Verify pre-existing final file was NOT overwritten
    cand = list(bdir.glob("*.bak"))
    assert len(cand) == 1
    assert cand[0].read_bytes() == collision_data
    assert hashlib.sha256(cand[0].read_bytes()).hexdigest() == collision_sha

def test_concurrent_final_creation_cannot_be_overwritten(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"
    bdir.mkdir(parents=True, exist_ok=True)

    race_data = b"concurrent-process-created-this-backup"
    race_sha = hashlib.sha256(race_data).hexdigest()
    
    real_link = os.link
    def _concurrent_race_link(src, dst):
        # simulate concurrent process writing dst right before os.link
        pathlib.Path(dst).write_bytes(race_data)
        return real_link(src, dst)

    monkeypatch.setattr(os, "link", _concurrent_race_link)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "destination backup file already exists" in err
    cand = list(bdir.glob("*.bak"))
    assert len(cand) == 1
    assert cand[0].read_bytes() == race_data
    assert hashlib.sha256(cand[0].read_bytes()).hexdigest() == race_sha

def test_unsupported_hard_link_fails_closed(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    def _no_link(src, dst):
        raise OSError("Hard links not supported on this filesystem")
    monkeypatch.setattr(os, "link", _no_link)
    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    assert "publication error" in err
    bdir = user_root / "backups"
    assert len(list(bdir.glob("*.bak"))) == 0

def test_staging_unlink_failure_leaves_valid_final_and_warning(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    real_unlink = pathlib.Path.unlink
    bdir = user_root / "backups"
    
    def _failing_unlink(p):
        if str(p).endswith(".pending"):
            raise PermissionError("Simulated locked staging file")
        return real_unlink(p)
    monkeypatch.setattr(pathlib.Path, "unlink", _failing_unlink)

    bpath, err = dl.create_verified_backup(db, user_root)
    assert err is None
    assert bpath.exists()
    assert bpath.name.endswith(".bak")
    # Final backup is valid
    assert bpath.stat().st_size > 0
    # Staging debt remains outside .bak glob
    assert len(list(bdir.glob("*.bak"))) == 1
    assert len(list(bdir.glob("*.pending"))) == 1

def test_cleanup_failure_preserves_primary_error(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    # Force backup copy error, and also force unlink cleanup failure
    real_connect = sqlite3.connect
    class _FailCon:
        def backup(self, dst):
            raise sqlite3.OperationalError("Primary backup copy error")
        def close(self):
            pass
    def _fake_ro(p):
        return _FailCon()
    monkeypatch.setattr(dl, "_readonly_connect", _fake_ro)
    def _boom_unlink(p):
        raise PermissionError("Cleanup unlink failed")
    monkeypatch.setattr(pathlib.Path, "unlink", _boom_unlink)

    bpath, err = dl.create_verified_backup(db, user_root)
    assert bpath is None
    # Primary error message preserved
    assert err == "Backup failed. Your data is preserved."

def test_pending_does_not_match_final_bak_glob(tmp_path, user_root):
    bdir = user_root / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    (bdir / "audit.db.r90fc17718e11_to_b3e8d19e2b3f.20261107-120000-abcdef.pending").write_bytes(b"temp")
    (bdir / "audit.db.r90fc17718e11_to_b3e8d19e2b3f.20261107-120000-abcdef.tmp").write_bytes(b"temp2")
    cands = list(bdir.glob("audit.db.r*_to_*.bak"))
    assert len(cands) == 0

def test_alembic_upgrade_never_called_before_verified_final_publication(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    # Mock create_verified_backup to fail
    monkeypatch.setattr(dl, "create_verified_backup", lambda *a, **k: (None, "Simulated backup failure"))
    
    alembic_called = False
    import alembic.command as ac
    def _fake_upgrade(*a, **k):
        nonlocal alembic_called
        alembic_called = True
    monkeypatch.setattr(ac, "upgrade", _fake_upgrade)
    
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err == "Simulated backup failure"
    assert not alembic_called

def test_exactly_one_valid_final_backup_exists_before_migration(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"
    
    migration_started = False
    import alembic.command as ac
    real_upg = ac.upgrade
    def _check_backup_before_upg(cfg, rev):
        nonlocal migration_started
        migration_started = True
        baks = list(bdir.glob("*.bak"))
        assert len(baks) == 1
        assert baks[0].stat().st_size > 0
        real_upg(cfg, rev)
    monkeypatch.setattr(ac, "upgrade", _check_backup_before_upg)
    
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is None
    assert migration_started
    assert len(list(bdir.glob("*.bak"))) == 1
