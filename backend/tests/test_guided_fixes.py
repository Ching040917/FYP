"""Guided Fixes backend — identity, request security, supported fixes,
structural safety, preservation, output contract, migration.

Backend-only: no frontend, no network, AI mocked by conftest fixtures.
"""
import hashlib
import io
import json
import logging
import sqlite3
import urllib.parse
import uuid
import zipfile

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from sqlalchemy.orm import sessionmaker

from app.models.audit import AuditRecord, Violation
from app.services import guided_fix
from app.services.guided_fix import (
    LEGACY_DETAIL,
    MISMATCH_DETAIL,
    VERIFY_FAIL_DETAIL,
    ZERO_DETAIL,
    apply_guided_fixes,
    build_corrected_filename,
)

# conftest is importable: tests/ is a package.
from tests import conftest as testkit

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
HLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post_audit(client, docx_factory, paragraphs=("Body paragraph.",), **kw):
    return client.post(
        "/api/audit",
        files={"file": ("audit.docx", docx_factory(paragraphs=list(paragraphs), **kw), "application/octet-stream")},
    )


def _post_audit_bytes(client, file_bytes, filename="audit.docx", query=""):
    return client.post(
        "/api/audit" + query,
        files={"file": (filename, file_bytes, "application/octet-stream")},
    )


def _rule_ids(resp, rule_code):
    return [
        v["id"] for v in resp.json()["physical_layout_errors"]
        if v["rule_code"] == rule_code
    ]


def _fix_post(client, audit_id, file_bytes, violation_ids, filename="audit.docx"):
    return client.post(
        f"/api/audit/{audit_id}/guided-fixes",
        data={"selection": json.dumps({"violation_ids": violation_ids})},
        files={"file": (filename, file_bytes, DOCX_MIME)},
    )


def _summary(resp):
    return json.loads(urllib.parse.unquote(resp.headers["X-Repair-Summary"]))


def _make_docx(text="Body paragraph.", size=11.0, family="Calibri"):
    """Minimal single-paragraph docx with explicit font size 11pt."""
    doc = Document()
    p = doc.add_paragraph(text)
    run = p.runs[0]
    run.font.name = family
    run.font.size = Pt(size)
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _rezip(docx_bytes):
    """Re-zip the same members with fresh (current-time) zip metadata.

    Same document content, different bytes — simulates a Word resave for
    identity tests."""
    src = zipfile.ZipFile(io.BytesIO(docx_bytes))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            dst.writestr(item.filename, src.read(item.filename))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 1. Identity (items 1-5)
# ---------------------------------------------------------------------------

class TestIdentity:
    def test_audit_persists_document_sha256(self, client, docx_factory, test_engine):
        file_bytes = docx_factory(paragraphs=["Body paragraph."])
        resp = client.post(
            "/api/audit",
            files={"file": ("audit.docx", file_bytes, "application/octet-stream")},
        )
        assert resp.status_code == 200
        audit_id = resp.json()["audit_id"]
        Session = sessionmaker(bind=test_engine)
        s = Session()
        row = s.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
        assert row.document_sha256 == hashlib.sha256(file_bytes).hexdigest()
        s.close()

    def test_exact_bytes_fix_returns_docx(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit(client, docx_factory, ["Body paragraph."], body_size=11)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith(DOCX_MIME)
        assert _summary(r)["applied"] == 1
        assert "ACA_corrected.docx" in r.headers["content-disposition"]
        d = Document(io.BytesIO(r.content))
        assert d.paragraphs[0].runs[0].font.size.pt == 12.0

    def test_different_docx_same_filename_409(self, client, docx_factory):
        resp = _post_audit(client, docx_factory, ["Original text."])
        audit_id = resp.json()["audit_id"]
        other = docx_factory(paragraphs=["Different text."])
        r = _fix_post(client, audit_id, other, ["nonexistent"])
        assert r.status_code == 409
        assert r.json()["detail"] == MISMATCH_DETAIL

    def test_resave_changes_hash(self, client, docx_factory):
        # python-docx saves deterministically, so a real Word-style resave is
        # simulated by re-zipping the exact members with a different zip
        # layout/timestamps: identical content, different bytes, different
        # hash — Guided Fixes must reject it (hash identity, not content).
        original = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, original)
        assert resp.status_code == 200
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids

        resaved = _rezip(original)
        assert resaved != original
        assert hashlib.sha256(resaved).hexdigest() != hashlib.sha256(original).hexdigest()
        # Content is semantically identical — the endpoint still refuses.
        r = _fix_post(client, audit_id, resaved, [ids[0]])
        assert r.status_code == 409
        assert r.json()["detail"] == MISMATCH_DETAIL

    def test_null_hash_409_legacy(self, client, test_engine, docx_factory):
        audit_id = str(uuid.uuid4())
        Session = sessionmaker(bind=test_engine)
        s = Session()
        s.add(AuditRecord(id=audit_id, filename="old.docx", file_size=100,
                          weighted_score=90, deploy_mode="LOCAL", status="completed"))
        s.add(Violation(id="legacy-v1", audit_id=audit_id, rule_code="FONT_SIZE",
                        severity="MINOR", location={"paragraph_index": 0, "run_index": 0},
                        message="m", expected_value="12pt", actual_value="11pt"))
        s.commit()
        s.close()
        r = _fix_post(client, audit_id, docx_factory(paragraphs=["x"]), ["legacy-v1"])
        assert r.status_code == 409
        assert r.json()["detail"] == LEGACY_DETAIL


