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
    # Create 5 verified backups, prune should keep 3 newest
    bdir = user_root / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        p = _make_verified_backup_file(bdir, src_rev="f17a86596071", ts=f"2026110{i+1}-120000", rand=f"rand0{i}")
        import os
        os.utime(p, (1000000+i, 1000000+i))
    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is True
    assert res["retained_identity_count"] == 3
    assert len(list(bdir.glob("*.bak"))) == 3
    # unrelated files not pruned
    (bdir / "readme.txt").write_text("hi")
    res2 = dl.prune_backups(user_root, keep=3)
    assert res2["invariant_satisfied"] is True
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
# ===========================================================================
# B-DB-04 Retention Safety, Verification, and Identity Tests
# ===========================================================================

def _make_verified_backup_file(
    bdir: Path,
    src_rev: str = "f17a86596071",
    tgt_rev: str = "f6a8d19e2b3f",
    ts: str = "20261107-120000",
    rand: str = "abcdef",
    corrupt: bool = False,
    bad_rev: bool = False,
    zero_byte: bool = False,
    fk_fail: bool = False,
) -> Path:
    fname = f"audit.db.r{src_rev}_to_{tgt_rev}.{ts}-{rand}.bak"
    p = bdir / fname
    if zero_byte:
        p.touch()
        return p
    if corrupt:
        p.write_bytes(b"corrupt SQLite data")
        return p
    con = sqlite3.connect(str(p))
    con.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL);")
    rev_to_insert = "mismatched" if bad_rev else src_rev
    con.execute("INSERT INTO alembic_version (version_num) VALUES (?);", (rev_to_insert,))
    if fk_fail:
        con.execute("CREATE TABLE parent (id INT PRIMARY KEY);")
        con.execute("CREATE TABLE child (id INT, pid INT, FOREIGN KEY (pid) REFERENCES parent(id));")
        con.execute("INSERT INTO child VALUES (1, 999);")
    con.commit()
    con.close()
    return p


def test_b_db_04_stable_ntfs_identity_validation(tmp_path):
    f1 = tmp_path / "f1.txt"
    f1.write_text("test1")
    f2 = tmp_path / "f2.txt"
    os.link(f1, f2)
    s1 = os.lstat(f1)
    s2 = os.lstat(f2)
    assert (s1.st_dev, s1.st_ino) == (s2.st_dev, s2.st_ino)
    assert s1.st_dev != 0 and s1.st_ino != 0
    f3 = tmp_path / "f3.txt"
    f3.write_text("test3")
    s3 = os.lstat(f3)
    assert (s1.st_dev, s1.st_ino) != (s3.st_dev, s3.st_ino)


def test_b_db_04_exact_filename_grammar():
    valid = "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-120000-abcdef.bak"
    m = dl._BACKUP_FILENAME_RE.match(valid)
    assert m is not None
    assert m.group("source_rev") == "f17a86596071"
    assert m.group("target_rev") == "f6a8d19e2b3f"
    assert m.group("timestamp") == "20261107-120000"
    assert m.group("random") == "abcdef"

    invalid_names = [
        "audit.db.bak",
        "audit.db.r_to_f6a8d19e2b3f.20261107-120000-abcdef.bak",
        "audit.db.rf17a86596071_to_.20261107-120000-abcdef.bak",
        "audit.db.rf17a86596071_to_f6a8d19e2b3f.2026110-120000-abcdef.bak",
        "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-120000-abc.bak",
        "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-120000-abcdef.pending",
        "prefix_audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-120000-abcdef.bak",
    ]
    for inv in invalid_names:
        assert dl._BACKUP_FILENAME_RE.match(inv) is None


def test_b_db_04_stored_revision_equals_source_rev(user_root):
    bdir = user_root / "backups"
    b1 = _make_verified_backup_file(bdir, src_rev="f17a86596071", ts="20261107-120000")
    res = dl.prune_backups(user_root, keep=3)
    assert res["verified_identity_count_before"] == 1
    assert res["retained_identity_count"] == 1


