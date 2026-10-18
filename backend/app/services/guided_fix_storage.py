"""Single-process, one-use storage for verified guided-fix DOCX outputs.

No source document is written. Tokens live only in memory and survive neither
process restart nor expiry; orphaned output files are removed by cleanup.
"""

import hashlib
import os
import secrets
import stat
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import settings

_TTL_SECONDS = 15 * 60
_SUBDIR = "guided-fix-outputs"
_LOCK = threading.RLock()


@dataclass(frozen=True)
class _Output:
    audit_id: str
    sha256: str
    filename: str
    expiry: datetime
    root: Path


_outputs: dict[str, _Output] = {}


class DownloadGoneError(KeyError):
    """Unknown, expired, or already downloaded output (HTTP 410)."""


class DownloadWrongAuditError(PermissionError):
    """Valid output belongs to another audit (HTTP 404)."""


def storage_root() -> Path:
    configured = (settings.GUIDED_FIX_STORAGE_DIR or "").strip()
    if configured:
        return Path(configured)
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "AcademicComplianceAuditor" / _SUBDIR
    return Path.home() / ".academic-compliance-auditor" / _SUBDIR


def _root() -> Path:
    root = storage_root()
    if root.is_symlink():
        raise OSError("guided fix output directory cannot be a symlink")
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise OSError("invalid guided fix output directory")
    return root.resolve()


def _owned_file(root: Path, token: str) -> Path:
    # The token is random URL-safe base64, never a user-supplied filename.
    if not token or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for char in token):
        raise DownloadGoneError("invalid download token")
    return root / f"{token}.docx"


def _remove(root: Path, token: str) -> None:
    path = _owned_file(root, token)
    try:
        # unlink removes the link itself, never its target.
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _cleanup_locked(now: datetime) -> None:
    for token, record in list(_outputs.items()):
        if record.expiry <= now:
            _outputs.pop(token, None)
            _remove(record.root, token)
    root = storage_root()
    if not root.exists():
        return
    root = _root()
    cutoff = now.timestamp() - _TTL_SECONDS
    for path in root.iterdir():
        # Only files with the exact owned token naming scheme may be removed.
        if path.suffix != ".docx" or len(path.stem) != 43:
            continue
        try:
            _owned_file(root, path.stem)
            if path.is_symlink():
                path.unlink()
            elif path.stat().st_mtime < cutoff and path.stem not in _outputs:
                path.unlink()
        except (OSError, DownloadGoneError):
            continue


def cleanup() -> None:
    """Remove expired tokens and stale crash leftovers; safe to call at startup."""
    with _LOCK:
        _cleanup_locked(datetime.now(timezone.utc))


def store(audit_id: str, data: bytes, filename: str) -> tuple[str, str]:
    """Exclusively write a verified output, returning (token, ISO expiry).

    The caller must complete all preservation/re-audit gates before storing.
    Raises OSError on persistence or post-write hash verification failures.
    """
    if not isinstance(audit_id, str) or not audit_id or not isinstance(data, bytes) or not data:
        raise ValueError("invalid guided fix output")
    if (not isinstance(filename, str) or filename in ("", ".", "..") or
            "/" in filename or "\\" in filename or "\x00" in filename or
            not filename.lower().endswith(".docx")):
        raise ValueError("invalid output filename")
    with _LOCK:
        now = datetime.now(timezone.utc)
        _cleanup_locked(now)
        root = _root()
        token = secrets.token_urlsafe(32)
        while token in _outputs or (root / f"{token}.docx").exists():
            token = secrets.token_urlsafe(32)
        path = _owned_file(root, token)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            with os.fdopen(os.open(path, flags, 0o600), "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            # Verify bytes actually on disk, not merely a successful write().
            with _open_owned(path) as handle:
                stored = handle.read()
            digest = hashlib.sha256(data).hexdigest()
            if hashlib.sha256(stored).hexdigest() != digest:
                raise OSError("guided fix output hash mismatch")
            expiry = now + timedelta(seconds=_TTL_SECONDS)
            _outputs[token] = _Output(audit_id, digest, filename, expiry, root)
            return token, expiry.isoformat()
        except Exception:
            _remove(root, token)
            raise


def _open_owned(path: Path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    if not stat.S_ISREG(os.fstat(fd).st_mode) or path.is_symlink():
        os.close(fd)
        raise OSError("guided fix output is not a regular file")
    return os.fdopen(fd, "rb")


def retrieve(audit_id: str, token: str) -> tuple[bytes, str]:
    """Read and consume output. Wrong audit → DownloadWrongAuditError (404);
    unknown/expired/used → DownloadGoneError (410). Corruption raises OSError.
    """
    with _LOCK:
        cleanup()
        record = _outputs.get(token)
        if record is None:
            raise DownloadGoneError("download unavailable")
        if record.audit_id != audit_id:
            raise DownloadWrongAuditError("download not found for audit")
        _outputs.pop(token)
        path = _owned_file(record.root, token)
        try:
            with _open_owned(path) as handle:
                data = handle.read()
            if hashlib.sha256(data).hexdigest() != record.sha256:
                raise OSError("guided fix output hash mismatch")
            return data, record.filename
        except FileNotFoundError as exc:
            raise DownloadGoneError("download unavailable") from exc
        finally:
            _remove(record.root, token)


def revoke(audit_id: str, token: str) -> None:
    """Idempotently revoke an owned token and delete its output."""
    with _LOCK:
        record = _outputs.get(token)
        if record is not None and record.audit_id == audit_id:
            _outputs.pop(token)
            _remove(record.root, token)

def revoke_audit(audit_id: str) -> None:
    """Erase every unconsumed corrected output when its source audit is deleted."""
    with _LOCK:
        for token, record in list(_outputs.items()):
            if record.audit_id == audit_id:
                _outputs.pop(token)
                _remove(record.root, token)
