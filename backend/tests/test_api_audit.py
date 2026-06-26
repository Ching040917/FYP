"""HTTP lifecycle tests for /api/audit and /api/audits."""
import io
import uuid


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


def test_post_audit_initial_status_is_processing(client, docx_factory):
    file_bytes = docx_factory(paragraphs=["Body."], references=[])
    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
    )
    audit_id = post.json()["audit_id"]
    get = client.get(f"/api/audit/{audit_id}")
    assert get.json()["status"] == "processing"


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
    # 1 MAJOR margin (page_margins: 8pt) + 1 MAJOR citation (citation_apa: 5pt)
    # -> 100 - 8 - 5 = 87
    body = ["Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(
        paragraphs=body, references=None,
        margins={"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0},
    )
    post = client.post(
        "/api/audit",
        files={"file": ("test.docx", file_bytes, "application/octet-stream")},
    )
    score = post.json()["weighted_compliance_score"]
    # 1 MARGIN_LEFT (MAJOR, page_margins weight=8) + 1 CITATION_MISMATCH (MAJOR, citation_apa weight=5)
    assert score == 87


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
