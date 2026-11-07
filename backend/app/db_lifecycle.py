"""Production database lifecycle — Phase 3A fresh-only.

Resolves Alembic resources in source and frozen mode, creates a fresh
production database via ``alembic upgrade head``, and verifies
integrity + schema + head. No upgrade of existing stamped databases.
"""
import datetime
import os
import re
import sqlite3
import sys
from pathlib import Path


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


_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")

# States where startup must refuse before any database write. Kept as one
# frozenset so the launcher and the tests share a single source of truth.
REFUSE_STATES = frozenset({
    "unstamped",
    "future_head",
    "unknown_head",
    "corrupt",
    "orphan_sidecars",
    "inconsistent_sidecars",
    "interrupted_journal",
})

# States that may legitimately reach a fresh initialization. Anything not in
# STARTUP_ACTIONS is treated as a refusal by the launcher.
STARTUP_ACTIONS = {
    "missing": "fresh",
    "zero_byte": "fresh",
    "at_head": "verify",
    "old_head": "upgrade",
}


def _sidecar_paths(db_path: Path) -> tuple[Path, Path, Path]:
    """Return the -wal, -shm and -journal siblings of db_path."""
    parent = db_path.parent
    name = db_path.name
    return tuple(parent / (name + suffix) for suffix in _SIDECAR_SUFFIXES)  # type: ignore[return-value]


def startup_action(state: str) -> str:
    """Map an inspect_state result to a startup action token.

    ``fresh`` initializes a new database, ``verify`` re-verifies an up-to-date
    database, ``upgrade`` runs the eligible upgrade path, and ``refuse`` stops
    startup before any write.
    """
    if state in REFUSE_STATES:
        return "refuse"
    return STARTUP_ACTIONS.get(state, "refuse")


def recovery_message(root: Path | None = None) -> str:
    """Plain-language recovery message — no deletion, no SQLite commands."""
    location = str(root) if root is not None else "the application data folder"
    return (
        "ACA found an incomplete or unsafe database state.\n"
        "Startup was stopped to protect your existing data. ACA did not create a new "
        "replacement database.\n"
        f"Application data that needs review: {location}\n"
        "Keep this whole folder as it is, including audit.db, audit.db-wal, audit.db-shm, "
        "audit.db-journal and the backups folder. Do not delete, rename or separate those "
        "files, and do not edit the database by hand.\n"
        "Back up the complete folder, then follow the recovery guidance in "
        "docs/TROUBLESHOOTING.md (section: ACA found an unsafe database state).\n"
        "Diagnostic information is in the logs folder inside the same data folder."
    )


def inspect_state(db_path: Path) -> str:
    """Return state string for db_path."""
    wal_path, shm_path, journal_path = _sidecar_paths(db_path)
    has_wal = wal_path.exists()
    has_shm = shm_path.exists()
    has_journal = journal_path.exists()

    if not db_path.exists():
        # Orphaned recovery evidence must never be treated as a fresh install.
        if has_journal:
            return "interrupted_journal"
        if has_wal or has_shm:
            return "orphan_sidecars"
        return "missing"

    # A rollback journal means a transaction was interrupted; opening in write
    # mode would roll it back, so refuse before any connection is made.
    if has_journal:
        return "interrupted_journal"

    # -shm without -wal is a sidecar set SQLite cannot reconstruct.
    if has_shm and not has_wal:
        return "inconsistent_sidecars"

    if db_path.stat().st_size == 0:
        # Treat 0-byte as fresh only when no sidecars are present.
        if has_wal or has_shm:
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


_VERIFY_INCOMPLETE_SIDECARS = "Database verification failed: incomplete sidecar set."
_VERIFY_INTERRUPTED_JOURNAL = "Database verification failed: interrupted journal present."
_FK_FAILED = "Foreign key check failed."


def _verification_gate(db_path: Path) -> str | None:
    """Refuse verification when the sidecar set cannot be read without writing.

    Runs before any connection. A rollback journal would be rolled back by a
    write-mode open, and a WAL-mode database missing its -shm (or holding an
    -shm with no -wal) can only be read by creating the missing shared-memory
    file, which verification must never do.
    """
    wal_path, shm_path, journal_path = _sidecar_paths(db_path)
    if journal_path.exists():
        return _VERIFY_INTERRUPTED_JOURNAL
    if wal_path.exists() != shm_path.exists():
        return _VERIFY_INCOMPLETE_SIDECARS
    return None