def test_b_db_04_stored_revision_may_differ_from_target_rev(user_root):
    bdir = user_root / "backups"
    b1 = _make_verified_backup_file(bdir, src_rev="f17a86596071", tgt_rev="diffhead01", ts="20261107-120000")
    res = dl.prune_backups(user_root, keep=3)
    assert res["verified_identity_count_before"] == 1
    assert res["retained_identity_count"] == 1


def test_b_db_04_expected_invalid_candidates_not_deleted(user_root):
    bdir = user_root / "backups"
    p_mal = bdir / "malformed.bak"
    p_mal.write_bytes(b"bad")
    p_zero = _make_verified_backup_file(bdir, ts="20261107-100000", rand="zero01", zero_byte=True)
    p_corr = _make_verified_backup_file(bdir, ts="20261107-100001", rand="corr01", corrupt=True)
    p_badrev = _make_verified_backup_file(bdir, ts="20261107-100002", rand="brev01", bad_rev=True)
    p_fk = _make_verified_backup_file(bdir, ts="20261107-100003", rand="fk0001", fk_fail=True)
    p_valid = _make_verified_backup_file(bdir, ts="20261107-100004", rand="val001")

    res = dl.prune_backups(user_root, keep=3)
    assert res["verified_identity_count_before"] == 1
    assert res["invariant_satisfied"] is True
    assert p_mal.exists() and p_zero.exists() and p_corr.exists() and p_badrev.exists() and p_fk.exists() and p_valid.exists()


def test_b_db_04_operational_ambiguity_causes_zero_deletions(user_root, monkeypatch):
    bdir = user_root / "backups"
    p1 = _make_verified_backup_file(bdir, ts="20261107-100000", rand="aaaaaa")
    p2 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="bbbbbb")
    p3 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="cccccc")
    p4 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="dddddd")

    # Simulate discovery stat failure
    real_lstat = os.lstat
    def _fake_lstat(path, *args, **kwargs):
        if Path(path).name == p1.name:
            raise OSError("Simulated discovery stat failure")
        return real_lstat(path, *args, **kwargs)
    monkeypatch.setattr(os, "lstat", _fake_lstat)

    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is False
    assert res["deleted_identity_count"] == 0
    assert p1.exists() and p2.exists() and p3.exists() and p4.exists()


def test_b_db_04_retention_counts_zero_one_three_four(user_root):
    bdir = user_root / "backups"
    # Zero
    r0 = dl.prune_backups(user_root, keep=3)
    assert r0["verified_identity_count_before"] == 0
    assert r0["retained_identity_count"] == 0

    # One
    b1 = _make_verified_backup_file(bdir, ts="20261107-100000", rand="aaaaaa")
    r1 = dl.prune_backups(user_root, keep=3)
    assert r1["verified_identity_count_before"] == 1
    assert r1["retained_identity_count"] == 1

    # Exactly three
    b2 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="bbbbbb")
    b3 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="cccccc")
    r3 = dl.prune_backups(user_root, keep=3)
    assert r3["verified_identity_count_before"] == 3
    assert r3["retained_identity_count"] == 3

    # Four: oldest pruned
    b4 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="dddddd")
    r4 = dl.prune_backups(user_root, keep=3)
    assert r4["verified_identity_count_before"] == 4
    assert r4["retained_identity_count"] == 3
    assert not b1.exists()
    assert b2.exists() and b3.exists() and b4.exists()


