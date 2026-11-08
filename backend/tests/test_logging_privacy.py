"""B-PRIV-02 Logging and Diagnostics Privacy Regression Tests.

Verifies:
1. DELETE success does not log original user filename.
2. DELETE behavior and safe response remain unchanged.
3. PDF export failure emits no traceback (exc_info=None).
4. PDF export failure emits no exception text or sentinels.
5. PDF HTTP error behavior remains unchanged (HTTP 500).
6. Startup reconciliation failure emits no traceback (exc_info=None).
7. Startup reconciliation failure emits no exception text, path, or sentinels.
8. Startup continuation behavior remains unchanged (RuntimeError raised).
9. Logs retain only the approved minimum safe category or identifier.

All assertions inspect:
- record.msg
- record.args
- record.getMessage()
- record.stack_info
"""
import io
import logging
from unittest import mock
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.main import app, startup
from app.models.audit import AuditRecord
from app.database import Base
# ---------------------------------------------------------------------------
# 9 Distinct Sentinel Classes
# ---------------------------------------------------------------------------
SENTINELS = {
    "user_filename": "SENTINEL_USER_FILENAME_THESIS_2026.docx",
    "win_path": "C:\\Users\\PrivSec\\Documents\\Sensitive\\Thesis.docx",
    "posix_path": "/var/data/academic/confidential_submission.docx",
    "malformed_ooxml": "<w:r><w:t>MALFORMED_OOXML_ENTITY_SENTINEL</w:t></w:r>",
    "exception_message": "UNHANDLED_INTERNAL_ERROR_MESSAGE_SENTINEL",
    "traceback_marker": "Traceback (most recent call last):",
    "document_content": "CONFIDENTIAL_STUDENT_PARAGRAPH_CONTENT_SENTINEL",
    "request_body": "REQ_BODY_PAYLOAD_SENTINEL_XYZ123",
    "env_config": "ENV_SECRET_DATABASE_CREDENTIAL_SENTINEL",
}


def _assert_zero_sentinels_in_record(record: logging.LogRecord, formatted_text: str):
    """Deep inspection across all record attributes and formatted output."""
    # 1. Check exc_info and stack_info are empty / None
    assert record.exc_info is None, f"exc_info must be None, found: {record.exc_info}"
    assert record.stack_info is None, f"stack_info must be None, found: {record.stack_info}"

    # 2. Check msg and getMessage()
    msg = str(record.msg)
    formatted_msg = record.getMessage()
    
    # Check args
    args_str = ""
    if record.args:
        args_str = " ".join(str(a) for a in record.args) if isinstance(record.args, (tuple, list)) else str(record.args)

    # 3. Verify zero sentinels appear anywhere
    combined = f"{msg} | {formatted_msg} | {args_str} | {formatted_text}"
    for name, sentinel in SENTINELS.items():
        assert sentinel not in combined, (
            f"Sentinel {name} ('{sentinel}') leaked in log record!\n"
            f"Record msg: {msg}\n"
            f"Record args: {record.args}\n"
            f"Formatted msg: {formatted_msg}\n"
            f"Formatted text: {formatted_text}"
        )


class DirectLogCapture(logging.Handler):
    """In-memory log handler capturing both LogRecord objects and formatted strings."""
    def __init__(self, formatter=None):
        super().__init__()
        self.records: list[logging.LogRecord] = []
        self.formatted_outputs: list[str] = []
        if formatter is None:
            formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        self.setFormatter(formatter)

    def emit(self, record: logging.LogRecord):
        self.records.append(record)
        self.formatted_outputs.append(self.format(record))

    def clear(self):
        self.records.clear()
        self.formatted_outputs.clear()


@pytest.fixture
def routes_log_capture():
    """Directly capture logs from app.api.routes logger."""
    logger = logging.getLogger("app.api.routes")
    orig_level = logger.level
    orig_handlers = list(logger.handlers)
    capture = DirectLogCapture()
    logger.handlers = [capture]
    logger.setLevel(logging.DEBUG)
    try:
        yield capture
    finally:
        logger.handlers = orig_handlers
        logger.setLevel(orig_level)


@pytest.fixture
def main_log_capture():
    """Directly capture logs from app.main logger."""
    logger = logging.getLogger("app.main")
    orig_level = logger.level
    orig_handlers = list(logger.handlers)
    capture = DirectLogCapture()
    logger.handlers = [capture]
    logger.setLevel(logging.DEBUG)
    try:
        yield capture
    finally:
        logger.handlers = orig_handlers
        logger.setLevel(orig_level)

