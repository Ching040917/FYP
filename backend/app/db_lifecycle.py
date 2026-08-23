"""Production database lifecycle — Phase 3A fresh-only.

Resolves Alembic resources in source and frozen mode, creates a fresh
production database via ``alembic upgrade head``, and verifies
integrity + schema + head. No upgrade of existing stamped databases.
"""
import sqlite3
from pathlib import Path
import sys


def _get_bundled_head() -> str | None:
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        backend_dir = _resolve_backend_dir()
        if backend_dir is None:
            return None
        cfg = Config()
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        return ScriptDirectory.from_config(cfg).get_current_head()
    except Exception:
        return None


def _resolve_backend_dir() -> Path | None:
    if getattr(sys, "frozen", False):
        # PyInstaller one-folder: check _MEIPASS first then exe dir
        meipass = getattr(sys, "_MEIPASS", None)
        candidates = []
        if meipass:
            candidates.append(Path(meipass))
        candidates.append(Path(sys.executable).resolve().parent)
        for c in candidates:
            if (c / "alembic" / "env.py").is_file() or (c / "alembic.ini").is_file():
                return c
            # In collected layout, alembic may be under _internal parent?
            if (c.parent / "alembic" / "env.py").is_file():
                return c.parent
        # Fallback: look for alembic next to exe's parent _internal
        exe_dir = Path(sys.executable).resolve().parent
        for p in [exe_dir, exe_dir / "_internal", exe_dir.parent]:
            if (p / "alembic" / "env.py").is_file():
                return p
        return None
    # Source mode
    here = Path(__file__).resolve()
    for parent in [here.parent.parent, here.parent.parent.parent / "backend"]:
        if (parent / "alembic" / "env.py").is_file():
            return parent
    return None


def _get_alembic_config(db_url: str):
    from alembic.config import Config
    backend_dir = _resolve_backend_dir()
    if backend_dir is None:
        return None, "Migration resources not found."
    alembic_ini = backend_dir / "alembic.ini"
    if not alembic_ini.is_file():
        return None, "Migration resources not found."
    cfg = Config(str(alembic_ini))
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    cfg.set_main_option("sqlalchemy.url", db_url)
    return cfg, None


def _db_path_from_url(db_url: str) -> Path | None:
    prefix = "sqlite:///"
    if not db_url.startswith(prefix):
        return None
    raw = db_url[len(prefix):]
    raw = raw.lstrip("/")
    if len(raw) >= 2 and raw[1] == ":":
        return Path(raw)
    if raw.startswith("/"):
        return Path(raw)
    return Path(raw).resolve()


def inspect_state(db_path: Path) -> str:
    """Return state string for db_path."""
    if not db_path.exists():
        return "missing"
    if db_path.stat().st_size == 0:
        # Treat 0-byte as fresh if no sidecars/tables
        # Check sidecars
        if (db_path.parent / (db_path.name + "-wal")).exists():
            return "corrupt"
        if (db_path.parent / (db_path.name + "-shm")).exists():
            return "corrupt"
        return "zero_byte"
    # Try integrity
    try:
        con = sqlite3.connect(str(db_path))
        try:
            cur = con.execute("PRAGMA integrity_check;")
            row = cur.fetchone()
            if not row or row[0] != "ok":
                return "corrupt"
        finally:
            con.close()
    except Exception:
        return "corrupt"
    # Check tables
    try:
        con = sqlite3.connect(str(db_path))
        try:
            cur = con.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = {r[0] for r in cur.fetchall()}
        finally:
            con.close()
    except Exception:
        return "corrupt"
    has_audit = "audit_records" in tables
    has_version = "alembic_version" in tables
    if not has_audit and not has_version:
        # Empty file with header but no tables — treat as missing fresh
        if len(tables) == 0:
            return "missing"
        return "corrupt"
    if has_audit and not has_version:
        return "unstamped"
    if has_version:
        try:
            con = sqlite3.connect(str(db_path))
            try:
                cur = con.execute("SELECT version_num FROM alembic_version;")
                rows = cur.fetchall()
                if len(rows) != 1:
                    return "corrupt"
                ver = rows[0][0]
                head = _get_bundled_head()
                if head and ver == head:
                    return "at_head"
                # Known older?
                from alembic.config import Config
                from alembic.script import ScriptDirectory
                backend_dir = _resolve_backend_dir()
                if backend_dir:
                    cfg = Config()
                    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
                    revs = {r.revision for r in ScriptDirectory.from_config(cfg).walk_revisions()}
                    if ver in revs:
                        return "old_head"
                    return "unknown_head"
                return "unknown_head"
            finally:
                con.close()
        except Exception:
            return "corrupt"
    return "corrupt"


