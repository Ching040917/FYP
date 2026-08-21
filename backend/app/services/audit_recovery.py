"""Stale Audit recovery — startup reconciliation (Build 1).

Supported runtime: local, single-process FastAPI. On Backend startup, rows
left `processing` by an earlier process are transitioned to the terminal
status `interrupted`. No periodic reconciler, no multi-worker or
shared-database safety claim, no heartbeat or persisted worker ownership.

Startup orphan definition (exact):
  - status == "processing";
  - created_at strictly BEFORE the current `process_started_at`;
  - supported single-process mode.

Because startup runs before any request is served, every matching row
belongs to an earlier process and cannot complete.

Time semantics: all values are naive UTC (`datetime.utcnow()`). Never mix
aware and naive. Future timestamps are NOT interrupted; malformed or
unprovable timestamps remain unchanged.

Database truth comes first: the status transition + preview metadata
convergence happen in ONE transaction guarded by `status == "processing"`.
After commit, the derived Preview PDF is removed best-effort; failure never
rolls back the DB transition nor restores Preview availability.

Never deletes DOCX files, document content, Audit rows, findings, Profile
snapshots, or unrelated Preview files.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.audit import AuditRecord
from app.services import preview_storage

logger = logging.getLogger(__name__)

# Allowed Build 1 interruption reasons.
REASON_APPLICATION_RESTART = "application_restart"

_STATUS_PROCESSING = "processing"
_STATUS_INTERRUPTED = "interrupted"


def reconcile_stale_audits(
    db: Session,
    process_started_at: datetime,
    *,
    enabled: bool = True,
) -> int:
    """Transition abandoned `processing` rows to `interrupted`.

    Idempotent and transaction-safe. Returns the number of rows transitioned.

    - enabled=False → no-op (returns 0).
    - Rows created at or after `process_started_at` stay `processing`.
    - Rows with a future or unprovable `created_at` stay unchanged.
    - Rows already `completed`/`failed`/`interrupted` are never touched
      (the conditional UPDATE guards on `status == 'processing'`).
    """
    if not enabled:
        return 0

    claimed: list[AuditRecord] = []
    rows = db.query(AuditRecord).filter(AuditRecord.status == _STATUS_PROCESSING).all()
    now = datetime.utcnow()
    for row in rows:
        if not _created_before(row.created_at, process_started_at):
            continue
        # Conditional, status-guarded claim.
        result = db.query(AuditRecord).filter(
            AuditRecord.id == row.id,
            AuditRecord.status == _STATUS_PROCESSING,
        ).update({
            "status": _STATUS_INTERRUPTED,
            "interrupted_at": now,
            "interruption_reason": REASON_APPLICATION_RESTART,
            # Preview metadata converges in the SAME transaction: mark
            # unavailable and clear derived-artifact fields. Nothing on the
            # filesystem is touched here.
            "rendered_preview_status": preview_storage.PREVIEW_STATUS_UNAVAILABLE,
            "rendered_preview_sha256": None,
            "rendered_preview_size": None,
            "rendered_preview_pages": None,
            "rendered_preview_converted_at": None,
            "rendered_preview_error": preview_storage.PREVIEW_ERRORS[4],  # file_missing
        })
        if result:
            claimed.append(row)

    db.commit()

    for row in claimed:
        _remove_preview_best_effort(row.id)

    if claimed:
        logger.info("stale audit recovery interrupted=%d", len(claimed))
    return len(claimed)


def _created_before(created_at: Optional[datetime], process_started_at: datetime) -> bool:
    """True when `created_at` is strictly before process start.

    Conservative: None, non-datetime, and future timestamps return False
    (never interrupt an unprovable row).
    """
    if not isinstance(created_at, datetime):
        return False
    # Both naive UTC by contract; if tzinfo leaks in, treat as unprovable.
    if created_at.tzinfo is not None:
        return False
    return created_at < process_started_at


def _remove_preview_best_effort(audit_id: str) -> None:
    """Best-effort removal of the derived Preview PDF after DB commit.

    The path is derived ONLY through `preview_storage.preview_path` from the
    validated Audit UUID — never an arbitrary path. Failure is logged with
    the Audit ID and a safe category; it never rolls back the DB transition
    and never restores Preview availability.
    """
    try:
        if preview_storage.remove_preview(audit_id):
            logger.info("stale audit recovery preview removed audit=%s", audit_id)
        else:
            logger.info("stale audit recovery preview absent audit=%s", audit_id)
    except Exception:
        logger.warning("stale audit recovery preview cleanup failed audit=%s", audit_id)