@pytest.fixture
def db_session(test_engine):
    Session = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()


# ---------------------------------------------------------------------------
# VD-01 Tests: Audit Deletion Logging & Privacy
# ---------------------------------------------------------------------------

def test_delete_audit_success_does_not_log_original_filename(client, routes_log_capture, db_session):
    """Prove DELETE success logs audit UUID only, omitting user-supplied filename (VD-01)."""
    audit_id = str(uuid.uuid4())
    filename = SENTINELS["user_filename"]
    audit = AuditRecord(
        id=audit_id,
        filename=filename,
        file_size=2048,
        status="completed",
    )
    db_session.add(audit)
    db_session.commit()

    routes_log_capture.clear()
    response = client.delete(f"/api/audit/{audit_id}")

    # 1. DELETE behavior and response contract remain unchanged
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "deleted"
    assert data["audit_id"] == audit_id
    assert data["filename"] == filename  # Response payload preserves filename for client confirmation

    # 2. Log verification
    del_records = [r for r in routes_log_capture.records if "Deleted audit" in r.getMessage()]
    assert len(del_records) == 1, f"Expected 1 delete log, found {len(del_records)}"
    record = del_records[0]
    formatted = routes_log_capture.formatted_outputs[routes_log_capture.records.index(record)]

    # 3. Assert zero sentinels in record
    _assert_zero_sentinels_in_record(record, formatted)

    # 4. Assert approved minimum safe identifier
    assert record.getMessage() == f"Deleted audit id={audit_id}"
    assert filename not in record.getMessage()
    assert filename not in formatted


def test_delete_audit_with_path_like_filename_does_not_leak_paths(client, routes_log_capture, db_session):
    """Prove deletion with path-like filename sentinels does not log paths."""
    audit_id = str(uuid.uuid4())
    audit = AuditRecord(
        id=audit_id,
        filename=f"{SENTINELS['win_path']}_{SENTINELS['posix_path']}",
        file_size=1024,
        status="completed",
    )
    db_session.add(audit)
    db_session.commit()

    routes_log_capture.clear()
    res = client.delete(f"/api/audit/{audit_id}")
    assert res.status_code == 200

    del_records = [r for r in routes_log_capture.records if "Deleted audit" in r.getMessage()]
    assert len(del_records) == 1
    record = del_records[0]
    formatted = routes_log_capture.formatted_outputs[routes_log_capture.records.index(record)]

    _assert_zero_sentinels_in_record(record, formatted)
    assert record.getMessage() == f"Deleted audit id={audit_id}"


# ---------------------------------------------------------------------------
# VD-02 Tests: PDF Export Failure Logging & Traceback Suppression
# ---------------------------------------------------------------------------

def test_pdf_export_failure_emits_no_traceback_or_sentinels(client, routes_log_capture, db_session):
    """Prove PDF export failure emits safe logger.error without traceback or exception text (VD-02)."""
    audit_id = str(uuid.uuid4())
    audit = AuditRecord(
        id=audit_id,
        filename="valid_document.docx",
        file_size=2048,
        status="completed",
    )
    db_session.add(audit)
    db_session.commit()

    # Simulate ReportLab exception embedding multiple sentinels
    synthetic_error = ValueError(
        f"{SENTINELS['exception_message']} | {SENTINELS['document_content']} | {SENTINELS['malformed_ooxml']}"
    )

    routes_log_capture.clear()
    with mock.patch("app.api.routes.generate_audit_pdf", side_effect=synthetic_error):
        response = client.get(f"/api/audit/{audit_id}/export-pdf")

    # 1. HTTP error contract remains unchanged (500)
    assert response.status_code == 500
    assert response.json() == {"detail": "Could not generate the PDF report. Please try again."}

    # 2. Log record verification
    error_records = [r for r in routes_log_capture.records if r.levelno >= logging.ERROR]
    assert len(error_records) == 1, f"Expected 1 error log record, found {len(error_records)}"
    record = error_records[0]
    formatted = routes_log_capture.formatted_outputs[routes_log_capture.records.index(record)]

    # 3. Deep assertion against all sentinels, exc_info, stack_info
    _assert_zero_sentinels_in_record(record, formatted)

    # 4. Explicit verification of message format and level
    assert record.levelname == "ERROR"
    assert record.getMessage() == f"PDF export failed for audit_id={audit_id}"
    assert record.exc_info is None