def test_b_db_04_protected_sorting_first_boundary_outside_top_three(user_root):
    bdir = user_root / "backups"
    b_head = dl._get_bundled_head() or "f6a8d19e2b3f"
    
    # Protected sorting first (newest)
    p_newest = _make_verified_backup_file(bdir, tgt_rev=b_head, ts="20261107-140000", rand="pnew01")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="old001")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="old002")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="old003")
    r_first = dl.prune_backups(user_root, keep=3, protected_backup=p_newest)
    assert r_first["protected_override"] is False
    assert p_newest.exists()

    # Protected sorting at boundary (3rd of 4)
    # Clear bdir
    for f in bdir.glob("*.bak"): f.unlink()
    p_mid = _make_verified_backup_file(bdir, tgt_rev=b_head, ts="20261107-120000", rand="pmid01")
    b_older = _make_verified_backup_file(bdir, ts="20261107-110000", rand="bold01")
    b_newer1 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="bnew01")
    b_newer2 = _make_verified_backup_file(bdir, ts="20261107-140000", rand="bnew02")
    r_mid = dl.prune_backups(user_root, keep=3, protected_backup=p_mid)
    assert r_mid["protected_override"] is False
    assert p_mid.exists()
    assert not b_older.exists()

    # Protected sorting outside top three (oldest of 4 due to clock skew)
    for f in bdir.glob("*.bak"): f.unlink()
    p_oldest = _make_verified_backup_file(bdir, tgt_rev=b_head, ts="20261107-090000", rand="pold01")
    f1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="f00001")
    f2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="f00002")
    f3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="f00003")
    r_outside = dl.prune_backups(user_root, keep=3, protected_backup=p_oldest)
    assert r_outside["protected_override"] is True
    assert p_oldest.exists()
    assert not f1.exists()  # oldest non-protected pruned
    assert f2.exists() and f3.exists()


def test_b_db_04_protected_aliases_count_once_and_retained(user_root):
    bdir = user_root / "backups"
    b_head = dl._get_bundled_head() or "f6a8d19e2b3f"
    pb = _make_verified_backup_file(bdir, tgt_rev=b_head, ts="20261107-120000", rand="prot01")
    pb_alias = bdir / f"audit.db.rf17a86596071_to_{b_head}.20261107-120000-alias1.bak"
    os.link(pb, pb_alias)

    b1 = _make_verified_backup_file(bdir, ts="20261107-100000", rand="other1")
    b2 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="other2")

    res = dl.prune_backups(user_root, keep=3, protected_backup=pb)
    assert res["verified_identity_count_before"] == 3
    assert res["retained_identity_count"] == 3
    assert pb.exists() and pb_alias.exists()


def test_b_db_04_retained_non_protected_aliases_count_once(user_root):
    bdir = user_root / "backups"
    b1 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="base01")
    b1_alias = bdir / "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-120000-alias2.bak"
    os.link(b1, b1_alias)

    b2 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="base02")

    res = dl.prune_backups(user_root, keep=3)
    assert res["verified_identity_count_before"] == 2
    assert res["retained_identity_count"] == 2
    assert b1.exists() and b1_alias.exists() and b2.exists()


def test_b_db_04_multipath_deletion_candidate_aborts(user_root):
    bdir = user_root / "backups"
    # Create 3 newer files and 1 oldest file with 2 aliases (deletion candidate)
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="del001")
    b_del_alias = bdir / "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-090000-del002.bak"
    os.link(b_del, b_del_alias)

    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="new001")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="new002")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="new003")

    res = dl.prune_backups(user_root, keep=3)
    assert res["alias_ambiguity_count"] == 1
    assert res["invariant_satisfied"] is False
    assert res["deleted_identity_count"] == 0
    assert res["deleted_path_count"] == 0
    # Verifies neither alias was arbitrarily deleted, and no all-alias deletion
    assert b_del.exists() and b_del_alias.exists()


def test_b_db_04_candidate_replacement_before_unlink_stops(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="delrep")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    # Tamper with file identity immediately before unlink
    real_lstat = os.lstat
    calls = 0
    def _fake_lstat(path, *args, **kwargs):
        nonlocal calls
        st = real_lstat(path, *args, **kwargs)
        if Path(path).name == b_del.name:
            calls += 1
            if calls > 1:
                class FakeStat:
                    st_dev = st.st_dev
                    st_ino = st.st_ino + 9999
                    st_size = st.st_size
                    st_mtime_ns = st.st_mtime_ns
                    st_mode = st.st_mode
                return FakeStat()
        return st
    monkeypatch.setattr(os, "lstat", _fake_lstat)

    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is False
    assert res["deleted_identity_count"] == 0
    assert b_del.exists()