# ---------------------------------------------------------------------------
# 2. Request security (items 6-13)
# ---------------------------------------------------------------------------

class TestRequestSecurity:
    def test_extra_field_422(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."])
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        payload = {"violation_ids": [str(uuid.uuid4())], "run_indexes": [0]}
        r = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps(payload)},
            files={"file": ("audit.docx", file_bytes, DOCX_MIME)},
        )
        assert r.status_code == 422
        assert r.json()["detail"] == "Invalid selection payload."

    def test_foreign_violation_id_422(self, client, docx_factory):
        file_bytes_1 = docx_factory(paragraphs=["First audit."])
        # Second audit must carry a real finding so its ids are extractable.
        file_bytes_2 = docx_factory(paragraphs=["Second audit."], body_size=11)
        resp1 = _post_audit_bytes(client, file_bytes_1)
        resp2 = _post_audit_bytes(client, file_bytes_2)
        ids2 = _rule_ids(resp2, "FONT_SIZE")
        assert ids2
        r = _fix_post(client, resp1.json()["audit_id"], file_bytes_1, [ids2[0]])
        assert r.status_code == 422
        assert r.json()["detail"] == "A selected finding does not belong to this audit."

    def test_duplicates_applied_once(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0], ids[0], ids[0]])
        assert r.status_code == 200
        assert _summary(r)["applied"] == 1

    def test_empty_selection_400(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."])
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        r = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps({"violation_ids": []})},
            files={"file": ("audit.docx", file_bytes, DOCX_MIME)},
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "Select at least one supported finding."

    def test_21_ids_422(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."])
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = [str(uuid.uuid4()) for _ in range(21)]
        r = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps({"violation_ids": ids})},
            files={"file": ("audit.docx", file_bytes, DOCX_MIME)},
        )
        assert r.status_code == 422

    def test_garbage_docx_400(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."])
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        r = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps({"violation_ids": ["x"]})},
            files={"file": ("garbage.docx", b"not a zip at all", DOCX_MIME)},
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "The uploaded file is not a valid DOCX."

    def test_oversize_400(self, client_with_small_cap):
        # Validation order: size gate precedes audit lookup — a random UUID
        # still yields the oversize 400 (no audit creation needed under the
        # tiny cap).
        audit_id = str(uuid.uuid4())
        r = client_with_small_cap.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps({"violation_ids": ["x"]})},
            files={"file": ("big.docx", b"x" * 2048, DOCX_MIME)},
        )
        assert r.status_code == 400
        assert "10MB" in r.json()["detail"]

    def test_crlf_dotdot_filename_sanitized(self, client, docx_factory):
        hostile = "..\\report\r\n.docx"
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        r = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            data={"selection": json.dumps({"violation_ids": [ids[0]]})},
            files={"file": (hostile, file_bytes, DOCX_MIME)},
        )
        assert r.status_code == 200, r.text
        cd = r.headers["content-disposition"]
        assert "\r" not in cd and "\n" not in cd
        assert ".." not in cd
        assert "\\" not in cd
        # Sanitizer unit contract: control chars and traversal dots removed.
        name = build_corrected_filename(hostile)
        assert "\r" not in name and "\n" not in name
        assert ".." not in name and "\\" not in name
        assert name.endswith(".docx")


# ---------------------------------------------------------------------------
# 3. Supported fixes (items 14-23)
# ---------------------------------------------------------------------------

