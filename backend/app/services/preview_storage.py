"""Rendered PDF preview storage (Build 1).

Storage foundation for locally rendered PDF previews. This module only
persists bytes atomically and reports metadata — it never renders PDFs,
never touches the audit pipeline, and exposes no HTTP endpoints.

Design:
- Root: `%LOCALAPPDATA%\\AcademicComplianceAuditor\\rendered-previews`,
  overridable via `PREVIEW_STORAGE_DIR` (tests/dev).
- Filenames derive ONLY from validated audit UUIDs: `<audit-id>.pdf`.
  User filenames and absolute paths are never used or exposed.
- Writes go to a unique temp file under `.tmp`, then `os.replace` for an
  atomic move. No partial final files, ever.
- The final path is derivable — no path column is stored.

Logging policy: never log PDF content, user filenames, absolute paths, or
bytes. Only the audit ID and outcome are logged.
"""
import hashlib
import io
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Non-sensitive error categories persisted in rendered_preview_error.
PREVIEW_ERRORS = (
    "libreoffice_missing",
    "timeout",
    "conversion_failed",
    "persistence_failed",
    "file_missing",
)

PREVIEW_STATUS_AVAILABLE = "AVAILABLE"
PREVIEW_STATUS_UNAVAILABLE = "UNAVAILABLE"

_SUBDIR = "rendered-previews"
_TMP_SUBDIR = ".tmp"


@dataclass(frozen=True)
class PreviewMetadata:
    """Metadata for one successfully stored rendered PDF."""
    status: str
    sha256: str
    size: int
    pages: int
    converted_at: datetime


def default_storage_dir() -> Path:
    """Platform default root: %LOCALAPPDATA%\\AcademicComplianceAuditor\\rendered-previews.

    Falls back to the user home directory when LOCALAPPDATA is unset
    (non-Windows hosts).
    """
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "AcademicComplianceAuditor" / _SUBDIR
    return Path.home() / ".academic-compliance-auditor" / _SUBDIR


def storage_root() -> Path:
    """Configured root, or the platform default when PREVIEW_STORAGE_DIR is empty."""
    configured = (settings.PREVIEW_STORAGE_DIR or "").strip()
    if configured:
        return Path(configured)
    return default_storage_dir()


def _resolve_under_root(root: Path, name: str) -> Path:
    """Resolve `root/name` and guarantee the result stays under the real root.

    Guards against symlink escape and any path tricks: the resolved final
    path must be inside the resolved root.
    """
    root_real = root.resolve()
    final = (root_real / name).resolve()
    try:
        final.relative_to(root_real)
    except ValueError:
        raise ValueError("resolved path escapes the configured storage root")
    return final


def validate_audit_id(audit_id: str) -> str:
    """Return the canonical string form of a valid UUID, or raise ValueError.

    Only canonical UUIDs may become filenames — this blocks traversal
    (`../`, absolute paths) and arbitrary strings by construction.
    """
    if not isinstance(audit_id, str) or not audit_id.strip():
        raise ValueError("audit id must be a UUID string")
    try:
        return str(uuid.UUID(audit_id.strip()))
    except (ValueError, AttributeError, TypeError):
        raise ValueError(f"invalid audit id: {audit_id[:32]!r}") from None


def preview_path(audit_id: str) -> Path:
    """Absolute final path for an audit's rendered PDF (derived, never stored).

    Raises ValueError for invalid UUIDs or paths escaping the root.
    """
    canonical = validate_audit_id(audit_id)
    return _resolve_under_root(storage_root(), f"{canonical}.pdf")


