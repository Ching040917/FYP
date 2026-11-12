"""Uploaded DOCX is temporary only for private local rendering, never retained."""
import io
import os
import tempfile
import subprocess
from urllib.parse import urlsplit
from urllib.request import url2pathname
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.models.audit import AuditRecord
from app.services import docx_pdf_converter as converter, preview_storage


def _post(client, docx_bytes, filename="test.docx"):
    return client.post(
        "/api/audit",
        files={"file": (filename, docx_bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )


@pytest.fixture
def private_renderer(monkeypatch, tmp_path):
    """Exercise real private-directory/write/cleanup code, fake only LibreOffice."""
    from reportlab.pdfgen import canvas
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.drawString(72, 720, "Synthetic preview")
    pdf.showPage()
    pdf.save()
    state = SimpleNamespace(calls=[], source_bytes=[], pdf=buffer.getvalue())
    parent = tmp_path / "system_tmp"
    parent.mkdir()
    state.parent = parent
    monkeypatch.setattr(tempfile, "tempdir", str(parent))
    monkeypatch.setattr(converter, "find_soffice", lambda: "fake-soffice")
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", converter.convert_docx_to_pdf)

    class RenderProcess:
        returncode = 0
        pid = 4242

        def __init__(self, args, **kwargs):
            self.args = args
            source = Path(args[-1])
            directory = source.parent.parent
            assert directory.parent == parent
            if os.name == "nt":
                converter._windows_private_directory(directory, create=False)
            else:
                assert directory.stat().st_mode & 0o077 == 0
                assert directory.stat().st_uid == os.geteuid()
            assert source.suffix == ".docx"
            assert source.name != "owner-secret.docx"
            assert kwargs["env"]["TEMP"] == str(directory)
            assert kwargs["env"]["TMP"] == str(directory)
            assert kwargs["env"]["TMPDIR"] == str(directory)
            state.calls.append(args)
            state.source_bytes.append(source.read_bytes())

        def communicate(self, timeout=None):
            output = Path(self.args[self.args.index("--outdir") + 1])
            (output / "document.pdf").write_bytes(state.pdf)
            return None, None

    monkeypatch.setattr(converter.subprocess, "Popen", RenderProcess)
    monkeypatch.setattr(converter, "_start_process",
                        lambda args, env: subprocess.Popen(args, env=env))
    return state


def test_audit_renders_only_after_safe_parsing(client, docx_factory, monkeypatch, private_renderer):
    parsed = []
    original = api_routes.extract_paragraphs

    def extract(doc):
        parsed.append(True)
        return original(doc)

    monkeypatch.setattr(api_routes, "extract_paragraphs", extract)
    actual_convert = api_routes.convert_docx_to_pdf

    def convert(data):
        assert parsed == [True]
        return actual_convert(data)

    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", convert)
    response = _post(client, docx_factory())
    assert response.status_code == 200
    assert response.json()["status"] == "Success"
    assert len(private_renderer.calls) == 1


def test_libreoffice_present_produces_local_preview(client, docx_factory, private_renderer):
    response = _post(client, docx_factory())
    assert response.status_code == 200
    preview = client.get(f"/api/audit/{response.json()['audit_id']}/rendered-preview")
    assert preview.status_code == 200
    assert preview.content == private_renderer.pdf
    assert len(private_renderer.calls) == 1


def test_libreoffice_absent_produces_safe_fallback(client, docx_factory, monkeypatch, test_engine):
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", converter.convert_docx_to_pdf)
    monkeypatch.setattr(converter, "find_soffice", lambda: None)
    response = _post(client, docx_factory())
    assert response.status_code == 200
    with sessionmaker(bind=test_engine)() as session:
        row = session.get(AuditRecord, response.json()["audit_id"])
        assert row.rendered_preview_status == preview_storage.PREVIEW_STATUS_UNAVAILABLE
        assert row.rendered_preview_error == "libreoffice_missing"
        assert row.paragraph_page_mapping is None


def test_uploaded_bytes_written_only_inside_private_conversion_scope(client, docx_factory, private_renderer, tmp_path):
    raw = docx_factory(paragraphs=["PRIVATE_BODY_MARKER"])
    response = _post(client, raw, filename="owner-secret.docx")
    assert response.status_code == 200
    assert private_renderer.source_bytes == [raw]
    assert len(private_renderer.calls) == 1
    assert list(private_renderer.parent.iterdir()) == []
    assert list(tmp_path.rglob("*.docx")) == []
    assert all(path.read_bytes() != raw for path in tmp_path.rglob("*") if path.is_file())


def test_temporary_docx_profile_and_scratch_are_removed(client, docx_factory, private_renderer):
    response = _post(client, docx_factory())
    assert response.status_code == 200
    for args in private_renderer.calls:
        assert not Path(args[-1]).exists()
        assert not Path(args[-1]).parent.exists()
        uri = next(arg.split("=", 1)[1] for arg in args if arg.startswith("-env:UserInstallation="))
        profile = Path(url2pathname(urlsplit(uri).path))
        assert not profile.exists()
        assert profile.parent == Path(args[-1]).parent.parent
    assert len(private_renderer.calls) == 1
    assert list(private_renderer.parent.iterdir()) == []


def test_extracted_document_blocks_available(client, docx_factory):
    response = _post(client, docx_factory(paragraphs=["First test paragraph", "Second test paragraph"]))
    assert response.status_code == 200
    audit_id = response.json()["audit_id"]
    blocks = client.get(f"/api/audit/{audit_id}/document-blocks")
    assert blocks.status_code == 200
    assert blocks.json()["audit_id"] == audit_id
    assert isinstance(blocks.json()["blocks"], list)
    assert len(blocks.json()["blocks"]) > 0


def test_rendered_preview_status_truthful_409(client, docx_factory):
    response = _post(client, docx_factory())
    assert response.status_code == 200
    preview = client.get(f"/api/audit/{response.json()['audit_id']}/rendered-preview")
    assert preview.status_code == 409
    assert "Page-rendered preview is unavailable" in preview.json()["detail"]
    assert "extracted-text preview remains available" in preview.json()["detail"]
    assert preview.headers.get("x-preview-error-category") == "libreoffice_missing"


@pytest.mark.parametrize("payload,detail", [
    (b"not-a-valid-zip-or-docx-content", "not a valid or readable DOCX document"),
    (b"PK\x03\x04invalid-package", "not a valid or readable DOCX document"),
])
def test_invalid_docx_rejection_remains_400(client, payload, detail, private_renderer, test_engine):
    response = _post(client, payload)
    assert response.status_code == 400
    assert detail in response.json()["detail"]
    assert private_renderer.calls == []
    assert list(private_renderer.parent.iterdir()) == []
    with sessionmaker(bind=test_engine)() as session:
        assert session.query(AuditRecord).count() == 0


def test_exact_ole_rejection_remains_400(client, private_renderer, test_engine):
    payload = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1") + b"remainder-of-ole-package"
    response = _post(client, payload)
    assert response.status_code == 400
    assert "encrypted or password-protected" in response.json()["detail"]
    assert private_renderer.calls == []
    assert list(private_renderer.parent.iterdir()) == []
    with sessionmaker(bind=test_engine)() as session:
        assert session.query(AuditRecord).count() == 0


def test_unexpected_internal_failure_remains_sanitized_500(client, docx_factory, monkeypatch, private_renderer):
    def crash(*args, **kwargs):
        raise RuntimeError("sensitive internal parser failure with /secret/path")

    monkeypatch.setattr(api_routes, "extract_paragraphs", crash)
    response = _post(client, docx_factory())
    assert response.status_code == 500
    assert "secret" not in response.json()["detail"]
    assert "The document could not be processed" in response.json()["detail"]
    assert private_renderer.calls == []
    assert list(private_renderer.parent.iterdir()) == []


def test_pdf_report_export_remains_functional(client, docx_factory):
    response = _post(client, docx_factory())
    assert response.status_code == 200
    report = client.get(f"/api/audit/{response.json()['audit_id']}/export-pdf")
    assert report.status_code == 200
    assert report.headers["content-type"] == "application/pdf"
    assert report.content.startswith(b"%PDF")


def test_conversion_logs_do_not_expose_upload(client, docx_factory, private_renderer, caplog):
    with caplog.at_level("INFO"):
        response = _post(client, docx_factory(paragraphs=["PRIVATE_BODY_MARKER"]), "owner-secret.docx")
    assert response.status_code == 200
    assert "PRIVATE_BODY_MARKER" not in caplog.text
    assert "owner-secret.docx" not in caplog.text
    assert str(private_renderer.parent) not in caplog.text


def test_pdf_storage_failure_keeps_audit_and_removes_conversion_source(
    client, docx_factory, private_renderer, monkeypatch, test_engine,
):
    def full(*args, **kwargs):
        # Conversion cleanup is already complete when derived storage starts.
        assert list(private_renderer.parent.iterdir()) == []
        raise OSError("PRIVATE_STORAGE_PATH")

    monkeypatch.setattr(preview_storage, "store_pdf", full)
    response = _post(client, docx_factory())
    assert response.status_code == 200
    assert response.json()["status"] == "Success"
    assert len(private_renderer.calls) == 1
    assert list(private_renderer.parent.iterdir()) == []
    with sessionmaker(bind=test_engine)() as session:
        row = session.get(AuditRecord, response.json()["audit_id"])
        assert row.rendered_preview_status == "UNAVAILABLE"
        assert row.rendered_preview_error == "persistence_failed"
        assert row.rendered_preview_sha256 is None
        assert row.rendered_preview_size is None
        assert row.rendered_preview_pages is None
        assert row.paragraph_page_mapping is None
