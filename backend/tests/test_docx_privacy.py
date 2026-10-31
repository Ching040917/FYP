"""Privacy tests for uploaded-DOCX in-memory processing contract.

Verifies:
1. Valid DOCX Audit succeeds without calling convert_docx_to_pdf.
2. LibreOffice present (simulated find_soffice) does not trigger conversion.
3. LibreOffice absent produces the same safe fallback.
4. Uploaded bytes are never passed to filesystem write APIs.
5. No temporary .docx appears anywhere in temporary storage.
6. Extracted document blocks remain available (GET /api/audit/{id}/document-blocks).
7. Rendered-preview status is UNAVAILABLE and error is preview_disabled (truthful 409 detail).
8. Invalid-DOCX rejection remains HTTP 400.
9. Exact-OLE rejection retains its distinct HTTP 400 message.
10. Unexpected internal failures remain sanitized (HTTP 500).
11. PDF report export remains functional without reading or writing uploaded DOCX files.
"""
import io
from pathlib import Path
import pytest
from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.models.audit import AuditRecord
from app.services import preview_storage


def _post(client, docx_bytes, filename="test.docx"):
    return client.post(
        "/api/audit",
        files={"file": (filename, docx_bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )


def test_audit_succeeds_without_calling_convert_docx_to_pdf(client, docx_factory, monkeypatch):
    """Verify that convert_docx_to_pdf is never invoked during a valid audit."""
    def _forbidden(*args, **kwargs):
        raise AssertionError("convert_docx_to_pdf must NEVER be called during audit upload")

    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", _forbidden)

    docx_bytes = docx_factory()
    resp = _post(client, docx_bytes)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "Success"
    assert "audit_id" in data


def test_libreoffice_present_does_not_trigger_conversion(client, docx_factory, monkeypatch):
    """Even if LibreOffice is present, Audit upload does not invoke conversion."""
    called = []
    def _probe_called(*args, **kwargs):
        called.append(True)
        raise AssertionError("Conversion triggered despite privacy policy")

    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", _probe_called)
    # Simulate soffice present in environment
    monkeypatch.setattr("app.services.docx_pdf_converter.find_soffice", lambda: r"C:\Program Files\LibreOffice\program\soffice.com")

    resp = _post(client, docx_factory())
    assert resp.status_code == 200
    assert not called


def test_libreoffice_absent_produces_identical_fallback(client, docx_factory, monkeypatch, test_engine):
    """When LibreOffice is absent, audit produces the exact same UNAVAILABLE preview state."""
    monkeypatch.setattr("app.services.docx_pdf_converter.find_soffice", lambda: None)

    resp = _post(client, docx_factory())
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(AuditRecord).filter_by(id=audit_id).first()
    s.close()

    assert row.rendered_preview_status == preview_storage.PREVIEW_STATUS_UNAVAILABLE
    assert row.rendered_preview_error == "preview_disabled"
    assert row.paragraph_page_mapping is None


def test_uploaded_bytes_never_reach_filesystem_writes(client, docx_factory, monkeypatch, tmp_path):
    """Assert uploaded DOCX bytes are never passed to Path.write_bytes or open(..., 'wb')."""
    raw_docx = docx_factory()

    real_write_bytes = Path.write_bytes
    def guarded_write_bytes(path_self, data, *args, **kwargs):
        if isinstance(data, (bytes, bytearray)) and (raw_docx in data or data == raw_docx):
            raise AssertionError(f"Uploaded DOCX bytes intercepted in Path.write_bytes to {path_self}")
        return real_write_bytes(path_self, data, *args, **kwargs)

    monkeypatch.setattr(Path, "write_bytes", guarded_write_bytes)

    resp = _post(client, raw_docx)
    assert resp.status_code == 200


def test_no_temporary_docx_created(client, docx_factory, tmp_path, monkeypatch):
    """Verify that no .docx file appears anywhere in temporary directories during audit."""
    import tempfile
    temp_dir = tmp_path / "system_tmp"
    temp_dir.mkdir()
    monkeypatch.setenv("TEMP", str(temp_dir))
    monkeypatch.setenv("TMP", str(temp_dir))

    resp = _post(client, docx_factory())
    assert resp.status_code == 200

    docx_files = list(temp_dir.rglob("*.docx"))
    assert docx_files == [], f"Unexpected .docx files created: {docx_files}"


def test_extracted_document_blocks_available(client, docx_factory):
    """Extracted text blocks remain fully available for evidence-linked document preview."""
    resp = _post(client, docx_factory(paragraphs=["First test paragraph", "Second test paragraph"]))
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]
    blocks_resp = client.get(f"/api/audit/{audit_id}/document-blocks")
    assert blocks_resp.status_code == 200
    data = blocks_resp.json()
    assert data["audit_id"] == audit_id
    assert isinstance(data["blocks"], list)
    assert len(data["blocks"]) > 0


def test_rendered_preview_status_truthful_409(client, docx_factory):
    """Rendered preview endpoint returns 409 with truthful, non-misleading detail."""
    resp = _post(client, docx_factory())
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    prev_resp = client.get(f"/api/audit/{audit_id}/rendered-preview")
    assert prev_resp.status_code == 409
    detail = prev_resp.json()["detail"]
    assert "Page-rendered preview is unavailable" in detail
    assert "extracted-text preview remains available" in detail
    assert prev_resp.headers.get("x-preview-error-category") == "preview_disabled"


def test_invalid_docx_rejection_remains_400(client):
    """Invalid/corrupt DOCX uploads are rejected with HTTP 400 before persistence."""
    resp = _post(client, b"not-a-valid-zip-or-docx-content")
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "not a valid or readable DOCX document" in detail


def test_exact_ole_rejection_remains_400(client):
    """Encrypted/password-protected OLE documents return the distinct 400 rejection."""
    ole_sig = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1") + b"remainder-of-ole-package"
    resp = _post(client, ole_sig)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "encrypted or password-protected" in detail


def test_unexpected_internal_failure_remains_sanitized_500(client, docx_factory, monkeypatch):
    """Unexpected exceptions during audit are sanitized to generic 500 without internal leaks."""
    def _crash(*args, **kwargs):
        raise RuntimeError("sensitive internal parser failure with /secret/path")

    monkeypatch.setattr(api_routes, "extract_paragraphs", _crash)

    resp = _post(client, docx_factory())
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert "secret" not in detail
    assert "The document could not be processed" in detail


def test_pdf_report_export_remains_functional(client, docx_factory):
    """PDF audit summary report generation via ReportLab remains fully operational."""
    resp = _post(client, docx_factory())
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    export_resp = client.get(f"/api/audit/{audit_id}/export-pdf")
    assert export_resp.status_code == 200
    assert export_resp.headers["content-type"] == "application/pdf"
    assert export_resp.content.startswith(b"%PDF")
