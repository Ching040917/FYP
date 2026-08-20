"""HTTP lifecycle tests for /api/audit and /api/audits."""
import io
import uuid

import pytest

from app.api import routes as api_routes


@pytest.fixture
def preview_root(tmp_path, monkeypatch):
    """Isolated preview storage (Build 9A failure-path tests)."""
    root = tmp_path / "previews"
    monkeypatch.setattr(api_routes.settings, "PREVIEW_STORAGE_DIR", str(root))
    return root


def test_post_audit_happy_path_returns_200_and_audit_id(client, docx_factory):
    body = ["Body paragraph."]
    refs = []
    file_bytes = docx_factory(paragraphs=body, references=refs)

    resp = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "Success"
    assert "audit_id" in data
    uuid.UUID(data["audit_id"])  # parseable UUID
    assert isinstance(data["weighted_compliance_score"], int)
    assert isinstance(data["physical_layout_errors"], list)
    assert isinstance(data["ai_citation_tooltips"], list)


def test_post_audit_persists_record_fetchable_by_get(client, docx_factory):
    body = ["Body paragraph."]
    refs = []
    file_bytes = docx_factory(paragraphs=body, references=refs)

    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
    )
    audit_id = post.json()["audit_id"]

    get = client.get(f"/api/audit/{audit_id}")
    assert get.status_code == 200
    data = get.json()
    assert data["id"] == audit_id
    assert data["filename"] == "test.docx"


def test_get_audit_unknown_id_returns_404(client):
    fake = str(uuid.uuid4())
    resp = client.get(f"/api/audit/{fake}")
    assert resp.status_code == 404


def test_list_audits_returns_all_records(client, docx_factory):
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    for i in range(2):
        client.post(
            "/api/audit",
            files={"file": (f"f{i}.docx", file_bytes, "application/octet-stream")},
        )
    resp = client.get("/api/audits")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2


def test_list_audits_respects_limit_and_offset(client, docx_factory):
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    for i in range(3):
        client.post(
            "/api/audit",
            files={"file": (f"f{i}.docx", file_bytes, "application/octet-stream")},
        )
    resp = client.get("/api/audits?limit=1&offset=1")
    items = resp.json()
    assert len(items) == 1