def verify_after_init(db_path: Path) -> str | None:
    """Verify fresh DB after upgrade. Returns None if OK, else error string."""
    try:
        con = sqlite3.connect(str(db_path))
        try:
            cur = con.execute("PRAGMA integrity_check;")
            if cur.fetchone()[0] != "ok":
                return "Integrity check failed."
        finally:
            con.close()
    except Exception as e:
        return f"Integrity check failed: {type(e).__name__}"

    # Exactly one version matching head
    try:
        con = sqlite3.connect(str(db_path))
        try:
            cur = con.execute("SELECT version_num FROM alembic_version;")
            rows = cur.fetchall()
            if len(rows) != 1:
                return "Version verification failed."
            head = _get_bundled_head()
            if head and rows[0][0] != head:
                return "Version verification failed."
        finally:
            con.close()
    except Exception as e:
        return f"Version verification failed: {type(e).__name__}"

    # Required tables/columns
    try:
        con = sqlite3.connect(str(db_path))
        try:
            cur = con.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = {r[0] for r in cur.fetchall()}
            for t in ("audit_records", "violations", "citation_issues", "alembic_version"):
                if t not in tables:
                    return f"Required table {t} missing."
            cur = con.execute("PRAGMA table_info(audit_records);")
            cols = {r[1] for r in cur.fetchall()}
            for c in ("interrupted_at", "interruption_reason"):
                if c not in cols:
                    return f"Required column {c} missing."
        finally:
            con.close()
    except Exception as e:
        return f"Schema verification failed: {type(e).__name__}"

    return None


def init_fresh_database(db_path: Path, db_url: str, logger=None) -> str | None:
    """Run alembic upgrade head. Returns None on success, else error message."""
    cfg, err = _get_alembic_config(db_url)
    if err:
        if logger:
            logger.info("alembic_resources_missing")
        return "Migration resources are missing. Please reinstall ACA."
    # Preserve caller state — never leak DATABASE_URL or logging config
    import os
    from app.config import settings
    _orig_db_url = settings.DATABASE_URL
    _orig_env = os.environ.get("DATABASE_URL")
    # Snapshot logging state: alembic fileConfig mutates loggers and disables existing ones
    import logging
    _all_loggers = {name: logging.getLogger(name) for name in list(logging.Logger.manager.loggerDict.keys())}
    _orig_disabled_map = {name: lg.disabled for name, lg in _all_loggers.items()}
    _root_logger = logging.getLogger()
    _orig_handlers = list(_root_logger.handlers)
    _orig_level = _root_logger.level
    _orig_disabled = _root_logger.disabled
    try:
        from alembic import command
        db_path.parent.mkdir(parents=True, exist_ok=True)
        os.environ["DATABASE_URL"] = db_url
        settings.DATABASE_URL = db_url
        cfg.set_main_option("sqlalchemy.url", db_url)
        if logger:
            logger.info("alembic_upgrade_start head=%s", _get_bundled_head())
        command.upgrade(cfg, "head")
        cfg.set_main_option("sqlalchemy.url", db_url)
        if logger:
            logger.info("alembic_upgrade_done")
    except Exception as e:
        if logger:
            logger.info("alembic_upgrade_failed category=%s", type(e).__name__)
        return "Database initialization failed. Please try again."
    finally:
        # Restore DATABASE_URL and logging — never leak to next test
        try:
            settings.DATABASE_URL = _orig_db_url
            if _orig_env is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = _orig_env
        except Exception:
            pass
        try:
            for h in list(_root_logger.handlers):
                if h not in _orig_handlers:
                    _root_logger.removeHandler(h)
                    try:
                        h.close()
                    except Exception:
                        pass
            _root_logger.setLevel(_orig_level)
            _root_logger.disabled = _orig_disabled
            for name, was_disabled in _orig_disabled_map.items():
                try:
                    lg = logging.getLogger(name)
                    lg.disabled = was_disabled
                except Exception:
                    pass
            # Also re-enable any logger that was disabled by fileConfig's disable_existing_loggers
            for name in list(logging.Logger.manager.loggerDict.keys()):
                if name not in _orig_disabled_map:
                    try:
                        logging.getLogger(name).disabled = False
                    except Exception:
                        pass
        except Exception:
            pass
    # Verify
    err = verify_after_init(db_path)
    if err:
        if logger:
            logger.info("fresh_verify_failed category=%s", err)
        return err
    return None
