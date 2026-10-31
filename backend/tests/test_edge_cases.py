"""Edge cases: empty files, hostile inputs, AI task failure paths."""
import copy
import hashlib
import io
import tempfile
import uuid
import zipfile
from unittest.mock import Mock
from xml.etree import ElementTree

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


def test_malformed_docx_bytes_returns_400(client):
    resp = client.post(
        "/api/audit",
        files={"file": ("bad.docx", b"not a real docx", "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert resp.json() == {"detail": INVALID_DOCX_DETAIL}


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
INVALID_DOCX_DETAIL = (
    "This file is not a valid or readable DOCX document. Open it in Word, "
    "save it again as a .docx file, and try again."
)
PROCESSING_DETAIL = (
    "The document could not be processed. Please try again. "
    "If the problem continues, use a different DOCX file."
)
PRIVATE_MARKER = "PRIVATE-INVALID-DOCX-7e49a1"
INVALID_DOCX_CASES = [
    "random-bytes", "empty-bytes", "truncated-zip", "non-ooxml-zip",
    "missing-content-types", "missing-main-document", "missing-root-relationships",
    "malformed-main-xml", "malformed-styles-xml",
    "wrong-main-root", "wrong-styles-root", "wrong-content-types-root",
    "wrong-relationships-root", "missing-body",
    "missing-relationship-target", "missing-relationship-part",
]


def _invalid_docx_bytes(docx_factory, case):
    """Mutate real synthetic packages, not copies of validator implementation."""
    if case == "random-bytes":
        return b"not a ZIP: " + PRIVATE_MARKER.encode()
    if case == "empty-bytes":
        return b""
    source = docx_factory(paragraphs=[PRIVATE_MARKER])
    if case == "truncated-zip":
        return source[:-22]
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    members["custom/private.txt"] = PRIVATE_MARKER.encode()
    removed = {
        "missing-content-types": "[Content_Types].xml",
        "missing-main-document": "word/document.xml",
        "missing-root-relationships": "_rels/.rels",
    }
    replacements = {
        "malformed-main-xml": ("word/document.xml", b"<unclosed"),
        "malformed-styles-xml": ("word/styles.xml", b"<unclosed"),
        "wrong-main-root": (
            "word/document.xml",
            b'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        ),
        "wrong-styles-root": (
            "word/styles.xml",
            b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        ),
        "wrong-content-types-root": (
            "[Content_Types].xml",
            b'<Wrong xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        ),
        "wrong-relationships-root": (
            "_rels/.rels",
            b'<Wrong xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        ),
        "missing-body": (
            "word/document.xml",
            b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
        ),
    }
    if case == "non-ooxml-zip":
        members = {"private.txt": PRIVATE_MARKER.encode()}
    elif case in removed:
        del members[removed[case]]
    elif case in replacements:
        name, content = replacements[case]
        members[name] = content
    elif case in {"missing-relationship-target", "missing-relationship-part"}:
        root = ElementTree.fromstring(members["_rels/.rels"])
        relationship = next(
            child for child in root
            if child.get("Type", "").endswith("/officeDocument")
        )
        if case == "missing-relationship-target":
            del relationship.attrib["Target"]
        else:
            relationship.set("Target", "word/missing-private-document.xml")
        members["_rels/.rels"] = ElementTree.tostring(root)
    else:
        raise AssertionError(f"Unknown malformed DOCX case: {case}")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return output.getvalue()


@pytest.fixture
def invalid_upload_storage(monkeypatch, tmp_path):
    from app.config import settings

    root = tmp_path / "configured-storage"
    for name in ("preview", "output", "temp"):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "retained.bin").write_bytes(b"existing storage must survive")
    monkeypatch.setattr(settings, "PREVIEW_STORAGE_DIR", str(root / "preview"))
    monkeypatch.setattr(settings, "GUIDED_FIX_STORAGE_DIR", str(root / "output"))
    monkeypatch.setattr(tempfile, "tempdir", str(root / "temp"))
    for name in ("TEMP", "TMP", "TMPDIR"):
        monkeypatch.setenv(name, str(root / "temp"))
    return root


def _storage_state(root):
    return {
        str(path.relative_to(root)): (
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        )
        for path in root.rglob("*")
    }


def _database_state(test_engine):
    from sqlalchemy import func, select
    from app.database import Base

    with test_engine.connect() as connection:
        return {
            table.name: {
                "count": connection.execute(select(func.count()).select_from(table)).scalar_one(),
                "rows": copy.deepcopy([
                    dict(row) for row in connection.execute(
                        select(table).order_by(*table.primary_key.columns)
                    ).mappings()
                ]),
            }
            for table in Base.metadata.sorted_tables
        }


@pytest.mark.parametrize("case", INVALID_DOCX_CASES)
def test_invalid_docx_real_validator_and_upload_reject_without_side_effects(
    client, test_engine, docx_factory, monkeypatch, caplog, invalid_upload_storage, case,
):
    from sqlalchemy.orm import Session
    from app.api import routes
    from app.services import ai_citation, document_parser, guided_fix_storage, profile_registry

    payload = _invalid_docx_bytes(docx_factory, case)
    upload = io.BytesIO(payload)
    original_hash = hashlib.sha256(upload.getvalue()).hexdigest()
    with pytest.raises(document_parser.InvalidDocxError):
        document_parser.validate_docx_upload(payload)

    # A retained real snapshot makes mutation/loss checks meaningful, not only empty-table checks.
    retained_id = str(uuid.uuid4())
    snapshot = routes.resolve_request_profile(profile_id=None, custom_profile=None).to_dict()
    with Session(test_engine) as session:
        session.add(routes.AuditRecord(
            id=retained_id, filename="retained.docx", file_size=1,
            document_sha256="a" * 64, weighted_score=100, status="completed",
            profile_snapshot=snapshot,
        ))
        session.commit()
    before = _database_state(test_engine)
    history = client.get("/api/audits").json()
    retained = client.get(f"/api/audit/{retained_id}").json()
    profiles = copy.deepcopy({
        key: value.to_dict() for key, value in profile_registry.BUILTIN_PROFILES.items()
    })
    reviews = copy.deepcopy(routes._reviews)
    outputs = copy.deepcopy(guided_fix_storage._outputs)
    storage = _storage_state(invalid_upload_storage)
    forbidden = []
    for owner, name in (
        (routes, "convert_docx_to_pdf"),
        (routes, "async_ai_citation_task"),
        (ai_citation, "call_ollama_local"),
        (routes, "run_static_rules_engine"),
    ):
        spy = Mock(side_effect=AssertionError(f"{name} must not run for rejected DOCX"))
        monkeypatch.setattr(owner, name, spy)
        forbidden.append(spy)
    import subprocess
    for name in ("Popen", "run"):
        spy = Mock(side_effect=AssertionError("subprocess must not run for rejected DOCX"))
        monkeypatch.setattr(subprocess, name, spy)
        forbidden.append(spy)

    caplog.clear()
    filename = f"{PRIVATE_MARKER}.docx"
    response = client.post(
        "/api/audit", files={"file": (filename, upload, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": INVALID_DOCX_DETAIL}
    assert _database_state(test_engine) == before
    assert client.get("/api/audits").json() == history
    assert client.get(f"/api/audit/{retained_id}").json() == retained
    assert retained["profile_snapshot"] == snapshot
    assert {key: value.to_dict() for key, value in profile_registry.BUILTIN_PROFILES.items()} == profiles
    assert routes._reviews == reviews
    assert guided_fix_storage._outputs == outputs
    assert _storage_state(invalid_upload_storage) == storage
    assert hashlib.sha256(upload.getvalue()).hexdigest() == original_hash
    assert hashlib.sha256(payload).hexdigest() == original_hash
    for spy in forbidden:
        spy.assert_not_called()
    for private in (
        PRIVATE_MARKER, filename, str(invalid_upload_storage), repr(payload),
        "Traceback", "BadZipFile", "XMLSyntaxError", "KeyError",
        "word/document.xml", "word/styles.xml", "[Content_Types].xml", "_rels/.rels",
    ):
        assert private not in response.text
        assert private not in caplog.text


def test_one_valid_docx_after_rejection_creates_exactly_one_audit(
    client, test_engine, docx_factory, monkeypatch, invalid_upload_storage,
):
    from app.api import routes
    from app.services import document_parser

    converter = Mock(side_effect=routes.DocxConversionError("libreoffice_missing"))
    monkeypatch.setattr(routes, "convert_docx_to_pdf", converter)
    rejected = client.post(
        "/api/audit",
        files={"file": ("invalid.docx", b"invalid", "application/octet-stream")},
    )
    assert rejected.status_code == 400
    assert rejected.json() == {"detail": INVALID_DOCX_DETAIL}
    assert all(table["count"] == 0 for table in _database_state(test_engine).values())
    converter.assert_not_called()
    valid = docx_factory(paragraphs=["One accepted synthetic document."])
    assert document_parser.validate_docx_upload(valid) is None
    accepted = client.post(
        "/api/audit", files={"file": ("valid.docx", valid, "application/octet-stream")},
    )
    assert accepted.status_code == 200
    history = client.get("/api/audits").json()
    assert len(history) == 1
    assert history[0]["id"] == accepted.json()["audit_id"]
    state = _database_state(test_engine)
    assert state["audit_records"]["count"] == 1
    record = state["audit_records"]["rows"][0]
    assert record["document_sha256"] == hashlib.sha256(valid).hexdigest()
    assert record["profile_snapshot"] == accepted.json()["profile_snapshot"]
    converter.assert_not_called()
    assert record["rendered_preview_status"] == "UNAVAILABLE"
    assert record["rendered_preview_error"] == "preview_disabled"
    assert record["paragraph_page_mapping"] is None


@pytest.mark.parametrize("error_type", [AttributeError, TypeError])
def test_unexpected_parser_error_on_valid_docx_remains_safe_500(
    client, docx_factory, monkeypatch, invalid_upload_storage, error_type,
):
    from app.api import routes
    from app.services import document_parser

    payload = docx_factory(paragraphs=["Normal valid synthetic document."])
    assert document_parser.validate_docx_upload(payload) is None
    parser = Mock(side_effect=error_type(f"{PRIVATE_MARKER} C:/private/document.xml"))
    converter = Mock(side_effect=AssertionError("converter must follow parse/extraction"))
    monkeypatch.setattr(routes, "parse_document", parser)
    monkeypatch.setattr(routes, "convert_docx_to_pdf", converter)
    response = client.post(
        "/api/audit", files={"file": ("valid.docx", payload, "application/octet-stream")},
    )
    assert response.status_code == 500
    assert response.json() == {"detail": PROCESSING_DETAIL}
    parser.assert_called_once_with(payload)
    converter.assert_not_called()
    assert PRIVATE_MARKER not in response.text
    assert error_type.__name__ not in response.text


@pytest.mark.parametrize("error_type", [AttributeError, TypeError, KeyError, ValueError])
def test_unexpected_validator_xml_reader_error_is_not_wrapped_and_returns_safe_500(
    client, docx_factory, monkeypatch, invalid_upload_storage, error_type,
):
    from app.api import routes
    from app.services import document_parser

    # Construct and validate before replacing the shared lxml entry point.
    payload = docx_factory(paragraphs=["Normal valid synthetic document."])
    assert document_parser.validate_docx_upload(payload) is None
    unexpected = error_type(f"{PRIVATE_MARKER} C:/private/document.xml")
    reader = Mock(side_effect=unexpected)
    parser = Mock(side_effect=AssertionError("parse must follow validator"))
    converter = Mock(side_effect=AssertionError("converter must follow validator"))
    monkeypatch.setattr(document_parser.etree, "fromstring", reader)
    monkeypatch.setattr(routes, "parse_document", parser)
    monkeypatch.setattr(routes, "convert_docx_to_pdf", converter)
    with pytest.raises(error_type) as caught:
        document_parser.validate_docx_upload(payload)
    assert caught.value is unexpected
    response = client.post(
        "/api/audit", files={"file": ("valid.docx", payload, "application/octet-stream")},
    )
    assert response.status_code == 500
    assert response.json() == {"detail": PROCESSING_DETAIL}
    assert reader.call_count == 2
    parser.assert_not_called()
    converter.assert_not_called()
    assert PRIVATE_MARKER not in response.text
    assert error_type.__name__ not in response.text


@pytest.mark.parametrize("filename", ["bad.DOCX", "bad.docx ", "bad.doc", "bad.docm"])
def test_invalid_docx_preserves_extension_before_size_and_validation(
    client_with_small_cap, monkeypatch, filename,
):
    from app.api import routes

    validator = Mock(side_effect=AssertionError("extension must precede validation"))
    resolver = Mock(side_effect=AssertionError("extension must precede profile resolution"))
    monkeypatch.setattr(routes, "validate_docx_upload", validator)
    monkeypatch.setattr(routes, "resolve_request_profile", resolver)
    response = client_with_small_cap.post(
        "/api/audit?profile_id=unknown-profile",
        files={"file": (filename, b"invalid" * 1024, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported file format. Only .docx files are accepted."}
    validator.assert_not_called()
    resolver.assert_not_called()


def test_invalid_docx_preserves_size_before_profile_and_validation(client_with_small_cap, monkeypatch):
    from app.api import routes

    validator = Mock(side_effect=AssertionError("size must precede validation"))
    resolver = Mock(side_effect=AssertionError("size must precede profile resolution"))
    monkeypatch.setattr(routes, "validate_docx_upload", validator)
    monkeypatch.setattr(routes, "resolve_request_profile", resolver)
    response = client_with_small_cap.post(
        "/api/audit?profile_id=unknown-profile",
        files={"file": ("bad.docx", b"invalid" * 1024, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "File size exceeds the 10MB security boundary."}
    validator.assert_not_called()
    resolver.assert_not_called()


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
def test_non_ole_upload_returns_invalid_docx_400(client, payload):
    response = client.post("/api/audit", files={"file": ("test.docx", payload, "application/octet-stream")})
    assert response.status_code == 400
    assert response.json() == {"detail": INVALID_DOCX_DETAIL}


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