def test_b_db_04_candidate_changed_to_symlink_stops(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="delsym")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    calls_sym = 0
    def _fake_symlink(self):
        nonlocal calls_sym
        if self.name == b_del.name:
            calls_sym += 1
            return calls_sym > 1
        return False
    monkeypatch.setattr(Path, "is_symlink", _fake_symlink)
    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is False
    assert res["deleted_identity_count"] == 0
    assert b_del.exists()


def test_b_db_04_preunlink_lstat_failure_stops(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="delsta")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    real_lstat = os.lstat
    calls = 0
    def _faulty_lstat(path, *args, **kwargs):
        nonlocal calls
        if Path(path).name == b_del.name:
            calls += 1
            if calls > 1:
                raise OSError("Pre-unlink lstat permission error")
        return real_lstat(path, *args, **kwargs)
    monkeypatch.setattr(os, "lstat", _faulty_lstat)

    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is False
    assert res["deleted_identity_count"] == 0
    assert b_del.exists()


def test_b_db_04_unlink_failure_sets_invariant_false(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="delfa1")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    monkeypatch.setattr(Path, "unlink", lambda self: (_ for _ in ()).throw(PermissionError("Locked")))

    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is False
    assert res["deleted_path_count"] == 0
    assert res["deleted_identity_count"] == 0
    assert b_del.exists()


def test_b_db_04_postunlink_alias_discovery_stops(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del = _make_verified_backup_file(bdir, ts="20261107-090000", rand="delpos")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    # Simulate discovery of a lingering alias post-unlink
    target_id = (os.lstat(b_del).st_dev, os.lstat(b_del).st_ino)
    real_iterdir = Path.iterdir
    def _fake_iterdir(self):
        entries = list(real_iterdir(self))
        if self == bdir:
            # create fake alias entry
            fake = bdir / "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-090000-ghost1.bak"
            fake.touch()
            entries.append(fake)
        return entries
    
    real_lstat = os.lstat
    def _fake_lstat(path, *args, **kwargs):
        if Path(path).name.endswith("ghost1.bak"):
            class GhostStat:
                st_dev = target_id[0]
                st_ino = target_id[1]
            return GhostStat()
        return real_lstat(path, *args, **kwargs)

    # Apply only after unlink
    real_unlink = Path.unlink
    def _hooked_unlink(self):
        real_unlink(self)
        monkeypatch.setattr(Path, "iterdir", _fake_iterdir)
        monkeypatch.setattr(os, "lstat", _fake_lstat)
    monkeypatch.setattr(Path, "unlink", _hooked_unlink)

    res = dl.prune_backups(user_root, keep=3)
    assert res["deleted_path_count"] == 1
    assert res["deleted_identity_count"] == 0
    assert res["invariant_satisfied"] is False


def test_b_db_04_partial_deletion_accounting(user_root, monkeypatch):
    bdir = user_root / "backups"
    b_del1 = _make_verified_backup_file(bdir, ts="20261107-080000", rand="del001")
    b_del2 = _make_verified_backup_file(bdir, ts="20261107-090000", rand="del002")
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")
    b3 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="keep03")

    real_unlink = Path.unlink
    unlinked = 0
    def _one_then_fail_unlink(self):
        nonlocal unlinked
        if unlinked == 0:
            unlinked += 1
            real_unlink(self)
        else:
            raise OSError("Second unlink failed")
    monkeypatch.setattr(Path, "unlink", _one_then_fail_unlink)

    res = dl.prune_backups(user_root, keep=3)
    assert res["deleted_path_count"] == 1
    assert res["deleted_identity_count"] == 1
    assert res["invariant_satisfied"] is False
    assert not b_del2.exists()
    assert b_del1.exists()


