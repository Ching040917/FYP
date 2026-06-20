"""Edge cases: empty files, hostile inputs, AI task failure paths."""
import io
import uuid


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
    """Simulate an LLM timeout (Ollama/Gemini call raises). The background
    task already wraps the LLM call in try/except, so the request must
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