class TestSupportedFixes:
    def test_font_size_fix(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d = Document(io.BytesIO(r.content))
        assert abs(d.paragraphs[0].runs[0].font.size.pt - 12.0) < 0.01
        assert _summary(r)["applied"] == 1

    def test_font_consistency_fix(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], font_name="Calibri")
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_CONSISTENCY")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d = Document(io.BytesIO(r.content))
        run = d.paragraphs[0].runs[0]
        assert run.font.name == "Times New Roman"
        rfonts = run._element.rPr.rFonts
        assert rfonts.get(qn("w:ascii")) == "Times New Roman"
        assert rfonts.get(qn("w:eastAsia")) == "Times New Roman"

    def test_alignment_fix(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], alignment=WD_ALIGN_PARAGRAPH.LEFT)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "ALIGNMENT")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d = Document(io.BytesIO(r.content))
        assert d.paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY

    def test_line_spacing_fix(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], line_spacing=1.0)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "LINE_SPACING")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d = Document(io.BytesIO(r.content))
        assert abs(float(d.paragraphs[0].paragraph_format.line_spacing) - 1.5) < 0.01

    def test_space_before_fix(self, client, docx_factory):
        base = docx_factory(paragraphs=["Body paragraph."])
        d = Document(io.BytesIO(base))
        d.paragraphs[0].paragraph_format.space_before = Pt(20)
        buf = io.BytesIO()
        d.save(buf)
        file_bytes = buf.getvalue()
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "SPACE_BEFORE")
        assert ids, resp.json()["physical_layout_errors"]
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d2 = Document(io.BytesIO(r.content))
        assert abs(d2.paragraphs[0].paragraph_format.space_before.pt - 0.0) < 0.01

    def test_space_after_fix(self, client, docx_factory):
        base = docx_factory(paragraphs=["Body paragraph."])
        d = Document(io.BytesIO(base))
        d.paragraphs[0].paragraph_format.space_after = Pt(20)
        buf = io.BytesIO()
        d.save(buf)
        file_bytes = buf.getvalue()
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "SPACE_AFTER")
        assert ids, resp.json()["physical_layout_errors"]
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d2 = Document(io.BytesIO(r.content))
        assert abs(d2.paragraphs[0].paragraph_format.space_after.pt - 6.0) < 0.01

    def test_sibling_untouched(self, client, docx_factory):
        file_bytes = docx_factory(
            paragraphs=["Body paragraph.", "Sibling intact."], body_size=11
        )
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert len(ids) >= 2
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d = Document(io.BytesIO(r.content))
        assert d.paragraphs[0].runs[0].font.size.pt == 12.0
        assert d.paragraphs[1].runs[0].font.size.pt == 11.0
        assert d.paragraphs[1].text == "Sibling intact."

    def test_highlight_survives(self, client, docx_factory):
        doc = Document()
        p = doc.add_paragraph("Body paragraph.")
        run = p.runs[0]
        run.font.name = "Calibri"
        run.font.size = Pt(11)
        hl = OxmlElement("w:highlight")
        hl.set(qn("w:val"), "yellow")
        run._element.rPr.append(hl)
        p.paragraph_format.line_spacing = 1.5
        p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        buf = io.BytesIO()
        doc.save(buf)
        file_bytes = buf.getvalue()

        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_CONSISTENCY")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d2 = Document(io.BytesIO(r.content))
        rpr = d2.paragraphs[0].runs[0]._element.rPr
        hl2 = rpr.find(qn("w:highlight"))
        assert hl2 is not None and hl2.get(qn("w:val")) == "yellow"

    def test_multi_run_grouped_fix(self, client, docx_factory):
        doc = Document()
        p = doc.add_paragraph()
        p.add_run("One ").font.size = Pt(11)
        p.add_run("two").font.size = Pt(11)
        p.paragraph_format.line_spacing = 1.5
        p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        buf = io.BytesIO()
        doc.save(buf)
        file_bytes = buf.getvalue()

        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200, r.text
        d2 = Document(io.BytesIO(r.content))
        assert d2.paragraphs[0].runs[0].font.size.pt == 12.0
        assert d2.paragraphs[0].runs[1].font.size.pt == 12.0

    def test_ambiguous_family_never_guessed(self, client, docx_factory):
        # APA profile: allowed combos span several families → the combo
        # expected value resolves to None → expected_unresolved, never a
        # guessed font, zero applied → 422 ZERO_DETAIL.
        doc = Document()
        p = doc.add_paragraph("Body paragraph.")
        run = p.runs[0]
        run.font.name = "Comic Sans MS"
        run.font.size = Pt(13)
        p.paragraph_format.line_spacing = 2.0
        p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        buf = io.BytesIO()
        doc.save(buf)
        file_bytes = buf.getvalue()

        resp = _post_audit_bytes(client, file_bytes, query="?profile_id=apa7-student-paper")
        assert resp.status_code == 200, resp.text
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_CONSISTENCY")
        assert ids, resp.json()["physical_layout_errors"]
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 422
        assert r.json()["detail"] == ZERO_DETAIL


