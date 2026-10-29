"""Edge cases: empty files, hostile inputs, AI task failure paths."""
import io
import uuid

import pytest


def test_empty_docx_upload_returns_200(client, docx_factory):
    """An empty Document() (no paragraphs) should still be accepted."""
    file_bytes = docx_factory(paragraphs=None, references=None)
    resp = client.post(
        "/api/audit",
        files={"file": ("empty.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200


def test_single_paragraph_docx_returns_200(client, docx_factory):
    # Build docx conforming to SUC preset so no MAJOR margin violations
    file_bytes = docx_factory(
        paragraphs=["Just one paragraph."],
        references=[],
        margins={"left": 1.5, "right": 1.0, "top": 1.0, "bottom": 1.0},
    )
    resp = client.post(
        "/api/audit",
        files={"file": ("single.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200
    data = resp.json()
    majors = [v for v in data["physical_layout_errors"] if v["severity"] == "MAJOR"]
    assert majors == []


def test_references_only_docx_returns_200(client, docx_factory):
    file_bytes = docx_factory(paragraphs=None, references=["Smith, J. (2020). Title. Press."])
    resp = client.post(
        "/api/audit",
        files={"file": ("refs.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200


def test_malformed_docx_bytes_returns_500(client):
    resp = client.post(
        "/api/audit",
        files={"file": ("bad.docx", b"not a real docx", "application/octet-stream")},
    )
    # python-docx raises on invalid bytes; route catches and returns 500
    assert resp.status_code == 500
    assert "failed" in resp.json()["detail"].lower() or "process" in resp.json()["detail"].lower()


def test_oversize_returns_400_not_500(client_with_small_cap):
    big = b"y" * 2048  # > 1KB cap
    resp = client_with_small_cap.post(
        "/api/audit",
        files={"file": ("big.docx", big, "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_get_audit_with_zero_violations_returns_empty_list(client, docx_factory):
    # Clean docx with conforming margins + present references
    file_bytes = docx_factory(
        paragraphs=["Body paragraph."],
        references=["Smith, J. (2020). Title. Press."],
        margins={"left": 1.5, "right": 1.0, "top": 1.0, "bottom": 1.0},
    )
    post = client.post(
        "/api/audit",
        files={"file": ("clean.docx", file_bytes, "application/octet-stream")},
    )
    audit_id = post.json()["audit_id"]
    get = client.get(f"/api/audit/{audit_id}")
    assert get.json()["violations"] == []


def test_ai_task_timeout_does_not_block_response(client, docx_factory, monkeypatch):
    """Simulate a local AI timeout (the Ollama call raises). The AI task
    wraps the provider call in try/except, so the request must
    succeed and the audit record must still be persisted."""
    from app.services import ai_citation

    async def _timeout(*args, **kwargs):
        raise RuntimeError("simulated LLM timeout")

    monkeypatch.setattr(ai_citation, "call_ollama_local", _timeout)

    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    resp = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]
    # GET should return the record; status remains 'processing' (no issues
    # written) but the record itself is not lost.
    get = client.get(f"/api/audit/{audit_id}")
    assert get.status_code == 200
    assert get.json()["id"] == audit_id


OLE_SIGNATURE = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1")
ENCRYPTED_DETAIL = (
    "This document is encrypted or password-protected. ACA cannot audit encrypted files. "
    "Remove password protection in Word and try again."
)


@pytest.mark.parametrize("payload", [OLE_SIGNATURE, OLE_SIGNATURE + b"inert", OLE_SIGNATURE * 2])
def test_ole_upload_rejected_before_side_effects(client, test_engine, monkeypatch, tmp_path, caplog, payload):
    from sqlalchemy import func, select
    from app.database import Base
    from app.api import routes
    from sqlalchemy.orm import Session
    from app.config import settings

    monkeypatch.setattr(settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "preview"))
    monkeypatch.setattr(settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path / "output"))

    def unreachable(*args, **kwargs):
        pytest.fail("processing must not be reached")

    monkeypatch.setattr(routes, "resolve_request_profile", unreachable)
    monkeypatch.setattr(routes, "parse_document", unreachable)
    monkeypatch.setattr(routes, "convert_docx_to_pdf", unreachable)
    monkeypatch.setattr(Session, "commit", unreachable)
    with test_engine.connect() as conn:
        before = {t.name: conn.execute(select(func.count()).select_from(t)).scalar_one()
                  for t in Base.metadata.sorted_tables}
    history = client.get("/api/audits").json()
    reviews = dict(routes._reviews)
    response = client.post("/api/audit", files={"file": ("test.docx", payload, "image/png")})
    with test_engine.connect() as conn:
        after = {t.name: conn.execute(select(func.count()).select_from(t)).scalar_one()
                 for t in Base.metadata.sorted_tables}

    assert response.status_code == 400
    assert response.json() == {"detail": ENCRYPTED_DETAIL}
    assert before == after
    assert client.get("/api/audits").json() == history
    assert routes._reviews == reviews
    assert not list(tmp_path.rglob("*"))
    assert repr(payload) not in caplog.text


@pytest.mark.parametrize("payload", [
    b"", OLE_SIGNATURE[:7], OLE_SIGNATURE[:7] + b"X",
    b"X" + OLE_SIGNATURE, b"prefix" + OLE_SIGNATURE, b"random invalid",
])
def test_non_ole_upload_retains_invalid_response(client, payload):
    response = client.post("/api/audit", files={"file": ("test.docx", payload, "application/octet-stream")})
    assert response.status_code == 500
    assert response.json() == {"detail": (
        "The document could not be processed. Please try again. "
        "If the problem continues, use a different DOCX file."
    )}


@pytest.mark.parametrize("filename", ["test.DOCX", "test.Docx", "test.docx ", "test.doc", "test.docm"])
def test_ole_upload_preserves_extension_precedence(client, filename):
    response = client.post("/api/audit", files={"file": (filename, OLE_SIGNATURE, "application/octet-stream")})
    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported file format. Only .docx files are accepted."}


def test_oversize_ole_upload_preserves_size_precedence(client_with_small_cap):
    response = client_with_small_cap.post(
        "/api/audit", files={"file": ("test.docx", OLE_SIGNATURE + b"x" * 1024, "application/octet-stream")}
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "File size exceeds the 10MB security boundary."}


def test_ole_signature_inside_docx_is_not_rejected(client, docx_factory):
    import zipfile

    source = io.BytesIO(docx_factory(paragraphs=["Synthetic document."]))
    with zipfile.ZipFile(source, "a") as archive:
        archive.writestr("custom/inert.bin", OLE_SIGNATURE)
    response = client.post("/api/audit", files={"file": ("test.docx", source.getvalue(), "image/png")})
    assert response.status_code == 200
    assert response.json()["status"] == "Success"


def test_large_ole_upload_is_rejected(client):
    payload = OLE_SIGNATURE + b"x" * (1024 * 1024)
    response = client.post("/api/audit", files={"file": ("test.docx", payload, "application/octet-stream")})
    assert response.status_code == 400
    assert response.json() == {"detail": ENCRYPTED_DETAIL}


def test_concurrent_ole_uploads_leave_no_history(client_file_db):
    from concurrent.futures import ThreadPoolExecutor

    def submit(_):
        return client_file_db.post(
            "/api/audit", files={"file": ("test.docx", OLE_SIGNATURE, "application/octet-stream")}
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(submit, range(8)))
    assert all(r.status_code == 400 and r.json() == {"detail": ENCRYPTED_DETAIL} for r in responses)
    assert client_file_db.get("/api/audits").json() == []