def test_post_audit_rejects_non_docx_extension(client):
    resp = client.post(
        "/api/audit",
        files={"file": ("test.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert resp.status_code == 400
    assert "docx" in resp.json()["detail"].lower() or "format" in resp.json()["detail"].lower()


def test_post_audit_rejects_oversize_file(client_with_small_cap):
    # small_file_cap sets MAX_FILE_SIZE=1024
    big = b"x" * 2048
    resp = client_with_small_cap.post(
        "/api/audit",
        files={"file": ("big.docx", big, "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert "10MB" in resp.json()["detail"] or "size" in resp.json()["detail"].lower()


def test_post_audit_rejects_missing_file_field(client):
    resp = client.post("/api/audit")
    assert resp.status_code == 422


def test_post_audit_final_status_is_completed(client, docx_factory):
    # The AI citation pass runs synchronously inside POST /api/audit, so the
    # record is already completed by the time GET can observe it (the
    # "processing" state is transient inside the request, not retrievable).
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
    )
    audit_id = post.json()["audit_id"]
    get = client.get(f"/api/audit/{audit_id}")
    assert get.json()["status"] == "completed"


def test_post_audit_persists_citation_mismatch_as_violation_row(client, docx_factory):
    body = ["Body intro.", "Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(paragraphs=body, references=None)
    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
    )
    audit_id = post.json()["audit_id"]
    get = client.get(f"/api/audit/{audit_id}")
    viols = get.json()["violations"]
    codes = [v["rule_code"] for v in viols]
    assert "CITATION_MISMATCH" in codes
    cm = next(v for v in viols if v["rule_code"] == "CITATION_MISMATCH")
    assert cm["severity"] == "MAJOR"


def test_post_audit_score_decrements_per_violation(client, docx_factory, monkeypatch):
    # The new scoring engine uses per-category weights + caps (CATEGORY_META).
    # APA profile on a doc with 1.5 in margins, 1.5 spacing, justified text:
    #   - 4 margin majors (page_margins: 8pt each, cap 32)  → 32
    #   - LINE_SPACING + ALIGNMENT minors (paragraph_typography) → 2
    #   - 1 citation MAJOR (citation_apa: 5pt)               → 5
    # -> 100 - 32 - 2 - 5 = 61
    body = ["Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(
        paragraphs=body, references=None,
        margins={"left": 1.5, "right": 1.5, "top": 1.5, "bottom": 1.5},
    )
    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
        params={"profile_id": "apa7-student-paper"},
    )
    score = post.json()["weighted_compliance_score"]
    assert score == 61


def test_post_audit_persists_document_stats_via_get(client, docx_factory):
    """Stats computed at audit time must be retrievable via GET — not zeros."""
    file_bytes = docx_factory(
        paragraphs=["Body paragraph one.", ("Heading 1", "Heading 1")],
        tables=[[["a", "b"], ["c", "d"]]],
    )
    post = client.post(
        "/api/audit",
        files={"file": ("stats.docx", file_bytes, "application/octet-stream")},
    )
    assert post.status_code == 200
    post_stats = post.json()["document_stats"]

    audit_id = post.json()["audit_id"]
    get = client.get(f"/api/audit/{audit_id}")
    assert get.status_code == 200
    get_stats = get.json()["document_stats"]

    # Same stats on both surfaces; real values, not zeros.
    assert get_stats == post_stats
    assert get_stats["paragraphs"] >= 2
    assert get_stats["headings"] == 1
    assert get_stats["tables"] == 1
    assert get_stats["images"] == 0
    assert get_stats["sections"] == 1
    assert get_stats["words"] > 0


def test_get_audit_stats_null_for_record_without_stats(client, test_engine, docx_factory):
    """Pre-persistence records have NULL stats — must not fabricate zeros."""
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord

    Session = sessionmaker(bind=test_engine)
    db = Session()
    rec = AuditRecord(
        id=str(uuid.uuid4()),
        filename="legacy.docx",
        file_size=100,
        deploy_mode="LOCAL",
        status="completed",
        weighted_score=80,
    )
    rec_id = rec.id
    db.add(rec)
    db.commit()
    db.close()

    get = client.get(f"/api/audit/{rec_id}")
    assert get.status_code == 200
    stats = get.json()["document_stats"]
    assert all(v is None for v in stats.values())


def test_post_audit_cloud_flag_sets_deploy_mode(client, docx_factory):
    """cloud query param must control the audit's deploy mode."""
    file_bytes = docx_factory(paragraphs=["Body."], references=[])

    local = client.post(
        "/api/audit",
        files={"file": ("local.docx", file_bytes, "application/octet-stream")},
    )
    assert local.status_code == 200
    local_get = client.get(f"/api/audit/{local.json()['audit_id']}")
    assert local_get.json()["deploy_mode"] == "LOCAL"

    cloud = client.post(
        "/api/audit?cloud=1",
        files={"file": ("cloud.docx", file_bytes, "application/octet-stream")},
    )
    assert cloud.status_code == 200
    cloud_get = client.get(f"/api/audit/{cloud.json()['audit_id']}")
    assert cloud_get.json()["deploy_mode"] == "CLOUD"


def test_post_audit_unicode_filename_accepted(client, docx_factory):
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    resp = client.post(
        "/api/audit",
        files={"file": ("测试.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200
    assert resp.json()["audit_id"]


def test_concurrent_uploads_get_unique_ids(client, docx_factory):
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    ids = set()
    for _ in range(3):
        r = client.post(
            "/api/audit",
            files={"file": ("u.docx", file_bytes, "application/octet-stream")},
        )
        ids.add(r.json()["audit_id"])
    assert len(ids) == 3


# ---------------------------------------------------------------------------
# POST internal-exception containment (Build 9A, Blocker 4)
# ---------------------------------------------------------------------------

SAFE_500_DETAIL = (
    "The document could not be processed. Please try again. "
    "If the problem continues, use a different DOCX file."
)


def test_internal_exception_returns_safe_message_not_internals(client, docx_factory, monkeypatch):
    """A processing crash returns the stable message — never str(e)."""
    def _boom(*args, **kwargs):
        raise RuntimeError("simulated-internal-secret: C:\\Users\\secret\\tmp\\x.docx")
    monkeypatch.setattr(api_routes, "calculate_weighted_score_detailed", _boom)

    resp = client.post(
        "/api/audit",
        files={"file": ("test.docx", docx_factory(paragraphs=["Body."]), "application/octet-stream")},
    )
    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert detail == SAFE_500_DETAIL
    assert "simulated-internal-secret" not in detail
    assert "secret" not in detail
    assert "\\Users\\" not in detail


def test_internal_exception_details_not_in_logs(client, docx_factory, monkeypatch, caplog):
    """Logs contain no document text or absolute temp paths."""
    import logging

    def _boom(*args, **kwargs):
        raise RuntimeError("leaky C:\\Users\\x\\AppData\\Local\\Temp\\docx2pdf_abc\\in.docx")
    monkeypatch.setattr(api_routes, "calculate_weighted_score_detailed", _boom)

    with caplog.at_level(logging.ERROR, logger="app.api.routes"):
        resp = client.post(
            "/api/audit",
            files={"file": ("test.docx", docx_factory(paragraphs=["Body text."]), "application/octet-stream")},
        )
    assert resp.status_code == 500
    joined = "\n".join(rec.getMessage() for rec in caplog.records)
    # The audit id IS expected; absolute temp paths are not.
    assert "C:\\Users\\" not in joined
    assert "AppData" not in joined
    assert "Body text" not in joined


def test_internal_exception_rolls_back_and_cleans_preview(
    client, docx_factory, preview_root, monkeypatch, test_engine,
):
    """A processing failure marks the audit failed, and removes any persisted PDF."""
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord

    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda _bytes: _make_pdf_for_test())
    monkeypatch.setattr(api_routes, "calculate_weighted_score_detailed", _boom_scoring)

    resp = client.post(
        "/api/audit",
        files={"file": ("test.docx", docx_factory(paragraphs=["Body."]), "application/octet-stream")},
    )
    assert resp.status_code == 500
    assert resp.json()["detail"] == SAFE_500_DETAIL

    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(AuditRecord).order_by(AuditRecord.created_at.desc()).first()
    assert row is not None
    assert row.status == "failed"
    aid = row.id
    s.close()
    # The persisted rendered PDF was removed with the failed transaction.
    assert not (preview_root / f"{aid}.pdf").exists()
    assert list((preview_root / ".tmp").iterdir()) == []


def test_validation_errors_keep_specific_messages(client, docx_factory):
    """Known validation errors must NOT become generic 500s."""
    bad = client.post(
        "/api/audit",
        files={"file": ("test.pdf", b"%PDF fake", "application/pdf")},
    )
    assert bad.status_code == 400
    assert bad.json()["detail"] != SAFE_500_DETAIL

    big = client.post(
        "/api/audit",
        files={"file": ("big.docx", b"x" * 2048, "application/octet-stream")},
    )
    # MAX_FILE_SIZE is 10MB in this client — this is NOT oversize, so it
    # will attempt processing; use client_with_small_cap for the real check.
    assert big.status_code in (200, 400, 500)


def test_validation_errors_small_cap_keep_specific_messages(client_with_small_cap, docx_factory):
    big = client_with_small_cap.post(
        "/api/audit",
        files={"file": ("big.docx", b"x" * 2048, "application/octet-stream")},
    )
    assert big.status_code == 400
    assert big.json()["detail"] != SAFE_500_DETAIL


# ---------------------------------------------------------------------------
# helpers for the failure-path tests
# ---------------------------------------------------------------------------

def _make_pdf_for_test(page_count: int = 2) -> bytes:
    import io as _io
    from reportlab.pdfgen import canvas as pdfcanvas
    buf = _io.BytesIO()
    c = pdfcanvas.Canvas(buf)
    for i in range(page_count):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


def _boom_scoring(*args, **kwargs):
    raise RuntimeError("simulated scoring failure")