def _validate_pdf_bytes(pdf_bytes: bytes) -> int:
    """Validate PDF bytes; return page count. Raises ValueError on rejection.

    Checks: non-empty, `%PDF` magic header, and a parseable page count.
    """
    if not isinstance(pdf_bytes, bytes) or not pdf_bytes:
        raise ValueError("empty or missing PDF bytes")
    if not pdf_bytes.startswith(b"%PDF"):
        raise ValueError("invalid PDF: missing %PDF header")
    try:
        from pypdf import PdfReader
        return len(PdfReader(io.BytesIO(pdf_bytes)).pages)
    except Exception as e:
        raise ValueError(f"invalid PDF: cannot read page count ({type(e).__name__})") from None


def store_pdf(audit_id: str, pdf_bytes: bytes) -> PreviewMetadata:
    """Atomically persist validated PDF bytes for an audit.

    Returns PreviewMetadata for the caller to persist on the audit row.
    Raises:
        ValueError — invalid audit id or invalid/empty PDF bytes.
        FileExistsError — a final file already exists (never silently
            overwritten).
        OSError — filesystem failure (temp file is cleaned up).
    """
    canonical = validate_audit_id(audit_id)
    pages = _validate_pdf_bytes(pdf_bytes)

    root = storage_root()
    root.mkdir(parents=True, exist_ok=True)
    final = _resolve_under_root(root, f"{canonical}.pdf")

    # Never silently overwrite an existing rendered preview.
    if final.exists():
        raise FileExistsError(f"rendered preview already exists for audit {canonical}")

    tmp_dir = root / _TMP_SUBDIR
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{canonical}-{uuid.uuid4().hex}.tmp"

    try:
        with open(tmp_path, "wb") as fh:
            fh.write(pdf_bytes)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, final)
    except Exception:
        # Cleanup guarantee: never leave temp files behind on failure.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass

    digest = hashlib.sha256(pdf_bytes).hexdigest()
    logger.info("rendered preview stored audit=%s pages=%d size=%d", canonical, pages, len(pdf_bytes))
    return PreviewMetadata(
        status=PREVIEW_STATUS_AVAILABLE,
        sha256=digest,
        size=len(pdf_bytes),
        pages=pages,
        converted_at=datetime.utcnow(),
    )


def remove_preview(audit_id: str) -> bool:
    """Safely remove a stored preview file. Returns True when it existed.

    Also the cleanup path for "final file written but DB update failed":
    the caller calls this and then marks the row UNAVAILABLE.
    """
    try:
        final = preview_path(audit_id)
    except ValueError:
        return False
    try:
        if final.exists():
            final.unlink()
            return True
    except OSError:
        logger.warning("could not remove preview audit=%s", audit_id)
    return False


def read_validated_pdf(
    audit_id: str,
    expected_sha256: Optional[str],
    expected_size: Optional[int],
    expected_pages: Optional[int],
) -> bytes:
    """Read a stored preview and revalidate it against persisted metadata.

    Raises:
        FileNotFoundError — no file at the derived path (caller → 410).
        ValueError — invalid UUID, symlink, path escape, or any hash /
            size / magic / page-count mismatch (caller → 409).
    """
    canonical = validate_audit_id(audit_id)
    final = _resolve_under_root(storage_root(), f"{canonical}.pdf")
    if final.is_symlink():
        raise ValueError("preview path is a symlink")
    if not final.is_file():
        raise FileNotFoundError(canonical)

    data = final.read_bytes()
    if not data.startswith(b"%PDF"):
        raise ValueError("invalid PDF magic")
    if expected_size is not None and len(data) != expected_size:
        raise ValueError("size mismatch")
    if expected_sha256 and hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("hash mismatch")
    if expected_pages is not None:
        try:
            from pypdf import PdfReader
            pages = len(PdfReader(io.BytesIO(data)).pages)
        except Exception as e:
            raise ValueError(f"page count unreadable ({type(e).__name__})") from None
        if pages != expected_pages:
            raise ValueError("page count mismatch")
    return data


def preview_file_exists(audit_id: str) -> bool:
    """True when a rendered preview file exists (and the id is valid)."""
    try:
        return preview_path(audit_id).exists()
    except ValueError:
        return False