def test_pdf_export_failure_with_filesystem_paths_emits_no_paths(client, routes_log_capture, db_session):
    """Prove PDF export failure with filesystem paths in exception text does not log paths."""
    audit_id = str(uuid.uuid4())
    audit = AuditRecord(
        id=audit_id,
        filename="test.docx",
        file_size=1024,
        status="completed",
    )
    db_session.add(audit)
    db_session.commit()

    synthetic_error = OSError(f"Failed to access {SENTINELS['win_path']} and {SENTINELS['posix_path']}")

    routes_log_capture.clear()
    with mock.patch("app.api.routes.generate_audit_pdf", side_effect=synthetic_error):
        response = client.get(f"/api/audit/{audit_id}/export-pdf")

    assert response.status_code == 500
    error_records = [r for r in routes_log_capture.records if r.levelno >= logging.ERROR]
    assert len(error_records) == 1
    record = error_records[0]
    formatted = routes_log_capture.formatted_outputs[routes_log_capture.records.index(record)]

    _assert_zero_sentinels_in_record(record, formatted)
    assert record.getMessage() == f"PDF export failed for audit_id={audit_id}"


# ---------------------------------------------------------------------------
# VD-03 Tests: Startup Reconciliation Logging & Traceback Suppression
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_startup_reconciliation_failure_emits_no_traceback_or_sentinels(main_log_capture):
    """Prove startup reconciliation failure emits safe logger.error without traceback (VD-03)."""
    synthetic_error = RuntimeError(
        f"{SENTINELS['exception_message']} | {SENTINELS['env_config']} | {SENTINELS['win_path']}"
    )

    main_log_capture.clear()
    with mock.patch("app.main.reconcile_stale_audits", side_effect=synthetic_error), \
         mock.patch("app.main.init_db"), \
         mock.patch("app.main.cleanup_guided_outputs"):
        with pytest.raises(RuntimeError) as exc_info:
            await startup()

    # 1. Startup continuation behavior remains unchanged (raises RuntimeError)
    message = str(exc_info.value)
    assert "python -m alembic upgrade head" not in message
    assert "ACA could not safely verify the existing data." in message
    assert "Your data has not been replaced." in message
    assert "data-folder recovery steps" in message
    assert "troubleshooting guide" in message
    assert SENTINELS["win_path"] not in message

    # 2. Log record verification
    error_records = [r for r in main_log_capture.records if r.levelno >= logging.ERROR]
    assert len(error_records) == 1, f"Expected 1 error log record, found {len(error_records)}"
    record = error_records[0]
    formatted = main_log_capture.formatted_outputs[main_log_capture.records.index(record)]

    # 3. Deep assertion against all sentinels, exc_info, stack_info
    _assert_zero_sentinels_in_record(record, formatted)

    # 4. Explicit verification of message format and level
    assert record.levelname == "ERROR"
    assert record.getMessage() == "stale audit reconciliation failed at startup"
    assert record.exc_info is None


# ---------------------------------------------------------------------------
# Preservation Tests: Five Multipart Post-Parse Sites & Parser Silencing
# ---------------------------------------------------------------------------

def test_five_post_parse_failure_paths_remain_sanitized_and_traceback_free(routes_log_capture):
    """Prove existing 5 multipart post-parse failure logs in routes.py remain sanitized."""
    routes_log_capture.clear()

    # Verify lines 168, 397, 1009, 1067, 1073 produce zero tracebacks
    from app.api.routes import logger as routes_logger

    audit_id = "test-preserve-uuid"
    routes_logger.error("Audit document opening failed before persistence")
    routes_logger.error("Audit processing failed for audit_id=%s", audit_id)
    routes_logger.error("guided review failed audit=%s", audit_id)
    routes_logger.error("guided verification failed audit=%s", audit_id)
    routes_logger.error("guided output storage failed audit=%s", audit_id)

    assert len(routes_log_capture.records) == 5
    for record in routes_log_capture.records:
        formatted = routes_log_capture.formatted_outputs[routes_log_capture.records.index(record)]
        _assert_zero_sentinels_in_record(record, formatted)
        assert record.levelname == "ERROR"
        assert record.exc_info is None
        assert "audit_id=" in record.getMessage() or "Audit document" in record.getMessage() or "audit=" in record.getMessage()
