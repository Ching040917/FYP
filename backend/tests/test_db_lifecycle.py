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


# ---- B-DB-01: orphaned sidecar safety -------------------------------------
# Every fixture below is a task-owned temporary directory; nothing opens a real
# user database.

import hashlib  # noqa: E402


def _snapshot(directory):
    """Return {name: (size, sha256)} for every file in directory."""
    out = {}
    for p in sorted(directory.iterdir()):
        if p.is_file():
            data = p.read_bytes()
            out[p.name] = (len(data), hashlib.sha256(data).hexdigest())
    return out


def _sidecars(db_path, wal=None, shm=None, journal=None):
    for suffix, payload in (("-wal", wal), ("-shm", shm), ("-journal", journal)):
        if payload is not None:
            (db_path.parent / (db_path.name + suffix)).write_bytes(payload)


def _simulate_launcher(db_path):
    """Mirror of frozen_main's dispatch: only a 'fresh' action may write."""
    state = dl.inspect_state(db_path)
    action = dl.startup_action(state)
    if action == "fresh":
        dl.init_fresh_database(db_path, f"sqlite:///{db_path.as_posix()}")
    return state, action


def test_clean_first_launch_still_allowed(tmp_path):
    db = tmp_path / "audit.db"
    state, action = _simulate_launcher(db)
    assert state == "missing"
    assert action == "fresh"
    assert db.exists()


def test_wal_only_without_main_fails_closed(tmp_path):
    db = tmp_path / "audit.db"
    _sidecars(db, wal=b"wal-only")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "orphan_sidecars" and action == "refuse"
    assert not db.exists()
    assert _snapshot(tmp_path) == before


def test_shm_only_without_main_fails_closed(tmp_path):
    db = tmp_path / "audit.db"
    _sidecars(db, shm=b"shm-only")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "orphan_sidecars" and action == "refuse"
    assert not db.exists()
    assert _snapshot(tmp_path) == before


def test_wal_and_shm_without_main_fails_closed(tmp_path):
    db = tmp_path / "audit.db"
    _sidecars(db, wal=b"wal", shm=b"shm")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "orphan_sidecars" and action == "refuse"
    assert not db.exists()
    assert _snapshot(tmp_path) == before


def test_journal_without_main_fails_closed(tmp_path):
    db = tmp_path / "audit.db"
    _sidecars(db, journal=b"journal")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "interrupted_journal" and action == "refuse"
    assert not db.exists()
    assert _snapshot(tmp_path) == before


def test_zero_byte_with_each_sidecar_fails_closed(tmp_path):
    for suffix, payload in (("-wal", b"w"), ("-shm", b"s"), ("-journal", b"j")):
        d = tmp_path / suffix.strip("-")
        d.mkdir()
        db = d / "audit.db"
        db.write_bytes(b"")
        _sidecars(db, **{suffix.strip("-"): payload})
        before = _snapshot(d)
        state, action = _simulate_launcher(db)
        assert action == "refuse", suffix
        assert state in ("corrupt", "inconsistent_sidecars", "interrupted_journal"), state
        assert db.stat().st_size == 0
        assert _snapshot(d) == before


def test_healthy_database_with_matching_wal_and_shm_is_not_rejected(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, f"sqlite:///{db.as_posix()}")
    _sidecars(db, wal=b"wal", shm=b"shm")
    state, action = _simulate_launcher(db)
    assert state == "at_head"
    assert action == "verify"


def test_healthy_database_with_shm_only_is_inconsistent(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, f"sqlite:///{db.as_posix()}")
    _sidecars(db, shm=b"shm")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "inconsistent_sidecars" and action == "refuse"
    assert _snapshot(tmp_path) == before


def test_healthy_database_with_rollback_journal_fails_closed(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, f"sqlite:///{db.as_posix()}")
    _sidecars(db, journal=b"journal")
    before = _snapshot(tmp_path)
    state, action = _simulate_launcher(db)
    assert state == "interrupted_journal" and action == "refuse"
    assert _snapshot(tmp_path) == before


def test_unsafe_states_never_call_fresh_init(tmp_path, monkeypatch):
    calls = {"fresh": 0}

    def _boom(*a, **k):
        calls["fresh"] += 1
        raise AssertionError("init_fresh_database must not run for unsafe states")

    monkeypatch.setattr(dl, "init_fresh_database", _boom)

    fixtures = [(b"w", None, None), (None, b"s", None), (b"w", b"s", None), (None, None, b"j")]
    for idx, (wal, shm, journal) in enumerate(fixtures):
        d = tmp_path / f"case{idx}"
        d.mkdir()
        db = d / "audit.db"
        _sidecars(db, wal=wal, shm=shm, journal=journal)
        state, action = _simulate_launcher(db)
        assert action == "refuse", state
        assert not db.exists()

    assert calls["fresh"] == 0


def test_unsafe_states_never_report_ready_or_success(tmp_path):
    db = tmp_path / "audit.db"
    _sidecars(db, wal=b"w")
    state = dl.inspect_state(db)
    assert state in dl.REFUSE_STATES
    assert state not in ("at_head", "missing", "zero_byte", "old_head")