def _readonly_connect(db_path: Path):
    """Open an existing SQLite file read-only. Never creates a database file."""
    uri = db_path.resolve().as_uri()
    sep = "&" if "?" in uri else "?"
    return sqlite3.connect(f"{uri}{sep}mode=ro", uri=True, timeout=5.0)


def _verify_existing_database(db_path: Path) -> str | None:
    """Verify an existing database inside one read-only snapshot.

    Returns None when every gate passes, else a bounded error string. The gate
    runs immediately before the single open; ``BEGIN`` is deferred, so it stays
    read-only on a mode=ro connection, and every gate then reads the same
    snapshot until the explicit rollback.
    """
    gate = _verification_gate(db_path)
    if gate:
        return gate
    try:
        con = _readonly_connect(db_path)
    except Exception as e:
        return f"Database verification failed: {type(e).__name__}"
    try:
        try:
            con.execute("BEGIN;")
            if con.execute("PRAGMA integrity_check;").fetchone()[0] != "ok":
                return "Integrity check failed."
        except Exception as e:
            return f"Integrity check failed: {type(e).__name__}"

        try:
            rows = list(con.execute("SELECT version_num FROM alembic_version;"))
            head = _get_bundled_head()
            if len(rows) != 1 or not head or rows[0][0] != head:
                return "Version verification failed."
        except Exception as e:
            return f"Version verification failed: {type(e).__name__}"

        try:
            tables = {r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table';")}
            for t in ("audit_records", "violations", "citation_issues", "alembic_version"):
                if t not in tables:
                    return f"Required table {t} missing."
            cols = {r[1] for r in con.execute("PRAGMA table_info(audit_records);")}
            for c in ("interrupted_at", "interruption_reason"):
                if c not in cols:
                    return f"Required column {c} missing."
        except Exception as e:
            return f"Schema verification failed: {type(e).__name__}"

        try:
            if list(con.execute("PRAGMA foreign_key_check;")):
                return _FK_FAILED
        except Exception as e:
            return f"Foreign key check failed: {type(e).__name__}"
    finally:
        try:
            if con.in_transaction:
                con.rollback()
        finally:
            con.close()
    return None


def verify_after_init(db_path: Path) -> str | None:
    """Verify an existing database read-only. Returns None if OK, else error string."""
    return _verify_existing_database(db_path)


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


# ---- Phase 3B: backup + upgrade ----

def _backup_dir(user_root) -> Path:
    # user_root is %LOCALAPPDATA%\AcademicComplianceAuditor
    return Path(user_root) / "backups"


def _is_eligible_old_head(db_path: Path) -> bool:
    """One revision, known, ancestor of head, older than head, unambiguous."""
    try:
        con = sqlite3.connect(str(db_path))
        try:
            rows = list(con.execute("SELECT version_num FROM alembic_version"))
            if len(rows) != 1:
                return False
            ver = rows[0][0]
        finally:
            con.close()
    except Exception:
        return False
    head = _get_bundled_head()
    if not head or ver == head:
        return False
    # Check graph
    backend_dir = _resolve_backend_dir()
    if not backend_dir:
        return False
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory
        cfg = Config()
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        sd = ScriptDirectory.from_config(cfg)
        heads = sd.get_heads()
        if len(heads) != 1 or heads[0] != head:
            return False  # ambiguous/multiple heads
        revs = {r.revision: r for r in sd.walk_revisions()}
        if ver not in revs:
            return False
        # Is ver ancestor of head?
        cur = head
        while cur:
            if cur == ver:
                return True
            r = revs.get(cur)
            if not r:
                break
            dr = r.down_revision
            if isinstance(dr, (list, tuple)):
                if len(dr) != 1:
                    return False
                cur = dr[0]
            else:
                cur = dr
        return False
    except Exception:
        return False


def _check_disk_space(db_path: Path, bdir: Path | None = None) -> str | None:
    import shutil
    import os
    try:
        db_size = db_path.stat().st_size if db_path.exists() else 0
        need = db_size * 3 + 10 * 1024 * 1024  # Approach A conservative threshold

        src_dir = db_path.parent
        free_src = shutil.disk_usage(str(src_dir)).free
        if free_src < need:
            return "Insufficient disk space for safe upgrade. Please free some space and try again."

        if bdir is not None:
            src_vol = os.path.splitdrive(os.path.abspath(src_dir))[0].upper()
            dst_vol = os.path.splitdrive(os.path.abspath(bdir))[0].upper()
            if src_vol != dst_vol:
                free_dst = shutil.disk_usage(str(bdir)).free
                if free_dst < need:
                    return "Insufficient disk space for safe upgrade. Please free some space and try again."
    except Exception:
        return "Could not verify available disk space for safe upgrade. Please check your storage and try again."
    return None


def create_verified_backup(db_path: Path, user_root: Path, logger=None) -> tuple[Path | None, str | None]:
    """Create backup via sqlite3 backup API, verify, and publish atomically without overwrite.

    Returns (final_backup_path, error_msg).
    """
    if not user_root or not isinstance(user_root, Path):
        return None, "Backup failed: invalid user data root."

    bdir = _backup_dir(user_root)
    try:
        bdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        if logger:
            logger.info("backup_dir_create_failed category=%s", type(e).__name__)
        return None, "Backup failed: could not create backup directory."

    # Capacity check after bdir exists (Approach A)
    msg = _check_disk_space(db_path, bdir)
    if msg:
        if logger:
            logger.info("backup_space_check_failed")
        return None, msg

    # Read source revision before backup using read-only connection
    src_con = None
    try:
        src_con = _readonly_connect(db_path)
        rows = list(src_con.execute("SELECT version_num FROM alembic_version;"))
        if len(rows) != 1:
            return None, "Backup failed: source database has ambiguous or missing revision."
        src_ver = rows[0][0]
    except Exception as e:
        if logger:
            logger.info("backup_source_read_failed category=%s", type(e).__name__)
        return None, "Backup failed. Your data is preserved."
    finally:
        if src_con:
            try:
                src_con.close()
            except Exception:
                pass

    head = _get_bundled_head() or "unknown"
    import datetime, random, string, os
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    staging_name = f"audit.db.r{src_ver}_to_{head}.{ts}-{rand}.pending"
    final_name = f"audit.db.r{src_ver}_to_{head}.{ts}-{rand}.bak"
    staging_path = bdir / staging_name
    final_bpath = bdir / final_name

    # Ensure final destination does not already exist
    if final_bpath.exists():
        return None, "Backup failed: destination backup file already exists."

    # Backup API from read-only source to destination staging path
    src_con = None
    dst_con = None
    copy_error = None
    try:
        src_con = _readonly_connect(db_path)
        dst_con = sqlite3.connect(str(staging_path))
        src_con.backup(dst_con)
    except Exception as e:
        copy_error = type(e).__name__
        if logger:
            logger.info("backup_failed category=%s", copy_error)
    finally:
        if dst_con:
            try:
                dst_con.close()
            except Exception:
                pass
        if src_con:
            try:
                src_con.close()
            except Exception:
                pass

    if copy_error is not None:
        try:
            if staging_path.exists():
                staging_path.unlink()
        except Exception as cleanup_err:
            if logger:
                logger.warning("backup_staging_cleanup_failed path=%s", staging_path.name)
        return None, "Backup failed. Your data is preserved."

    # Verify staging backup read-only: non-empty, integrity, foreign_key, revision
    verify_error = None
    try:
        if not staging_path.exists() or staging_path.stat().st_size == 0:
            verify_error = "Backup verification failed: empty or missing staging file."
        else:
            con = _readonly_connect(staging_path)
            try:
                if con.execute("PRAGMA integrity_check;").fetchone()[0] != "ok":
                    verify_error = "Backup verification failed. Your data is preserved."
                elif list(con.execute("PRAGMA foreign_key_check;")):
                    verify_error = "Backup verification failed. Your data is preserved."
                else:
                    v_rows = list(con.execute("SELECT version_num FROM alembic_version;"))
                    if len(v_rows) != 1 or v_rows[0][0] != src_ver:
                        verify_error = "Backup verification failed. Your data is preserved."
            finally:
                con.close()
    except Exception:
        verify_error = "Backup verification failed. Your data is preserved."

    if verify_error is not None:
        if logger:
            logger.info("backup_verification_failed")
        try:
            if staging_path.exists():
                staging_path.unlink()
        except Exception as cleanup_err:
            if logger:
                logger.warning("backup_staging_cleanup_failed path=%s", staging_path.name)
        return None, verify_error

    # Atomic no-overwrite publication via os.link
    try:
        os.link(staging_path, final_bpath)
    except FileExistsError:
        if logger:
            logger.info("backup_publication_collision path=%s", final_bpath.name)
        try:
            if staging_path.exists():
                staging_path.unlink()
        except Exception:
            pass
        return None, "Backup failed: destination backup file already exists."
    except OSError as e:
        if logger:
            logger.info("backup_publication_failed category=%s", type(e).__name__)
        try:
            if staging_path.exists():
                staging_path.unlink()
        except Exception:
            pass
        return None, f"Backup failed: publication error ({type(e).__name__})."

    # Partial-success handling: remove staging link
    try:
        staging_path.unlink()
    except Exception as cleanup_err:
        if logger:
            logger.warning("backup_staging_cleanup_failed path=%s", staging_path.name)

    if logger:
        logger.info("backup_verified revision=%s", src_ver)
    return final_bpath, None


_BACKUP_FILENAME_RE = re.compile(
    r"^audit\.db\.r(?P<source_rev>[A-Za-z0-9]+)_to_(?P<target_rev>[A-Za-z0-9]+)\.(?P<timestamp>\d{8}-\d{6})-(?P<random>[a-z0-9]{6})\.bak$"
)


class _IdentitySortKey:
    __slots__ = ("ts", "mtime_ns", "name", "ident")

    def __init__(self, ts: datetime.datetime, mtime_ns: int, name: str, ident: tuple[int, int]):
        self.ts = ts
        self.mtime_ns = mtime_ns
        self.name = name
        self.ident = ident

    def __lt__(self, other: "_IdentitySortKey") -> bool:
        if self.ts != other.ts:
            return self.ts > other.ts
        if self.mtime_ns != other.mtime_ns:
            return self.mtime_ns > other.mtime_ns
        if self.name != other.name:
            return self.name < other.name
        return self.ident < other.ident


def prune_backups(
    user_root: Path,
    keep: int = 3,
    protected_backup: Path | None = None,
    logger=None,
) -> dict:
    """Retain up to `keep` verified backup identities, including protected_backup.

    Distinguishes path counts from identity counts, excludes symlinks and unverified
    candidates from retention accounting without deleting them, and aborts before
    destructive action on any operational ambiguity or multi-path deletion candidate.
    """
    result = {
        "verified_identity_count_before": 0,
        "planned_identity_deletion_count": 0,
        "deleted_identity_count": 0,
        "deleted_path_count": 0,
        "retained_identity_count": 0,
        "alias_ambiguity_count": 0,
        "warnings": [],
        "protected_override": False,
        "invariant_satisfied": True,
    }

    # 1. Validate keep argument
    if not isinstance(keep, int) or isinstance(keep, bool) or keep < 1:
        result["invariant_satisfied"] = False
        result["warnings"].append("Invalid keep argument: must be integer >= 1.")
        if logger:
            logger.warning("backup_prune_invalid_keep keep=%s", keep)
        return result

    # 2. Validate user_root and directory
    if not user_root or not isinstance(user_root, Path):
        result["invariant_satisfied"] = False
        result["warnings"].append("Invalid user_root: Path required.")
        return result

    bdir = _backup_dir(user_root)
    if not bdir.is_dir():
        return result

    # 3. Discover candidates and collect lstat metadata
    try:
        entries = list(bdir.iterdir())
    except OSError as e:
        result["invariant_satisfied"] = False
        result["warnings"].append(f"Directory discovery failed: {type(e).__name__}")
        if logger:
            logger.warning("backup_prune_discovery_failed category=%s", type(e).__name__)
        return result

    verified_candidates = []
    for p in entries:
        m = _BACKUP_FILENAME_RE.match(p.name)
        if not m:
            continue

        try:
            st = os.lstat(p)
        except OSError as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Stat failure on candidate: {type(e).__name__}")
            if logger:
                logger.warning("backup_prune_stat_failed category=%s", type(e).__name__)
            return result

        if p.is_symlink() or not p.is_file() or st.st_size == 0:
            continue

        cid = (st.st_dev, st.st_ino)
        if cid[0] == 0 or cid[1] == 0:
            result["invariant_satisfied"] = False
            result["warnings"].append("Stable file identity unavailable on filesystem.")
            return result

        src_rev = m.group("source_rev")
        tgt_rev = m.group("target_rev")
        ts_str = m.group("timestamp")
        try:
            parsed_ts = datetime.datetime.strptime(ts_str, "%Y%m%d-%H%M%S")
        except ValueError:
            continue

        # Verify SQLite read-only: integrity, foreign keys, version == SOURCE_REV
        is_verified = False
        try:
            con = _readonly_connect(p)
            try:
                integ = con.execute("PRAGMA integrity_check;").fetchone()
                if integ and integ[0] == "ok":
                    fk = list(con.execute("PRAGMA foreign_key_check;"))
                    if not fk:
                        v_rows = list(con.execute("SELECT version_num FROM alembic_version;"))
                        if len(v_rows) == 1 and v_rows[0][0] == src_rev:
                            is_verified = True
            finally:
                con.close()
        except sqlite3.DatabaseError:
            pass
        except OSError as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Access error verifying candidate: {type(e).__name__}")
            return result
        except Exception:
            pass

        if not is_verified:
            continue

        verified_candidates.append({
            "path": p,
            "name": p.name,
            "identity": cid,
            "parsed_ts": parsed_ts,
            "mtime_ns": st.st_mtime_ns,
            "src_rev": src_rev,
            "tgt_rev": tgt_rev,
        })

    # 4. Validate protected_backup if supplied
    protected_identity = None
    if protected_backup is not None:
        if not isinstance(protected_backup, Path):
            result["invariant_satisfied"] = False
            result["warnings"].append("Invalid protected_backup argument type.")
            return result
        try:
            resolved_pb = protected_backup.resolve()
            resolved_bdir = bdir.resolve()
            if resolved_pb.parent != resolved_bdir:
                result["invariant_satisfied"] = False
                result["warnings"].append("protected_backup outside expected backups directory.")
                return result
        except Exception as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Cannot resolve protected_backup: {type(e).__name__}")
            return result

        if protected_backup.is_symlink() or not protected_backup.is_file():
            result["invariant_satisfied"] = False
            result["warnings"].append("protected_backup is missing, not a regular file, or a symlink.")
            return result

        try:
            pb_st = os.lstat(protected_backup)
            protected_identity = (pb_st.st_dev, pb_st.st_ino)
            if protected_identity[0] == 0 or protected_identity[1] == 0:
                result["invariant_satisfied"] = False
                result["warnings"].append("protected_backup identity unavailable.")
                return result
        except OSError as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Stat failure on protected_backup: {type(e).__name__}")
            return result

        pb_m = _BACKUP_FILENAME_RE.match(protected_backup.name)
        if not pb_m:
            result["invariant_satisfied"] = False
            result["warnings"].append("protected_backup does not match filename grammar.")
            return result

        bundled_head = _get_bundled_head()
        if bundled_head and pb_m.group("target_rev") != bundled_head:
            result["invariant_satisfied"] = False
            result["warnings"].append("protected_backup TARGET_REV does not match bundled head.")
            return result

        # Verify SQLite on protected_backup
        try:
            con = _readonly_connect(protected_backup)
            try:
                integ = con.execute("PRAGMA integrity_check;").fetchone()
                fk = list(con.execute("PRAGMA foreign_key_check;"))
                v_rows = list(con.execute("SELECT version_num FROM alembic_version;"))
                if not integ or integ[0] != "ok" or fk or len(v_rows) != 1 or v_rows[0][0] != pb_m.group("source_rev"):
                    result["invariant_satisfied"] = False
                    result["warnings"].append("protected_backup failed SQLite verification.")
                    return result
            finally:
                con.close()
        except Exception as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Verification failure on protected_backup: {type(e).__name__}")
            return result

    # 5. Group candidates by stable file identity
    identities = {}
    for c in verified_candidates:
        cid = c["identity"]
        if cid not in identities:
            identities[cid] = {"candidates": [], "paths": []}
        identities[cid]["candidates"].append(c)
        identities[cid]["paths"].append(c["path"])

    for cid, data in identities.items():
        cands = data["candidates"]
        best_ts = max(c["parsed_ts"] for c in cands)
        best_mtime_ns = max(c["mtime_ns"] for c in cands)
        best_name = min(c["name"] for c in cands)
        data["sort_key"] = _IdentitySortKey(best_ts, best_mtime_ns, best_name, cid)

    verified_count = len(identities)
    result["verified_identity_count_before"] = verified_count

    if protected_identity is not None and protected_identity not in identities:
        result["invariant_satisfied"] = False
        result["warnings"].append("protected_backup identity not found in verified identities.")
        return result

    if verified_count <= keep:
        result["retained_identity_count"] = verified_count
        return result

    # 6. Sort verified identities deterministically (newest first)
    sorted_identities = sorted(identities.keys(), key=lambda cid: identities[cid]["sort_key"])

    # 7. Compute retained identities set
    retained_identities = set()
    if protected_identity is not None:
        retained_identities.add(protected_identity)
        if protected_identity not in sorted_identities[:keep]:
            result["protected_override"] = True

    for cid in sorted_identities:
        if len(retained_identities) >= min(keep, verified_count):
            break
        retained_identities.add(cid)

    result["retained_identity_count"] = len(retained_identities)

    # 8. Compute planned deletions and check for multi-path ambiguities
    deletion_identities = [cid for cid in sorted_identities if cid not in retained_identities]
    result["planned_identity_deletion_count"] = len(deletion_identities)

    for cid in deletion_identities:
        if len(identities[cid]["paths"]) > 1:
            result["alias_ambiguity_count"] += 1

    if result["alias_ambiguity_count"] > 0:
        result["invariant_satisfied"] = False
        result["warnings"].append(
            f"Deletion candidate has {result['alias_ambiguity_count']} multiple-alias identities; aborting retention."
        )
        if logger:
            logger.warning("backup_prune_alias_ambiguity count=%d", result["alias_ambiguity_count"])
        return result

    # 9. Execute single-path deletions with pre-unlink revalidation & post-unlink confirmation
    for cid in deletion_identities:
        cand_path = identities[cid]["paths"][0]

        # Pre-unlink revalidation
        try:
            re_st = os.lstat(cand_path)
        except OSError as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Pre-unlink stat failed: {type(e).__name__}")
            return result

        if cand_path.is_symlink() or not cand_path.is_file():
            result["invariant_satisfied"] = False
            result["warnings"].append("Pre-unlink check failed: path changed to symlink or non-regular.")
            return result

        curr_id = (re_st.st_dev, re_st.st_ino)
        if curr_id != cid:
            result["invariant_satisfied"] = False
            result["warnings"].append("Pre-unlink check failed: identity mismatch.")
            return result

        if protected_identity is not None and curr_id == protected_identity:
            result["invariant_satisfied"] = False
            result["warnings"].append("Pre-unlink check failed: path is protected backup identity.")
            return result

        try:
            if cand_path.parent.resolve() != bdir.resolve():
                result["invariant_satisfied"] = False
                result["warnings"].append("Pre-unlink check failed: directory mismatch.")
                return result
        except Exception:
            result["invariant_satisfied"] = False
            result["warnings"].append("Pre-unlink check failed: parent resolution error.")
            return result

        if not _BACKUP_FILENAME_RE.match(cand_path.name):
            result["invariant_satisfied"] = False
            result["warnings"].append("Pre-unlink check failed: filename grammar mismatch.")
            return result

        # Unlink single path
        try:
            cand_path.unlink()
            result["deleted_path_count"] += 1
            if logger:
                logger.info("backup_pruned")
        except Exception as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Unlink failed: {type(e).__name__}")
            if logger:
                logger.warning("backup_prune_unlink_failed category=%s", type(e).__name__)
            return result

        # Post-unlink confirmation: confirm path absence
        if cand_path.exists():
            result["invariant_satisfied"] = False
            result["warnings"].append("Post-unlink confirmation failed: path still exists.")
            return result

        # Rescan directory to prove no alias remains for this identity
        lingering_alias = False
        try:
            for other_p in bdir.iterdir():
                if other_p.name == cand_path.name:
                    continue
                if _BACKUP_FILENAME_RE.match(other_p.name):
                    try:
                        ost = os.lstat(other_p)
                        if (ost.st_dev, ost.st_ino) == cid:
                            lingering_alias = True
                            break
                    except OSError:
                        pass
        except Exception as e:
            result["invariant_satisfied"] = False
            result["warnings"].append(f"Post-unlink alias scan failed: {type(e).__name__}")
            return result

        if lingering_alias:
            result["invariant_satisfied"] = False
            result["warnings"].append("Post-unlink confirmation failed: lingering alias discovered.")
            if logger:
                logger.warning("backup_prune_lingering_alias_discovered")
            return result

        result["deleted_identity_count"] += 1

    return result


def upgrade_existing_database(db_path: Path, db_url: str, user_root: Path, logger=None) -> str | None:
    """Full upgrade: backup+verify -> alembic upgrade -> post-verify -> retention.

    Must be called with launcher mutex held and no backend running.
    Returns None on success, else user-facing error.
    """
    # Eligibility already checked by caller (old_head), but re-validate
    if not _is_eligible_old_head(db_path):
        return "This database cannot be upgraded automatically."

    # Backup
    try:
        bpath, err = create_verified_backup(db_path, user_root, logger)
    except Exception as e:
        if logger:
            logger.info("backup_unhandled_exception category=%s", type(e).__name__)
        return f"Backup failed: {type(e).__name__}. Your data is preserved."

    if err:
        return err
    if not bpath or not bpath.exists():
        return "Backup failed: verified backup file missing. Your data is preserved."

    # Snapshot state for restore on failure
    import os
    from app.config import settings
    import logging
    _orig_db_url = settings.DATABASE_URL
    _orig_env = os.environ.get("DATABASE_URL")
    _all_loggers = {name: logging.getLogger(name) for name in list(logging.Logger.manager.loggerDict.keys())}
    _orig_disabled_map = {name: lg.disabled for name, lg in _all_loggers.items()}
    _root_logger = logging.getLogger()
    _orig_handlers = list(_root_logger.handlers)
    _orig_level = _root_logger.level
    _orig_disabled = _root_logger.disabled

    try:
        from alembic import command
        os.environ["DATABASE_URL"] = db_url
        settings.DATABASE_URL = db_url
        cfg, cfg_err = _get_alembic_config(db_url)
        if cfg_err:
            return cfg_err
        cfg.set_main_option("sqlalchemy.url", db_url)
        if logger:
            logger.info("upgrade_start head=%s", _get_bundled_head())
        command.upgrade(cfg, "head")
        if logger:
            logger.info("upgrade_done")
    except Exception as e:
        if logger:
            logger.info("upgrade_failed category=%s", type(e).__name__)
        return "The database upgrade did not complete. Your backup was preserved. ACA cannot start until the database is recovered."
    finally:
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
                    logging.getLogger(name).disabled = was_disabled
                except Exception:
                    pass
            for name in list(logging.Logger.manager.loggerDict.keys()):
                if name not in _orig_disabled_map:
                    try:
                        logging.getLogger(name).disabled = False
                    except Exception:
                        pass
        except Exception:
            pass

    # Post-verification: the same complete gate set the startup path repeats.
    err = verify_after_init(db_path)
    if err:
        if logger:
            if err == _FK_FAILED:
                logger.info("post_upgrade_fk_failed")
            else:
                logger.info("post_upgrade_verify_failed category=%s", err)
        return "The database upgrade did not complete. Your backup was preserved. ACA cannot start until the database is recovered."

    # Retention only after all success
    retention_result = prune_backups(
        user_root,
        keep=3,
        protected_backup=bpath,
        logger=logger,
    )
    if not retention_result.get("invariant_satisfied", True):
        if logger:
            logger.warning(
                "backup_retention_debt warnings=%s",
                ";".join(retention_result.get("warnings", [])) or "unspecified",
            )
    return None