def test_b_db_04_deterministic_equal_timestamp_ordering(user_root):
    bdir = user_root / "backups"
    # Same timestamp, different filenames
    b_a = _make_verified_backup_file(bdir, ts="20261107-100000", rand="aaaaaa")
    b_b = _make_verified_backup_file(bdir, ts="20261107-100000", rand="bbbbbb")
    import os
    os.utime(b_a, (2000, 2000))
    os.utime(b_b, (2000, 2000))
    b1 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="keep01")
    b2 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="keep02")

    # b_a sorts before b_b alphabetically, so with keep=3, b_b is oldest and unlinked
    res = dl.prune_backups(user_root, keep=3)
    assert res["invariant_satisfied"] is True
    assert b_a.exists()
    assert not b_b.exists()


def test_b_db_04_invalid_keep_causes_zero_deletion(user_root):
    bdir = user_root / "backups"
    b1 = _make_verified_backup_file(bdir, ts="20261107-100000", rand="aaaaaa")
    for inv in [0, -1, "3", True, 2.5]:
        res = dl.prune_backups(user_root, keep=inv)
        assert res["invariant_satisfied"] is False
        assert res["deleted_identity_count"] == 0
        assert b1.exists()


def test_b_db_04_safe_idempotent_retry(user_root):
    bdir = user_root / "backups"
    b1 = _make_verified_backup_file(bdir, ts="20261107-100000", rand="aaaaaa")
    b2 = _make_verified_backup_file(bdir, ts="20261107-110000", rand="bbbbbb")
    b3 = _make_verified_backup_file(bdir, ts="20261107-120000", rand="cccccc")
    b4 = _make_verified_backup_file(bdir, ts="20261107-130000", rand="dddddd")

    r1 = dl.prune_backups(user_root, keep=3)
    assert r1["deleted_identity_count"] == 1
    assert r1["retained_identity_count"] == 3

    r2 = dl.prune_backups(user_root, keep=3)
    assert r2["deleted_identity_count"] == 0
    assert r2["retained_identity_count"] == 3
    assert r2["invariant_satisfied"] is True


def test_b_db_04_caller_logs_debt_without_failing_migration(tmp_path, user_root, monkeypatch):
    db, url = _make_old_db(tmp_path, _OLD_REV)
    bdir = user_root / "backups"

    # Plant a multi-path deletion candidate in bdir so retention encounters alias ambiguity
    b_del = _make_verified_backup_file(bdir, ts="20261107-080000", rand="del001")
    b_del_alias = bdir / "audit.db.rf17a86596071_to_f6a8d19e2b3f.20261107-080000-del002.bak"
    os.link(b_del, b_del_alias)
    _make_verified_backup_file(bdir, ts="20261107-090000", rand="del003")
    _make_verified_backup_file(bdir, ts="20261107-100000", rand="del004")

    logged_warnings = []
    class MockLogger:
        def info(self, *a, **k): pass
        def warning(self, msg, *a, **k):
            logged_warnings.append(msg % a if a else msg)

    err = dl.upgrade_existing_database(db, url, user_root, logger=MockLogger())
    assert err is None  # Migration itself succeeded!
    assert any("backup_retention_debt" in w for w in logged_warnings)


def test_b_db_04_documentation_wording():
    doc_path = Path(__file__).resolve().parents[2] / "docs" / "PRIVACY.md"
    assert doc_path.exists()
    content = doc_path.read_text(encoding="utf-8")
    expected = "verified backups, up to three backup identities retained, including the current upgrade backup and the newest remaining verified backups"
    assert expected in content


def test_b_db_04_b_db_05_boundary_preserved(user_root):
    bdir = dl._backup_dir(user_root)
    assert bdir == user_root / "backups"