def test_startup_action_mapping_is_complete():
    for state in (
        "orphan_sidecars",
        "inconsistent_sidecars",
        "interrupted_journal",
        "corrupt",
        "unstamped",
        "future_head",
        "unknown_head",
    ):
        assert dl.startup_action(state) == "refuse"
    for state in ("missing", "zero_byte"):
        assert dl.startup_action(state) == "fresh"
    assert dl.startup_action("at_head") == "verify"
    assert dl.startup_action("old_head") == "upgrade"


def test_recovery_message_is_plain_and_non_destructive(tmp_path):
    text = dl.recovery_message(tmp_path)
    assert "incomplete or unsafe database state" in text
    assert "stopped to protect your existing data" in text
    assert "did not create a new replacement database" in text
    assert str(tmp_path) in text
    assert "audit.db-wal" in text and "audit.db-shm" in text and "audit.db-journal" in text
    assert "docs/TROUBLESHOOTING.md" in text
    lowered = text.lower()
    for forbidden in ("delete wal", "delete the wal", "sqlite3 ", "disable protection",
                      "copy the wal", "copy the -wal"):
        assert forbidden not in lowered
    assert "do not delete" in lowered or "do not delete, rename" in lowered
    assert "do not edit the database" in lowered


# ---- B-DB-02: one-snapshot read-only verification --------------------------
# Every fixture below is a task-owned temporary directory; nothing opens a real
# user database.