# ---------------------------------------------------------------------------
# 4. Safety (items 24-32)
# ---------------------------------------------------------------------------

class TestSafety:
    def test_document_changed_skip(self):
        audit = AuditRecord(id="gf-unit", filename="gf.docx", file_size=1, status="completed")
        audit.profile_snapshot = None
        v = Violation(
            id="v1", audit_id="gf-unit", rule_code="FONT_SIZE", severity="MINOR",
            location={"paragraph_index": 0, "run_index": 0}, message="m",
            expected_value="12pt", actual_value="9pt",
        )
        out, applied, skipped = apply_guided_fixes(audit, _make_docx(size=11.0), [v])
        assert applied == []
        assert skipped[0][1] == "document_changed"

    def test_hyperlink_unsafe_structure(self):
        doc = Document()
        p = doc.add_paragraph("text ")
        r_id = doc.part.relate_to("https://example.com", HLINK_REL, is_external=True)
        hl = OxmlElement("w:hyperlink")
        hl.set(qn("r:id"), r_id)
        r = OxmlElement("w:r")
        rpr = OxmlElement("w:rPr")
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), "22")  # 11pt
        rpr.append(sz)
        r.append(rpr)
        t = OxmlElement("w:t")
        t.text = "link"
        r.append(t)
        hl.append(r)
        p._p.append(hl)
        p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        buf = io.BytesIO()
        doc.save(buf)
        data = buf.getvalue()

        audit = AuditRecord(id="gf-unit", filename="gf.docx", file_size=1, status="completed")
        audit.profile_snapshot = None
        v = Violation(
            id="v2", audit_id="gf-unit", rule_code="ALIGNMENT", severity="MINOR",
            location={"paragraph_index": 0}, message="m",
            expected_value="justify", actual_value="left",
        )
        out, applied, skipped = apply_guided_fixes(audit, data, [v])
        assert applied == []
        assert skipped[0][1] == "unsafe_structure"

    def test_unsupported_rule_skip(self):
        audit = AuditRecord(id="gf-unit", filename="gf.docx", file_size=1, status="completed")
        audit.profile_snapshot = None
        v = Violation(
            id="v3", audit_id="gf-unit", rule_code="MARGIN_LEFT", severity="MAJOR",
            location={"paragraph_index": 0}, message="m",
            expected_value="1in", actual_value="0.5in",
        )
        out, applied, skipped = apply_guided_fixes(audit, _make_docx(), [v])
        assert applied == []
        assert skipped[0][1] == "unsupported_rule"

    def test_fixer_failure_422_verify(self, client, docx_factory, monkeypatch):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], alignment=WD_ALIGN_PARAGRAPH.LEFT)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "ALIGNMENT")
        assert ids

        def boom(para, name):
            raise RuntimeError("boom")

        monkeypatch.setattr(guided_fix, "_fix_alignment", boom)
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 422
        assert r.json()["detail"] == VERIFY_FAIL_DETAIL
        assert not r.content.startswith(b"PK")

    def test_nothing_persisted(self, client_file_db, docx_factory, tmp_path):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client_file_db, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        assert ids
        before_files = set(p.name for p in tmp_path.iterdir())
        before_get = client_file_db.get(f"/api/audit/{audit_id}").json()
        r = _fix_post(client_file_db, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200
        after_get = client_file_db.get(f"/api/audit/{audit_id}").json()
        assert after_get["weighted_score"] == before_get["weighted_score"]
        assert after_get["violations"] == before_get["violations"]
        assert after_get["status"] == "completed"
        after_files = set(p.name for p in tmp_path.iterdir())
        assert after_files == before_files, f"new files: {after_files - before_files}"

    def test_logs_do_not_leak_content(self, client, docx_factory, caplog):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        marker = "GFLOGLEAKMARKER12345"
        with caplog.at_level(logging.DEBUG):
            r = _fix_post(client, audit_id, file_bytes, [ids[0]])
            assert r.status_code == 200
        assert marker not in caplog.text
        assert "Body paragraph" not in caplog.text


# ---------------------------------------------------------------------------
# 5. Preservation (items 33-42)
# ---------------------------------------------------------------------------

def _rich_docx_bytes():
    """One fixable body paragraph + hyperlink, bookmark, tracked insert,
    numbered list, SEQ caption, table, image, header, Unicode text."""
    doc = Document()
    body = doc.add_paragraph("Plain body paragraph to fix.")
    for run in body.runs:
        run.font.name = "Calibri"
        run.font.size = Pt(11)
    pf = body.paragraph_format
    pf.line_spacing = 1.0
    pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
    pf.space_before = Pt(2)
    pf.space_after = Pt(2)

    uni = doc.add_paragraph("论文测试 中文 body")
    for run in uni.runs:
        run.font.name = "Calibri"
        run.font.size = Pt(11)

    link_para = doc.add_paragraph()
    link_para.add_run("Visit ")
    r_id = doc.part.relate_to("https://example.com", HLINK_REL, is_external=True)
    hl = OxmlElement("w:hyperlink")
    hl.set(qn("r:id"), r_id)
    new_run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    new_run.append(rpr)
    t = OxmlElement("w:t")
    t.text = "example"
    new_run.append(t)
    hl.append(new_run)
    link_para._p.append(hl)

    bm_para = doc.add_paragraph("Bookmarked text")
    bm = OxmlElement("w:bookmarkStart")
    bm.set(qn("w:id"), "7")
    bm.set(qn("w:name"), "bm1")
    bm_para._p.insert(0, bm)

    ins_para = doc.add_paragraph()
    ins = OxmlElement("w:ins")
    ins.set(qn("w:id"), "1")
    ins.set(qn("w:author"), "ACA")
    r = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "inserted text"
    r.append(t)
    ins.append(r)
    ins_para._p.append(ins)

    list_para = doc.add_paragraph("List item")
    ppr = list_para._p.get_or_add_pPr()
    numpr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    numid = OxmlElement("w:numId")
    numid.set(qn("w:val"), "1")
    numpr.append(ilvl)
    numpr.append(numid)
    ppr.append(numpr)

    testkit._add_word_caption(doc, "Table", ": Test table")

    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "A"
    table.rows[0].cells[1].text = "B"
    table.rows[1].cells[0].text = "C"
    table.rows[1].cells[1].text = "D"

    pic_para = doc.add_paragraph()
    pic_para.add_run().add_picture(io.BytesIO(testkit._PNG_1PX), width=doc.sections[0].page_width * 0.1)

    doc.sections[0].header.paragraphs[0].text = "Header text"

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


class TestPreservation:
    def test_rich_document_preserved(self, client, docx_factory):
        data = _rich_docx_bytes()
        resp = _post_audit_bytes(client, data)
        assert resp.status_code == 200, resp.text
        audit_id = resp.json()["audit_id"]
        ids = [
            v["id"] for v in resp.json()["physical_layout_errors"]
            if v["rule_code"] == "FONT_SIZE" and v["location"].get("paragraph_index") == 0
        ]
        assert ids, resp.json()["physical_layout_errors"]
        r = _fix_post(client, audit_id, data, [ids[0]])
        assert r.status_code == 200, r.text

        src = Document(io.BytesIO(data))
        out = Document(io.BytesIO(r.content))

        # Paragraph + table text identical.
        assert [p.text for p in out.paragraphs] == [p.text for p in src.paragraphs]
        assert [[[c.text for c in row.cells] for row in t.rows] for t in out.tables] == [
            [[c.text for c in row.cells] for row in t.rows] for t in src.tables
        ]
        # Hyperlink rel count.
        def hyperlinks(d):
            return sum(1 for rel in d.part.rels.values() if "hyperlink" in rel.reltype)
        assert hyperlinks(out) == hyperlinks(src)
        # Bookmark start count.
        assert len(out.element.body.findall(".//" + qn("w:bookmarkStart"))) == \
            len(src.element.body.findall(".//" + qn("w:bookmarkStart")))
        # Drawing count.
        assert len(out.element.body.findall(".//" + qn("w:drawing"))) == \
            len(src.element.body.findall(".//" + qn("w:drawing")))
        # Table count.
        assert len(out.tables) == len(src.tables)
        # Numbering XML unchanged.
        assert out.part.numbering_part.blob == src.part.numbering_part.blob
        # SEQ field instrText content unchanged.
        def instr_texts(d):
            return [t.text for t in d.element.body.findall(".//" + qn("w:instrText"))]
        assert instr_texts(out) == instr_texts(src)
        # Tracked insert count unchanged.
        assert len(out.element.body.findall(".//" + qn("w:ins"))) == \
            len(src.element.body.findall(".//" + qn("w:ins")))
        # Header text unchanged.
        assert out.sections[0].header.paragraphs[0].text == \
            src.sections[0].header.paragraphs[0].text
        # Unicode paragraph intact.
        assert any("论文测试 中文" in p.text for p in out.paragraphs)
        # Target paragraph actually fixed (11pt → 12pt).
        assert out.paragraphs[0].runs[0].font.size.pt == 12.0


# ---------------------------------------------------------------------------
# 6. Output contract (items 43-48)
# ---------------------------------------------------------------------------

class TestOutputContract:
    def test_content_type_and_filename(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(DOCX_MIME)
        cd = r.headers["content-disposition"]
        assert "audit_ACA_corrected.docx" in cd
        assert "\r" not in cd and "\n" not in cd

    def test_summary_header_shape(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200
        summary = _summary(r)
        assert set(summary.keys()) == {"applied", "skipped", "failed"}
        assert all(isinstance(v, int) for v in summary.values())

    def test_corrected_bytes_reopenable(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200
        d = Document(io.BytesIO(r.content))
        assert d.paragraphs

    def test_export_pdf_and_history_intact(self, client, docx_factory):
        file_bytes = docx_factory(paragraphs=["Body paragraph."], body_size=11)
        resp = _post_audit_bytes(client, file_bytes)
        audit_id = resp.json()["audit_id"]
        ids = _rule_ids(resp, "FONT_SIZE")
        r = _fix_post(client, audit_id, file_bytes, [ids[0]])
        assert r.status_code == 200
        pdf = client.get(f"/api/audit/{audit_id}/export-pdf")
        assert pdf.status_code == 200
        history = client.get("/api/audits")
        assert history.status_code == 200
        assert any(a["id"] == audit_id for a in history.json())


# ---------------------------------------------------------------------------
# 7. Migration (items 49-52)
# ---------------------------------------------------------------------------

class TestMigration:
    def _run_alembic(self, tmp_path, target):
        from pathlib import Path
        import os as _os
        from alembic import command
        from alembic.config import Config
        from app.config import settings as _settings

        db = tmp_path / "gf-migration.db"
        url = f"sqlite:///{db}"
        backend_dir = Path(__file__).resolve().parents[1]
        cfg = Config(str(backend_dir / "alembic.ini"))
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        orig = _settings.DATABASE_URL
        orig_env = _os.environ.get("DATABASE_URL")
        try:
            _os.environ["DATABASE_URL"] = url
            _settings.DATABASE_URL = url
            cfg.set_main_option("sqlalchemy.url", url)
            command.upgrade(cfg, target)
        finally:
            _settings.DATABASE_URL = orig
            if orig_env is None:
                _os.environ.pop("DATABASE_URL", None)
            else:
                _os.environ["DATABASE_URL"] = orig_env
        return db

    def test_upgrade_90fc_to_head_preserves_rows(self, tmp_path):
        db = self._run_alembic(tmp_path, "90fc17718e11")
        con = sqlite3.connect(str(db))
        con.execute(
            "INSERT INTO audit_records (id, filename, file_size, deploy_mode, status) "
            "VALUES (?,?,?,?,?)",
            ("mig-audit-1", "mig.docx", 100, "LOCAL", "completed"),
        )
        con.commit()
        con.close()
        self._run_alembic(tmp_path, "head")
        con = sqlite3.connect(str(db))
        cols = {r[1] for r in con.execute("PRAGMA table_info(audit_records)")}
        assert "document_sha256" in cols
        row = con.execute(
            "SELECT filename, document_sha256 FROM audit_records WHERE id='mig-audit-1'"
        ).fetchone()
        assert row[0] == "mig.docx"
        assert row[1] is None
        con.close()

    def test_single_head(self):
        from pathlib import Path
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        backend_dir = Path(__file__).resolve().parents[1]
        cfg = Config(str(backend_dir / "alembic.ini"))
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        sd = ScriptDirectory.from_config(cfg)
        assert sd.get_heads() == ["b3e8d19e2b3f"]