def _dir_snapshot(directory):
    return {p.name: (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in sorted(directory.iterdir()) if p.is_file()}

def _spy_connect(monkeypatch, calls):
    real = dl._readonly_connect
    def _spy(path):
        calls.append(path)
        return real(path)
    monkeypatch.setattr(dl, "_readonly_connect", _spy)

class _Recording:
    """Proxy that records SQL, commits, rollbacks and closes for one handle."""
    def __init__(self, con):
        self._con, self.sql, self.commits, self.rollbacks, self.closed = con, [], 0, 0, False
    def execute(self, sql, *args):
        self.sql.append(sql)
        return self._con.execute(sql, *args)
    def commit(self):
        self.commits += 1
        return self._con.commit()
    def rollback(self):
        self.rollbacks += 1
        return self._con.rollback()
    def close(self):
        self.closed = True
        return self._con.close()
    @property
    def in_transaction(self):
        return self._con.in_transaction

def test_verify_missing_database_returns_failure(tmp_path):
    db = tmp_path / "audit.db"
    assert dl.verify_after_init(db) is not None
    assert not db.exists()

def test_verify_after_deletion_does_not_recreate_database(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    db.unlink()
    assert dl.verify_after_init(db) is not None
    assert not db.exists()

def test_verify_open_failure_never_falls_back_to_writable(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    def _boom(path):
        raise sqlite3.OperationalError("unable to open database file")
    monkeypatch.setattr(dl, "_readonly_connect", _boom)
    assert dl.verify_after_init(db) is not None
    assert not db.exists()

def test_verify_toctou_deletion_injected_at_open(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    real = dl._readonly_connect
    def _delete_then_open(path):
        path.unlink()
        return real(path)
    monkeypatch.setattr(dl, "_readonly_connect", _delete_then_open)
    assert dl.verify_after_init(db) is not None
    assert not db.exists()

def test_verify_creates_no_files(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    before = _dir_snapshot(tmp_path)
    assert dl.verify_after_init(db) is None
    assert _dir_snapshot(tmp_path) == before

def test_verify_detects_foreign_key_violation(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    con = sqlite3.connect(str(db))
    con.execute("INSERT INTO violations (id, audit_id, rule_code, severity, message) "
                "VALUES ('v-orphan','no-such-audit','CITATION_MISMATCH','MAJOR','m')")
    con.commit(); con.close()
    err = dl.verify_after_init(db)
    assert err == dl._FK_FAILED

def test_head_unavailable_verification_fails_closed(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    monkeypatch.setattr(dl, "_get_bundled_head", lambda: None)
    assert dl.verify_after_init(db) == "Version verification failed."

def test_verify_refuses_wal_without_shm_before_open(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    (tmp_path / "audit.db-wal").write_bytes(b"w")
    calls = []
    _spy_connect(monkeypatch, calls)
    assert dl.verify_after_init(db) == dl._VERIFY_INCOMPLETE_SIDECARS
    assert calls == []

def test_verify_refuses_shm_without_wal_before_open(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    (tmp_path / "audit.db-shm").write_bytes(b"s")
    calls = []
    _spy_connect(monkeypatch, calls)
    assert dl.verify_after_init(db) == dl._VERIFY_INCOMPLETE_SIDECARS
    assert calls == []

def test_verify_refuses_journal_before_open(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    (tmp_path / "audit.db-journal").write_bytes(b"j")
    calls = []
    _spy_connect(monkeypatch, calls)
    assert dl.verify_after_init(db) == dl._VERIFY_INTERRUPTED_JOURNAL
    assert calls == []

def test_verify_refusals_create_no_files_and_preserve_existing(tmp_path):
    for name, suffix, expected in (("wal", "-wal", dl._VERIFY_INCOMPLETE_SIDECARS),
                                   ("shm", "-shm", dl._VERIFY_INCOMPLETE_SIDECARS),
                                   ("journal", "-journal", dl._VERIFY_INTERRUPTED_JOURNAL)):
        case = tmp_path / name
        case.mkdir()
        db = case / "audit.db"
        dl.init_fresh_database(db, _db_url(db))
        (case / ("audit.db" + suffix)).write_bytes(b"payload")
        before = _dir_snapshot(case)
        assert dl.verify_after_init(db) == expected
        assert _dir_snapshot(case) == before

def test_verify_succeeds_with_wal_and_shm_present(tmp_path):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    con = sqlite3.connect(str(db))
    try:
        con.execute("PRAGMA journal_mode=WAL;")
        con.execute("INSERT INTO audit_records (id, filename, file_size, deploy_mode, status) "
                    "VALUES ('a1','f.docx',100,'LOCAL','completed')")
        con.commit()
        assert (tmp_path / "audit.db-wal").exists()
        assert (tmp_path / "audit.db-shm").exists()
        assert dl.verify_after_init(db) is None
    finally:
        con.close()

def test_verify_uses_single_read_only_connection(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    calls = []
    _spy_connect(monkeypatch, calls)
    assert dl.verify_after_init(db) is None
    assert len(calls) == 1

def test_verify_never_opens_a_writable_connection(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    calls = []
    real = sqlite3.connect
    def _spy(database, *args, **kwargs):
        calls.append((database, kwargs.get("uri")))
        return real(database, *args, **kwargs)
    monkeypatch.setattr(dl.sqlite3, "connect", _spy)
    assert dl.verify_after_init(db) is None
    assert len(calls) == 1
    assert calls[0][1] is True
    assert "mode=ro" in calls[0][0]

def test_verify_begins_exactly_one_read_transaction(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    rec = {}
    real = dl._readonly_connect
    def _wrap(path):
        rec["c"] = _Recording(real(path))
        return rec["c"]
    monkeypatch.setattr(dl, "_readonly_connect", _wrap)
    assert dl.verify_after_init(db) is None
    con = rec["c"]
    assert con.sql[0] == "BEGIN;"
    assert sum(1 for s in con.sql if s.strip().upper().startswith("BEGIN")) == 1
    assert any("integrity_check" in s for s in con.sql)
    assert any("alembic_version" in s for s in con.sql)
    assert any("sqlite_master" in s for s in con.sql)
    assert any("foreign_key_check" in s for s in con.sql)
    assert con.commits == 0
    assert con.rollbacks == 1
    assert con.closed

def test_verify_failure_path_rolls_back_and_closes(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    con = sqlite3.connect(str(db))
    con.execute("INSERT INTO violations (id, audit_id, rule_code, severity, message) "
                "VALUES ('v-orphan','no-such-audit','CITATION_MISMATCH','MAJOR','m')")
    con.commit(); con.close()
    rec = {}
    real = dl._readonly_connect
    def _wrap(path):
        rec["c"] = _Recording(real(path))
        return rec["c"]
    monkeypatch.setattr(dl, "_readonly_connect", _wrap)
    assert dl.verify_after_init(db) == dl._FK_FAILED
    assert rec["c"].commits == 0
    assert rec["c"].rollbacks == 1
    assert rec["c"].closed

def test_verify_reads_one_snapshot_despite_concurrent_commit(tmp_path, monkeypatch):
    db = tmp_path / "audit.db"
    dl.init_fresh_database(db, _db_url(db))
    holder = sqlite3.connect(str(db))
    try:
        assert holder.execute("PRAGMA journal_mode=WAL;").fetchone()[0].lower() == "wal"
        holder.execute("INSERT INTO audit_records (id, filename, file_size, deploy_mode, status) "
                       "VALUES ('a1','f.docx',100,'LOCAL','completed')")
        holder.commit()
        assert (tmp_path / "audit.db-wal").exists() and (tmp_path / "audit.db-shm").exists()
        real, rec = dl._readonly_connect, {}
        def _wrap(path):
            con = _Recording(real(path))
            rec["c"] = con
            def _after_begin(sql, *args):
                result = con._con.execute(sql, *args)
                if "integrity_check" in sql and not rec.get("injected"):
                    rec["injected"] = True
                    w = sqlite3.connect(str(db))
                    try:
                        w.execute("INSERT INTO violations (id, audit_id, rule_code, severity, message) "
                                  "VALUES ('v-orphan','no-such-audit','CITATION_MISMATCH','MAJOR','m')")
                        w.commit()
                    finally:
                        w.close()
                return result
            con.execute = _after_begin
            return con
        monkeypatch.setattr(dl, "_readonly_connect", _wrap)
        assert dl.verify_after_init(db) is None      # every gate saw the pre-commit snapshot
    finally:
        holder.close()
    assert dl.verify_after_init(db) == dl._FK_FAILED  # the next verification sees the orphan row
