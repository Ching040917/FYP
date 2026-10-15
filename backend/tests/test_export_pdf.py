"""Focused tests for the PDF export endpoint (Phase 1, backend only).

Covers: PDF header/content-type/filename, core sections, 404/409 behavior,
historical NULL stats, long-text wrapping, markup safety, Unicode
punctuation, AI-unavailable export, absence of document blocks, and
non-mutation of persisted results.
"""
import io
import re
import uuid
from types import SimpleNamespace

import pytest

from sqlalchemy.orm import sessionmaker

from app.models.audit import AuditRecord, Violation, CitationIssue
from app.services.ai_citation import build_apa_suggestion
from app.services.layout_violation import LayoutViolation


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _post_audit(client, docx_factory, name="report.docx", paragraphs=None, profile_id=None, **docx_kw):
    if paragraphs is None:
        paragraphs = ["Body paragraph."]
    params = {}
    if profile_id:
        params["profile_id"] = profile_id
    resp = client.post(
        "/api/audit",
        files={"file": (name, docx_factory(paragraphs=paragraphs, **docx_kw), "application/octet-stream")},
        params=params,
    )
    assert resp.status_code == 200
    return resp.json()["audit_id"]


def _export(client, audit_id):
    return client.get(f"/api/audit/{audit_id}/export-pdf")


def _pdf_text(pdf_bytes):
    from pypdf import PdfReader
    raw = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
    return re.sub(r"\s+", " ", raw)


def _seed_audit(test_engine, status="completed", violations=(), citations=(), **fields):
    """Insert an audit record directly (bypasses POST) for status edge cases."""
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit_id = fields.pop("id", str(uuid.uuid4()))
    rec_kwargs = dict(
        id=audit_id,
        filename=fields.pop("filename", "seeded.docx"),
        file_size=100,
        weighted_score=fields.pop("weighted_score", 80),
        deploy_mode=fields.pop("deploy_mode", "LOCAL"),
        status=status,
        paragraph_count=fields.pop("paragraph_count", None),
        heading_count=fields.pop("heading_count", None),
        table_count=fields.pop("table_count", None),
        image_count=fields.pop("image_count", None),
        section_count=fields.pop("section_count", None),
        word_count=fields.pop("word_count", None),
        ai_review_status=fields.pop("ai_review_status", None),
        ai_provider=fields.pop("ai_provider", None),
        document_blocks=fields.pop("document_blocks", None),
    )
    for key in ("profile_snapshot", "section_metadata", "paragraph_page_mapping", "rendered_preview_pages"):
        if key in fields:
            rec_kwargs[key] = fields.pop(key)
    # Only pass datetimes when the caller supplied them, so other tests keep
    # the model defaults (created_at = utcnow, completed_at = NULL).
    if "created_at" in fields:
        rec_kwargs["created_at"] = fields.pop("created_at")
    if "completed_at" in fields:
        rec_kwargs["completed_at"] = fields.pop("completed_at")
    rec = AuditRecord(**rec_kwargs)
    s.add(rec)
    for v in violations:
        s.add(Violation(id=str(uuid.uuid4()), audit_id=audit_id, **v))
    for c in citations:
        s.add(CitationIssue(id=str(uuid.uuid4()), audit_id=audit_id, **c))
    s.commit()
    s.close()
    return audit_id


# ---------------------------------------------------------------------------
# happy path: PDF bytes, headers, filename
# ---------------------------------------------------------------------------

def test_export_returns_pdf_headers_and_safe_filename(client, docx_factory):
    audit_id = _post_audit(client, docx_factory, name="my thesis v1 (final).docx")
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")
    assert resp.headers["content-type"] == "application/pdf"
    disposition = resp.headers["content-disposition"]
    assert "attachment" in disposition
    assert "my_thesis_v1_final-compliance-report.pdf" in disposition


def test_export_pdf_contains_core_sections(client, docx_factory):
    audit_id = _post_audit(
        client, docx_factory,
        paragraphs=[("Body", "Normal"), ("Chapter 2", "Heading 2")],
        margins={"left": 1.0},
    )
    text = _pdf_text(_export(client, audit_id).content)
    for section in (
        "Academic Compliance Report",
        "Executive Summary",
        "Priority Findings",
        "Document Statistics",
        "Scope, Limitations and Privacy",
        "Page Margins",
        # Plain-language title, never the internal rule code.
        "Heading levels skip a step",
    ):
        assert section in text, f"missing section: {section}"
    # No internal rule code ever reaches the reader.
    assert "HEADING_HIERARCHY" not in text
    # The default SUC profile does not check margins — no MARGIN_LEFT finding.
    assert "MARGIN_LEFT" not in text
    # Score wording applies to enabled checks only.
    assert "Compliance Score (enabled checks)" in text
    # SUC disclosure: margins not checked.
    assert "Formatting Profile: SUC Academic Report" in text
    assert "Margins Not checked Disabled in this Profile" in text
    assert "Source: Built-in" in text
    for label in ("Headers", "Footers", "Page numbers"):
        assert f"{label} Not checked Disabled in this Profile" in text


def test_export_pdf_apa_profile_shows_one_inch_margins(client, docx_factory):
    """PDF under the APA profile discloses 1 in margins on all sides."""
    audit_id = _post_audit(
        client, docx_factory,
        paragraphs=[("Body", "Normal")],
        margins={"left": 1.0},
        profile_id="apa7-student-paper",
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Formatting Profile: APA 7 Student Paper" in text
    for side in ("Left", "Right", "Top", "Bottom"):
        assert f"{side} margin: 1 in" in text


def test_export_pdf_zero_findings_no_academic_certification(client, test_engine):
    """Zero-findings wording never certifies academic correctness."""
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=100)
    text = _pdf_text(_export(client, audit_id).content)
    assert "All enabled checks passed" in text
    assert "does not certify" in text
    assert "No errors exist" not in text
    assert "fully compliant" not in text


# ---------------------------------------------------------------------------
# Report Date — English UK presentation (18 Aug 2026, 12:30 PM UTC)
# ---------------------------------------------------------------------------

def test_export_pdf_report_date_english_uk_format(client, test_engine):
    """Report Date uses day-month-year + 12-hour AM/PM with an explicit UTC
    label (the stored datetime is a naive UTC wall-clock moment — it must
    never appear as an unlabelled local time)."""
    from datetime import datetime
    audit_id = _seed_audit(
        test_engine, status="completed",
        created_at=datetime(2026, 8, 18, 12, 30),
        completed_at=datetime(2026, 8, 18, 12, 30),
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Report Date" in text
    assert "18 Aug 2026, 12:30 PM UTC" in text
    # Never the long-form month or a 24-hour clock.
    assert "18 August 2026" not in text
    assert "12:30:00" not in text


def test_export_pdf_report_date_midnight_and_december(client, test_engine):
    from datetime import datetime
    audit_id = _seed_audit(
        test_engine, status="completed",
        created_at=datetime(2026, 12, 5, 0, 5),
        completed_at=datetime(2026, 12, 5, 0, 5),
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "05 Dec 2026, 12:05 AM UTC" in text


def test_export_pdf_report_date_falls_back_to_created_at(client, test_engine):
    """A completed_at of NULL (processing/legacy) falls back to created_at."""
    from datetime import datetime
    audit_id = _seed_audit(
        test_engine, status="completed",
        created_at=datetime(2026, 8, 18, 8, 5),
        completed_at=None,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "18 Aug 2026, 08:05 AM UTC" in text


# ---------------------------------------------------------------------------
# 404 / 409 behavior
# ---------------------------------------------------------------------------

def test_export_unknown_audit_returns_404(client):
    resp = _export(client, str(uuid.uuid4()))
    assert resp.status_code == 404


def test_export_processing_audit_returns_409(client, test_engine):
    audit_id = _seed_audit(test_engine, status="processing")
    resp = _export(client, audit_id)
    assert resp.status_code == 409
    assert "still being processed" in resp.json()["detail"].lower()


def test_export_failed_audit_without_findings_returns_409(client, test_engine):
    audit_id = _seed_audit(test_engine, status="failed")
    resp = _export(client, audit_id)
    assert resp.status_code == 409
    assert "nothing to export" in resp.json()["detail"].lower()


def test_export_failed_audit_with_findings_succeeds(client, test_engine):
    audit_id = _seed_audit(
        test_engine, status="failed",
        violations=[{"rule_code": "MARGIN_LEFT", "severity": "MAJOR",
                     "location": {"section_index": 0}, "message": "Left margin off."}],
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")


# ---------------------------------------------------------------------------
# content edge cases
# ---------------------------------------------------------------------------

def test_historical_null_stats_show_unavailable(client, test_engine):
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=90)
    text = _pdf_text(_export(client, audit_id).content)
    assert text.count("Unavailable") >= 6


def test_long_text_wraps_without_crash(client, test_engine):
    long_message = "This is a very long finding message. " * 120
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=85,
        violations=[{"rule_code": "FONT_CONSISTENCY", "severity": "MAJOR",
                     "location": {"paragraph_index": 0}, "message": long_message,
                     "expected_value": "Times New Roman", "actual_value": "Arial"}],
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    from pypdf import PdfReader
    pages = PdfReader(io.BytesIO(resp.content)).pages
    assert len(pages) >= 2, "long finding should wrap across at least two pages"
    text = _pdf_text(resp.content)
    # pypdf wraps long runs across lines — check a distinctive prefix is present
    assert long_message[:30] in text


def test_markup_like_input_rendered_as_literal_text(client, test_engine):
    audit_id = _seed_audit(
        test_engine, status="completed",
        violations=[{"rule_code": "FONT_SIZE", "severity": "MAJOR",
                     "location": {"paragraph_index": 0},
                     "message": "<b>bold</b> &amp; <script>alert(1)</script>"}],
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "<b>bold</b>" in text          # rendered as literal text
    assert "&lt;" not in text             # no double-escaped markup
    assert "alert(1)" in text             # script tag stays inert text


def test_unicode_punctuation_renders(client, test_engine):
    audit_id = _seed_audit(
        test_engine, status="completed",
        violations=[{"rule_code": "ALIGNMENT", "severity": "MAJOR",
                     "location": {"paragraph_index": 0},
                     "message": "Quote “curly” – en dash — em dash … ellipsis café"}],
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    assert "curly" in _pdf_text(resp.content)


def test_ai_unavailable_audit_exports(client, test_engine):
    audit_id = _seed_audit(
        test_engine, status="completed",
        ai_review_status="UNAVAILABLE", ai_provider="LOCAL_OLLAMA",
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")


def test_document_block_text_absent_from_pdf(client, docx_factory):
    secret = "SUPER SECRET FYP BODY TEXT 99173"
    audit_id = _post_audit(client, docx_factory, paragraphs=[secret])
    text = _pdf_text(_export(client, audit_id).content)
    assert secret not in text


def test_shared_apa_material_appears_once(client, test_engine):
    suggestion = build_apa_suggestion(
        "Add the missing reference entry for this source.", "journal_article")
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=80,
        violations=[
            {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
             "location": {"paragraph_index": 0},
             "message": "Citation 'Garcia (2018)' was found in text, but no matching entry was found in the References section.",
             "expected_value": "Matching References entry", "actual_value": "Garcia (2018)"},
            {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
             "location": {"paragraph_index": 2},
             "message": "Citation 'Lee (2020)' was found in text, but no matching entry was found in the References section.",
             "expected_value": "Matching References entry", "actual_value": "Lee (2020)"},
        ],
        citations=[
            {"paragraph_index": 0, "text_snippet": "Garcia (2018) states",
             "issue_type": "CITATION_MISMATCH", "message": "No matching entry.",
             "suggestion": suggestion, "confidence": 0.9},
            {"paragraph_index": 2, "text_snippet": "Lee (2020) argues",
             "issue_type": "CITATION_MISMATCH", "message": "No matching entry.",
             "suggestion": suggestion, "confidence": 0.8},
        ],
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "APA 7 Reference Checklist and Templates" in text
    # shared checklist + template appear once, not per finding
    assert text.count("Verify every corrected citation against this checklist:") == 1
    assert text.count("- Author name and initials") == 1
    assert text.count("Journal article:") == 1


def test_persisted_score_and_findings_unchanged_after_export(client, docx_factory):
    audit_id = _post_audit(
        client, docx_factory,
        paragraphs=[("Body", "Normal"), ("Chapter 2", "Heading 2")],
        margins={"left": 1.0},
    )
    before = client.get(f"/api/audit/{audit_id}").json()
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    after = client.get(f"/api/audit/{audit_id}").json()
    assert after["weighted_score"] == before["weighted_score"]
    assert after["status"] == before["status"]
    assert len(after["violations"]) == len(before["violations"])
    assert [v["rule_code"] for v in after["violations"]] == [v["rule_code"] for v in before["violations"]]
    assert [v["severity"] for v in after["violations"]] == [v["severity"] for v in before["violations"]]


# ---------------------------------------------------------------------------
# polish: readability fixes
# ---------------------------------------------------------------------------

def test_no_apacitationsai_label(client, docx_factory):
    """Category breakdown must use 'APA Citations' not 'APA Citations (AI)."""
    audit_id = _post_audit(client, docx_factory, paragraphs=["Body."])
    text = _pdf_text(_export(client, audit_id).content)
    assert "APA Citations (AI)" not in text
    assert "APA Citations" in text


def test_no_bullet_glyph_in_checklist(client, test_engine):
    """Checklist must use ASCII hyphens, not Unicode bullets."""
    suggestion = build_apa_suggestion("Add the missing entry.", "journal_article")
    audit_id = _seed_audit(
        test_engine, status="completed",
        violations=[{"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
                     "location": {"paragraph_index": 0},
                     "message": "Citation 'Test (2024)' was found but no matching entry.",
                     "expected_value": "Matching entry", "actual_value": "Test (2024)"}],
        citations=[{"paragraph_index": 0, "text_snippet": "Test (2024)",
                     "issue_type": "CITATION_MISMATCH", "message": "No match.",
                     "suggestion": suggestion, "confidence": 0.9}],
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "•" not in text  # no Unicode bullet


def test_no_visible_confidence_percentage(client, test_engine):
    """Confidence percentages must not appear in the PDF."""
    suggestion = build_apa_suggestion("Add the missing entry.", "journal_article")
    audit_id = _seed_audit(
        test_engine, status="completed",
        citations=[{"paragraph_index": 0, "text_snippet": "Test (2024)",
                     "issue_type": "CITATION_MISMATCH", "message": "No match.",
                     "suggestion": suggestion, "confidence": 0.95}],
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "confidence" not in text.lower()
    assert "AI-assisted guidance" in text


def test_privacy_statement_matches_storage_behavior(client, test_engine):
    """Privacy statement must accurately describe data handling."""
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=90)
    text = _pdf_text(_export(client, audit_id).content)
    assert "The original Word file is not stored or modified" in text
    assert "Extracted paragraph text may be stored" in text
    assert "This PDF excludes the full document text" in text


def test_grouped_minors_preserve_all_findings(client, test_engine):
    """Grouped minor findings must still account for all violations."""
    # Seed multiple minor violations with same rule code
    violations = [
        {"rule_code": "FONT_CONSISTENCY", "severity": "MINOR",
         "location": {"paragraph_index": i},
         "message": f"Font mismatch in paragraph {i}",
         "expected_value": "Times New Roman", "actual_value": "Arial"}
        for i in range(10)
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=60,
        violations=violations,
    )
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "Formatting Issue Summary" in text
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    assert register.count("Font family does not match") == len(violations)
    for index in range(1, 11):
        assert f"Paragraph {index}" in register
    # All 10 findings present exactly once in the appendix register, each
    # labelled with the plain-language rule name (never the raw code).
    assert text.count("Font family does not match") >= 11  # 1 group header + 10 register rows


def test_major_findings_remain_individual(client, test_engine):
    """Major findings must always be shown individually, not grouped."""
    violations = [
        {"rule_code": "MARGIN_LEFT", "severity": "MAJOR",
         "location": {"section_index": 0},
         "message": "Left margin wrong",
         "expected_value": "1.5in", "actual_value": "1.00in"},
        {"rule_code": "HEADING_HIERARCHY", "severity": "MAJOR",
         "location": {"paragraph_index": 5},
         "message": "Heading level skipped",
         "expected_value": "H2", "actual_value": "H3"},
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=70,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Left page margin does not match" in text
    assert "Heading levels skip a step" in text
    assert "Left margin wrong" in text
    assert "Heading level skipped" in text
    assert "Finding 1" not in text
    assert "Finding 2" not in text


def test_specific_action_when_values_exist(client, test_engine):
    """When expected/actual values exist, action should be specific."""
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=85,
        violations=[{"rule_code": "SPACE_BEFORE", "severity": "MAJOR",
                     "location": {"paragraph_index": 18},
                     "message": "Space before 18pt != required 0pt",
                     "expected_value": "0pt", "actual_value": "18pt"}],
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Change space before for Paragraph 19 from 18 pt to 0 pt." in text


def test_pdf_never_exposes_banned_tokens(client, test_engine):
    """Student-facing PDF: no !=, ->, =>, SEQ field, or numPr anywhere."""
    violations = [
        {"rule_code": "FONT_SIZE", "severity": "MAJOR",
         "location": {"paragraph_index": 0, "run_index": 0},
         "message": "Body font size 15pt != required 12pt",
         "expected_value": "12pt", "actual_value": "15pt"},
        {"rule_code": "IMAGE_ALT_TEXT_MISSING", "severity": "MAJOR",
         "location": {"image_index": 0, "paragraph_index": 4},
         "message": "Image 1 has no alt-text. Right-click the image -> Alt Text -> enter a description.",
         "expected_value": "Non-empty alt-text description",
         "actual_value": "Empty or missing docPr@descr"},
        {"rule_code": "MANUAL_CAPTION", "severity": "MINOR",
         "location": {"table_index": 0, "paragraph_index": 3},
         "message": "Table 1 has a manually typed caption. Use Word semantics.",
         "expected_value": "Word caption (References → Insert Caption)",
         "actual_value": "Manual 'Table N' text without Caption style or SEQ field"},
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=70,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "!=" not in text
    assert "->" not in text
    assert "=>" not in text
    assert "SEQ field" not in text
    assert "numPr" not in text
    assert "docPr@descr" not in text
    # Cleaned wording survives
    assert "is not" in text
    assert "automatic caption numbering" in text
    assert "to Alt Text to enter" in text


def test_pdf_cleaned_message_does_not_mutate_persisted_raw(client, test_engine):
    """Export cleans only the PDF surface; the persisted message stays raw."""
    violations = [{"rule_code": "LINE_SPACING", "severity": "MINOR",
                   "location": {"paragraph_index": 2},
                   "message": "Line spacing 2.0 != required 1.5",
                   "expected_value": "1.5", "actual_value": "2.0"}]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=90,
        violations=violations,
    )
    _export(client, audit_id)
    from app.models.audit import AuditRecord, Violation as ViolationModel
    Session = sessionmaker(bind=test_engine)
    s = Session()
    row = s.query(ViolationModel).filter_by(audit_id=audit_id).one()
    assert row.message == "Line spacing 2.0 != required 1.5"
    s.close()


def test_score_and_deductions_unchanged(client, docx_factory):
    """Score and category deductions must remain unchanged after polish."""
    audit_id = _post_audit(
        client, docx_factory,
        paragraphs=[("Body", "Normal"), ("Chapter 2", "Heading 2")],
        margins={"left": 1.0},
    )
    resp = client.get(f"/api/audit/{audit_id}")
    score = resp.json()["weighted_score"]
    breakdown = resp.json()["score_breakdown"]
    text = _pdf_text(_export(client, audit_id).content)
    # Verify score appears in PDF
    assert str(score) in text
    # Verify category labels still present
    assert "Page Margins" in text
    assert "APA Citations" in text


# ---------------------------------------------------------------------------
# Report structure improvements (Build 9A)
# ---------------------------------------------------------------------------

def test_citation_required_action_uses_correct_wording(client, test_engine):
    """CITATION_MISMATCH must not generate 'Change citation entry from X to Y'."""
    violations = [
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 0},
         "message": "Citation 'Garcia (2018)' was found in text, but no matching entry was found.",
         "expected_value": "Matching References entry", "actual_value": "Garcia (2018)"},
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 3},
         "message": "Citation 'Lee (2020)' was found in text, but no matching entry was found.",
         "expected_value": "Matching References entry", "actual_value": "Lee (2020)"},
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=85,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Change citation entry" not in text
    assert "Add a matching References entry for Garcia (2018), or correct or remove" in text
    assert "Add a matching References entry for Lee (2020), or correct or remove" in text


def test_formatting_summary_groups_by_saved_rule_and_required_value():
    from app.services.pdf_report import _formatting_summary_rows
    findings = [
        SimpleNamespace(rule_code="SPACE_BEFORE", expected_value=expected, actual_value=actual,
                        location={"paragraph_index": index})
        for index, (expected, actual) in enumerate((("0pt", "2pt"), ("12pt", "6pt"), ("0pt", "18pt")))
    ]
    rows = _formatting_summary_rows(findings, None)
    assert rows == [
        ("Space before the paragraph does not match", 2, "Unavailable", "2 pt; 18 pt", "0 pt"),
        ("Space before the paragraph does not match", 1, "Unavailable", "6 pt", "12 pt"),
    ]


def test_register_preserves_all_mixed_values_without_internal_ids(client, test_engine):
    observed = [f"font-choice-{index}-" + "long-value-" * 8 for index in range(8)]
    audit_id = _seed_audit(test_engine, weighted_score=80, violations=[
        {"rule_code": "FONT_CONSISTENCY", "severity": "MINOR",
         "location": {"paragraph_index": index, "run_index": index},
         "message": "A saved font differs.", "actual_value": value, "expected_value": "Required family"}
        for index, value in enumerate(observed)
    ])
    text = _pdf_text(_export(client, audit_id).content)
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    for index, value in enumerate(observed, 1):
        assert value.replace(" ", "") in register.replace(" ", "")
        assert f"Paragraph {index}" in register
    assert register.count("Font family does not match") == len(observed)
    assert "full values in register" in text
    assert not re.search(r"\b[PGF]\d{3}\b", text)
    assert "Run " not in text


def test_complete_register_columns_and_severity_order(client, test_engine):
    audit_id = _seed_audit(test_engine, weighted_score=80, violations=[
        {"rule_code": code, "severity": severity, "location": {"paragraph_index": index},
         "message": f"Saved finding {index}", "actual_value": actual, "expected_value": required}
        for index, (code, severity, actual, required) in enumerate((
            ("FONT_SIZE", "MINOR", "11pt", "12pt"),
            ("MARGIN_LEFT", "MAJOR", "1in", "1.5in"),
            ("CITATION_REFERENCE_AMBIGUOUS", "REVIEW", "Smith (2024)", "One unambiguous entry"),
        ))
    ])
    text = _pdf_text(_export(client, audit_id).content)
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    assert "Status Finding Location Current Required" in register
    assert register.index("Major Left page margin") < register.index("Minor Font size")
    assert "Manual Review Register" in register
    assert "Manual review · Unscored Citation could match more than one entry" in register
    assert "Smith (2024)" in register
    assert "One unambiguous entry" in register

def test_actionable_minor_register_rows_keep_actions_once_and_leave_manual_cards_unduplicated(client, test_engine):
    from app.services.pdf_report import _REQUIRED_ACTIONS

    findings = [
        {"rule_code": "REFERENCE_DOI_FORMAT", "severity": "MINOR",
         "location": {"paragraph_index": 1}, "message": "DOI presentation differs.",
         "actual_value": "doi:10.1234/abc", "expected_value": "https://doi.org/<doi>"},
        {"rule_code": "REFERENCE_ORDER", "severity": "MINOR",
         "location": {"paragraph_index": 2}, "message": "Entries are out of order.",
         "actual_value": "Smith before Adams", "expected_value": "Alphabetical order"},
        {"rule_code": "PAGE_NUMBER_FIELD_REQUIRED", "severity": "REVIEW",
         "location": {"structural_story": True, "section_index": 0,
                      "story_type": "footer", "evidence_state": "missing"},
         "message": "Saved structural note.", "actual_value": "No PAGE field",
         "expected_value": "Automatic page-number field"},
        {"rule_code": "SOME_FUTURE_RULE", "severity": "ARCHIVE",
         "location": {}, "message": "Saved legacy observation.",
         "actual_value": None, "expected_value": None},
    ]
    audit_id = _seed_audit(test_engine, weighted_score=96, violations=findings)
    before = client.get(f"/api/audit/{audit_id}").json()
    text = _pdf_text(_export(client, audit_id).content)
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    for code in ("REFERENCE_DOI_FORMAT", "REFERENCE_ORDER"):
        action = _REQUIRED_ACTIONS[code]
        assert text.count(action) == 1
        assert f"Action {action}" in register
    assert "https://doi.org/<doi>" in register
    assert "Smith before Adams" in register
    assert register.count("Action") == 2
    assert "Action Review the footer in Word; insert an automatic page number if required." in text
    assert "Action Review the footer in Word" not in register
    assert "Saved legacy observation." not in register  # only Current/Required are shown
    assert text.count("Manual review · Unscored") >= 1
    assert client.get(f"/api/audit/{audit_id}").json() == before


def test_long_minor_action_wraps_without_losing_the_saved_value(client, test_engine):
    observed = "long-font-name-" * 38
    audit_id = _seed_audit(test_engine, weighted_score=99, violations=[{
        "rule_code": "FONT_CONSISTENCY", "severity": "MINOR",
        "location": {"paragraph_index": 0}, "message": "Formatting differs.",
        "actual_value": observed, "expected_value": "Times New Roman",
    }])
    text = _pdf_text(_export(client, audit_id).content)
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    assert register.count("Action") == 1
    assert "Change font for Paragraph 1 from" in register
    assert observed in re.sub(r"\s+", "", register)
    assert "to Times New Roman." in register


def test_minor_frequency_counts_saved_findings_not_occurrences():
    from app.services.pdf_report import _minor_frequency, _priority_findings
    findings = [SimpleNamespace(rule_code=code, severity=severity, location={"occurrences": 40})
                for code, severity in (("FONT_SIZE", "MINOR"), ("ALIGNMENT", "MINOR"),
                                       ("FONT_SIZE", "MINOR"), ("FONT_SIZE", "MAJOR"),
                                       ("ALIGNMENT", "REVIEW"))]
    assert _minor_frequency(findings) == [("FONT_SIZE", 2), ("ALIGNMENT", 1)]
    assert [v.severity for v in _priority_findings(findings)] == ["MAJOR", "REVIEW"]


def test_disabled_categories_require_known_saved_evidence():
    from app.services.pdf_report import _category_disabled
    from app.services.profile_snapshot import EffectiveProfileSnapshot
    snapshot = EffectiveProfileSnapshot().with_fingerprint().to_dict()
    assert _category_disabled("page_margins", snapshot)
    assert _category_disabled("font_consistency", snapshot)
    assert _category_disabled("font_size", snapshot)
    assert not _category_disabled("page_margins", None)
    assert not _category_disabled("font_size", {"body": {}})
    snapshot["body"]["font_size_pt"] = 11
    assert not _category_disabled("font_size", snapshot)
    assert _category_disabled("font_consistency", snapshot)


def test_executive_scope_and_final_disclosure_are_not_duplicated(client, test_engine):
    from pypdf import PdfReader
    audit_id = _seed_audit(test_engine, weighted_score=100)
    response = _export(client, audit_id)
    pages = [re.sub(r"\s+", " ", page.extract_text() or "")
             for page in PdfReader(io.BytesIO(response.content)).pages]
    text = " ".join(pages)
    assert "Executive Summary" in pages[0]
    assert "Profile Coverage Matrix" not in pages[0]
    assert "Profile Coverage Matrix" in pages[1]
    assert text.count("Scope, Limitations and Privacy") == 1
    assert "Scope, Limitations and Privacy" in pages[-1]
    assert text.index("Appendix: Full Profile Requirements") < text.index("Scope, Limitations and Privacy")
    for number, page in enumerate(pages, 1):
        assert f"Page {number} of {len(pages)}" in page
        assert "Generated locally · Original DOCX unchanged" in page



def test_citation_guidance_preserved_for_garcia_and_lee(client, test_engine):
    """Separate Garcia and Lee guidance items remain distinct in the PDF."""
    suggestion = (
        "Recommended correction\n"
        "Add the missing reference entry.\n\n"
        "What to verify\n- Author name and initials\n\n"
        "APA 7 formatting example\nJournal article:\nAuthor, A. (Year).\n\n"
        "Formatting example only."
    )
    violations = [
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 0},
         "message": "Citation 'Garcia (2018)' was found in text, but no matching entry was found.",
         "expected_value": "Matching References entry", "actual_value": "Garcia (2018)"},
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 2},
         "message": "Citation 'Lee (2020)' was found in text, but no matching entry was found.",
         "expected_value": "Matching References entry", "actual_value": "Lee (2020)"},
    ]
    citations = [
        {"paragraph_index": 0, "text_snippet": "Garcia (2018) states",
         "issue_type": "CITATION_MISMATCH", "message": "No matching entry.",
         "suggestion": suggestion, "confidence": 0.9},
        {"paragraph_index": 2, "text_snippet": "Lee (2020) argues",
         "issue_type": "CITATION_MISMATCH", "message": "No matching entry.",
         "suggestion": suggestion, "confidence": 0.8},
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=85,
        violations=violations, citations=citations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Garcia (2018)" in text
    assert "Lee (2020)" in text
    # Shared APA material appears once
    assert text.count("Verify every corrected citation against this checklist:") == 1
    assert text.count("Journal article:") == 1


# ---------------------------------------------------------------------------
# Citation ↔ Reference List matching findings (citation reference build)
# ---------------------------------------------------------------------------

def test_new_citation_reference_codes_render_friendly_wording(client, test_engine):
    """Each new deterministic code carries a friendly rule name and its fixed
    Required Action — never a raw rule code or a formatting instruction."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_REFERENCE_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 3, "occurrences": 1, "paragraph_indexes": [3]},
         "message": "Citation 'Smith (2020)' and the Reference List entry for Smith (2019) state different years.",
         "expected_value": "Consistent year for Smith (2019)", "actual_value": "(Smith, 2020)"},
        {"rule_code": "CITATION_YEAR_SUFFIX_MISMATCH", "severity": "MINOR",
         "location": {"paragraph_index": 4, "occurrences": 1, "paragraph_indexes": [4]},
         "message": "Citation 'Smith (2020)' is missing the year suffix used by the Reference List entry 'Smith (2020a)'.",
         "expected_value": "Smith (2020a)", "actual_value": "(Smith, 2020)"},
        {"rule_code": "REFERENCE_NOT_CITED", "severity": "MINOR",
         "location": {"paragraph_index": 12},
         "message": "Reference List entry 'Jones (2019)' was not cited in the body text.",
         "expected_value": "At least one in-text citation",
         "actual_value": "Jones, A. (2019). Other. Press."},
        {"rule_code": "REFERENCE_DUPLICATE", "severity": "MINOR",
         "location": {"paragraph_index": 14, "entry_count": 2, "paragraph_indexes": [12, 14]},
         "message": "Reference List entry 'Jones (2019)' appears 2 times; a source must have exactly one entry.",
         "expected_value": "One entry per source",
         "actual_value": "Jones, A. (2019). Other. Press."},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    assert "Citation year does not match the Reference List entry" in text
    assert "Citation is missing or uses the wrong year suffix" in text
    assert "Reference List entry is not cited in the text" in text
    assert "Duplicate Reference List entry" in text
    assert "Correct the year in the in-text citation or in the Reference List entry so both state the same year." in text
    for value in ("Smith (2020a)", "At least one in-text citation", "One entry per source",
                  "Jones, A. (2019). Other. Press."):
        assert value in text
    # The technical codes must not leak into the report at all.
    assert "CITATION_REFERENCE_MISMATCH" not in text


def test_review_finding_gets_its_own_panel_register_group_and_no_score_impact(client, test_engine):
    """REVIEW findings get an individual panel and a "Manual review" register
    group (never the old "For review"), and stay out of the major/minor counts
    and the score."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_REFERENCE_AMBIGUOUS", "severity": "REVIEW",
         "location": {"paragraph_index": 7, "occurrences": 1, "paragraph_indexes": [7]},
         "message": ("Citation 'Smith (2024)' could match 2 Reference List entries for Smith; "
                     "the citation carries no initials."),
         "expected_value": "One unambiguous matching entry", "actual_value": "(Smith, 2024)"},
    ])
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "Manual review" in text
    assert "Citation could match more than one entry" in text
    # REVIEW severity is labelled "Manual review", never Major/Minor, and the
    # retired "For review" wording is gone from the whole document.
    assert "For review" not in text
    assert "Major Citation could match more than one entry" not in text
    # The explanatory panel exists, not just a bare register row.
    assert "Manual Review Findings" in text
    # One finding, zero major, zero minor, and the score stays 100.
    assert "1 deterministic finding(s): 0 major" in text
    assert "0 minor" in text
    assert "1 for manual review (never scored)" in text
    assert "Compliance Score" in text
    assert "100" in text


def test_citation_mismatch_uses_the_shared_plain_language_title(client, test_engine):
    """CITATION_MISMATCH uses the same plain-language title as the web UI."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 3, "occurrences": 1, "paragraph_indexes": [3]},
         "message": ("Citation 'Garcia (2018)' was found in text, but no matching entry "
                     "was found in the References bibliography."),
         "expected_value": "Reference entry for Garcia",
         "actual_value": "(Garcia, 2018)"},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    assert "Citation has no matching Reference List entry" in text
    assert "Garcia" in text
    # Deterministic, author-specific correction (unchanged behaviour).
    assert (
        "Add a matching References entry for Garcia (2018), or correct or remove "
        "the in-text citation if it refers to the wrong source." in text
    )


def test_missing_section_root_finding_exports_without_crashing(client, test_engine):
    """A document-wide finding (paragraph_index None) must export cleanly and
    show the root message without a fabricated paragraph location."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 3, "citation_count": 3, "missing_references_section": True},
         "message": "No References section was found, so 3 in-text citation(s) could not be checked.",
         "expected_value": "References section", "actual_value": None},
    ])
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "3 in-text citation(s) could not be checked" in text
    # The document-wide action is "add the section", not "fix one citation".
    assert "Add a References section and list every source cited in the text." in text


def test_missing_section_finding_is_not_phrased_as_one_citation(client, test_engine):
    """A document-wide finding must never render as a per-citation repair."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_MISMATCH", "severity": "MAJOR",
         "location": {"paragraph_index": 1, "citation_count": 2, "missing_references_section": True},
         "message": "No References section was found, so 2 in-text citation(s) could not be checked.",
         "expected_value": "References section", "actual_value": None},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    assert "No References section was found, so 2 in-text citation(s) could not be checked." in text
    assert "Add a References section and list every source cited in the text." in text
    # Never the generic single-citation wording.
    assert "Add a matching References entry for this citation" not in text




def test_unclassified_severity_renders_in_the_register_and_is_never_scored(client, test_engine):
    """A severity token outside MAJOR/MINOR/REVIEW is reachable (the column has
    no CheckConstraint). It must be counted, labelled and rendered — never
    dropped from the report."""
    audit_id = _seed_audit(test_engine, weighted_score=90, violations=[
        {"rule_code": "FONT_SIZE", "severity": "ARCHIVE",
         "location": {"paragraph_index": 2},
         "message": "Font size 14pt != required 12pt",
         "expected_value": "12pt", "actual_value": "14pt"},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    # Counted in the summary, with its own reconciling clause.
    assert "1 deterministic finding(s): 0 major" in text
    assert "0 minor" in text
    assert "1 unclassified (historical severity, never scored)" in text
    # Rendered under its own register sub-table with the reader-facing label.
    assert "Unclassified" in text
    assert "Font size does not match" in text
    # Never the raw token, and never counted as a scored severity.
    assert "ARCHIVE" not in text
    assert "Major Font size does not match" not in text
    assert "Minor Font size does not match" not in text


def test_summary_totals_reconcile_across_all_four_severities(client, test_engine):
    """Every stored finding lands in exactly one severity group and the summary
    arithmetic adds up — a dropped finding makes these numbers disagree."""
    audit_id = _seed_audit(test_engine, weighted_score=75, violations=[
        {"rule_code": "MARGIN_LEFT", "severity": "MAJOR",
         "location": {"paragraph_index": 0}, "message": "Left margin is 1.00in, required 1.5in.",
         "expected_value": "1.5in", "actual_value": "1.00in"},
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": 1}, "message": "Font size 14pt != required 12pt",
         "expected_value": "12pt", "actual_value": "14pt"},
        {"rule_code": "LINE_SPACING", "severity": "MINOR",
         "location": {"paragraph_index": 2}, "message": "Line spacing 1.0, required 1.5",
         "expected_value": "1.5", "actual_value": "1.0"},
        {"rule_code": "CITATION_REFERENCE_AMBIGUOUS", "severity": "REVIEW",
         "location": {"paragraph_index": 3}, "message": "Citation could match 2 entries.",
         "expected_value": "One unambiguous matching entry", "actual_value": "(Smith, 2024)"},
        {"rule_code": "ALIGNMENT", "severity": "ARCHIVE",
         "location": {"paragraph_index": 4}, "message": "Alignment left, required justify",
         "expected_value": "justify", "actual_value": "left"},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    # Exact reconciliation: 5 findings, split 1 / 2 / 1 / 1.
    assert (
        "5 deterministic finding(s): 1 major (shown individually), "
        "2 minor (grouped by rule code and expected value), "
        "1 for manual review (never scored), "
        "1 unclassified (historical severity, never scored)."
    ) in text, "summary does not reconcile across the four severity groups"

    # Each group is labelled and carries its own findings.
    assert "Scored and Historical Findings Register" in text
    assert "Manual Review Register" in text
    assert "Manual review" in text
    assert "Unclassified" in text
    register = text.split("Appendix — Findings Register", 1)[1].split("Appendix: Full Profile Requirements", 1)[0]
    for title in ("Left page margin does not match", "Font size does not match",
                  "Line spacing does not match", "Citation could match more than one entry",
                  "Paragraph alignment does not match"):
        assert register.count(title) == 1
    # No raw severity token or rule code leaks into the reader-facing report.
    assert "ARCHIVE" not in text
    for code in ("MARGIN_LEFT", "FONT_SIZE", "LINE_SPACING",
                 "CITATION_REFERENCE_AMBIGUOUS", "ALIGNMENT"):
        assert code not in text, f"raw rule code {code} reached the report"


def test_register_columns_and_manual_review_panel_contract(client, test_engine):
    """The register header reads Current/Required (matching the panels), and a
    REVIEW finding gets the same individual panel treatment as a Major one."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "CITATION_REFERENCE_AMBIGUOUS", "severity": "REVIEW",
         "location": {"paragraph_index": 5},
         "message": "Citation could match 2 entries for Smith.",
         "expected_value": "One unambiguous matching entry", "actual_value": "(Smith, 2024)"},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    assert "Status Finding Location Current Required" in text
    # The retired wording is gone entirely.
    assert "For review" not in text
    assert "Found (Smith, 2024)" in text
    assert "Expected One unambiguous matching entry" in text
    # A REVIEW finding is never counted as a scored severity. ("Major"/"Minor"
    # remain legitimate column headers elsewhere, so the counts are the
    # contract that must hold.)
    assert "1 deterministic finding(s): 0 major" in text
    assert "0 minor" in text
    assert "1 for manual review (never scored)" in text
    assert "Compliance Score (enabled checks)" in text


def test_reference_hanging_indent_values_and_occurrences_reach_the_pdf(client, test_engine):
    """The compact summary/register retain each required/current comparison and
    consolidated occurrence count without repeating a correction essay."""
    audit_id = _seed_audit(test_engine, violations=[
        {"rule_code": "REFERENCE_HANGING_INDENT", "severity": "MINOR",
         "location": {"paragraph_index": 4, "occurrences": 3,
                      "paragraph_indexes": [4, 5, 6]},
         "message": "This reference entry uses 0in. The APA 7 Student Paper profile requires 0.5in.",
         "expected_value": "0.5in", "actual_value": "0in"},
        {"rule_code": "REFERENCE_HANGING_INDENT", "severity": "MINOR",
         "location": {"paragraph_index": 9, "occurrences": 1, "paragraph_indexes": [9]},
         "message": "This reference entry uses 0.25in. The APA 7 Student Paper profile requires 0.5in.",
         "expected_value": "0.5in", "actual_value": "0.25in"},
    ])
    text = _pdf_text(_export(client, audit_id).content)
    # Same Current and Required values as the workspace.
    assert "0 in" in text
    assert "0.5 in" in text
    assert "0.25 in" in text
    assert "3 occurrences" in text
    # No raw unit token or rule code leaks.
    assert "0in" not in text.replace("0 in", "")
    assert "REFERENCE_HANGING_INDENT" not in text


# ---------------------------------------------------------------------------
# PDF rule-coverage inventory (Phase 1 of the PDF completion task)
# ---------------------------------------------------------------------------

# Every rule family that can appear in a persisted report. Functional PDF
# regressions below cover structural findings with their actual saved values.
_PRODUCTION_RULE_CODES = (
    # Layout engine (static)
    "MARGIN_LEFT", "MARGIN_RIGHT", "MARGIN_TOP", "MARGIN_BOTTOM",
    "FONT_CONSISTENCY", "FONT_SIZE", "LINE_SPACING",
    "SPACE_BEFORE", "SPACE_AFTER", "ALIGNMENT",
    "HEADING_HIERARCHY",
    "TABLE_CAPTION_MISSING", "IMAGE_CAPTION_MISSING",
    "MANUAL_CAPTION", "IMAGE_ALT_TEXT_MISSING",
    # Phase 2 citation sensor / citation matching
    "CITATION_MISMATCH", "CITATION_REFERENCE_MISMATCH",
    "CITATION_YEAR_SUFFIX_MISMATCH", "CITATION_REFERENCE_AMBIGUOUS",
    "REFERENCE_NOT_CITED", "REFERENCE_DUPLICATE",
    # Phase 3 Reference List formatting
    "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
    "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
    "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
    "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
    "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
    # Author-only alphabetical-order review
    "REFERENCE_ORDER",
    "REFERENCE_DOI_FORMAT",
    "HEADER_CONTENT_REQUIRED", "FOOTER_CONTENT_REQUIRED", "PAGE_NUMBER_FIELD_REQUIRED",
)



def test_every_production_rule_has_a_friendly_pdf_title():
    """No production code may reach the reader as a raw token."""
    from app.services.pdf_report import _RULE_NAME

    missing = [c for c in _PRODUCTION_RULE_CODES if c not in _RULE_NAME]
    assert missing == [], f"production rules with no friendly PDF title: {missing}"
    for code in _PRODUCTION_RULE_CODES:
        title = _RULE_NAME[code]
        assert title and title != code, f"{code} has no bespoke title"
        assert "_" not in title, f"{code} title still looks like a rule code: {title}"




def test_every_production_rule_has_a_safe_required_action():
    """`_friendly_required_action` must never KeyError or fall back to the
    generic sentence for a code ACA can actually emit."""
    from app.services.pdf_report import (
        _CITATION_MATCH_RULES,
        _REQUIRED_ACTIONS,
        _friendly_required_action,
    )

    generic = "Review the finding and apply the required formatting."
    for code in _PRODUCTION_RULE_CODES:
        v = LayoutViolation(
            rule_code=code, severity="MINOR",
            location={"paragraph_index": 3},
            message="Deterministic message.",
            expected_value="12pt", actual_value="11pt",
        )
        action = _friendly_required_action(v, "Paragraph 4", ("Affected content", "Entire paragraph"))
        assert action, f"{code} produced an empty required action"
        if code not in ("IMAGE_CAPTION_MISSING", "IMAGE_ALT_TEXT_MISSING"):
            assert action != generic, f"{code} fell back to the generic action"


def test_unknown_production_code_gets_a_safe_humanised_fallback():
    """A hypothetical future code must not crash or print raw internals."""
    from app.services.pdf_report import _friendly_required_action, _rule_name

    v = LayoutViolation(
        rule_code="SOME_FUTURE_RULE", severity="MINOR",
        location={"paragraph_index": 1}, message="m",
        expected_value=None, actual_value=None,
    )
    action = _friendly_required_action(v, "Paragraph 2", None)
    assert action
    assert "SOME_FUTURE_RULE" not in action
    assert _rule_name("SOME_FUTURE_RULE") == "Some future rule"


@pytest.mark.parametrize(
    "code,kind,state,current,required",
    [
        ("HEADER_CONTENT_REQUIRED", "header", "missing",
         "No effective Normal-pages Header definition",
         "Text or a supported field in each section's Normal-pages Header definition"),
        ("FOOTER_CONTENT_REQUIRED", "footer", "missing",
         "No effective Normal-pages Footer definition",
         "Text or a supported field in each section's Normal-pages Footer definition"),
        ("HEADER_CONTENT_REQUIRED", "header", "empty",
         "The effective Normal-pages Header contains no text or supported field",
         "Text or a supported field in each section's Normal-pages Header definition"),
        ("FOOTER_CONTENT_REQUIRED", "footer", "empty",
         "The effective Normal-pages Footer contains no text or supported field",
         "Text or a supported field in each section's Normal-pages Footer definition"),
        ("PAGE_NUMBER_FIELD_REQUIRED", "either", "missing",
         "No supported PAGE field found in the selected Normal-pages definition(s)",
         "A PAGE field in each section's Normal-pages Header or Footer definition"),
        ("PAGE_NUMBER_FIELD_REQUIRED", "header", "missing",
         "No supported PAGE field found in the selected Normal-pages definition(s)",
         "A PAGE field in each section's Normal-pages Header definition"),
        ("PAGE_NUMBER_FIELD_REQUIRED", "footer", "missing",
         "No supported PAGE field found in the selected Normal-pages definition(s)",
         "A PAGE field in each section's Normal-pages Footer definition"),
        ("HEADER_CONTENT_REQUIRED", "header", "unresolved",
         "Supported structural evidence is insufficient to determine this requirement.",
         "Text or a supported field in each section's Normal-pages Header definition"),
        ("FOOTER_CONTENT_REQUIRED", "footer", "unresolved",
         "Supported structural evidence is insufficient to determine this requirement.",
         "Text or a supported field in each section's Normal-pages Footer definition"),
        ("PAGE_NUMBER_FIELD_REQUIRED", "either", "unresolved",
         "Supported structural evidence is insufficient to determine this requirement.",
         "A PAGE field in each section's Normal-pages Header or Footer definition"),
    ],
)
def test_structural_reviews_export_friendly_details_without_changing_saved_values(
    client, test_engine, monkeypatch, code, kind, state, current, required,
):
    """Display saved structural outcomes plainly without rerunning or rewriting them."""
    from app.services import page_element_rules
    from app.services.pdf_report import required_action, _friendly_required_action

    def no_reaudit(*args, **kwargs):
        raise AssertionError("History/PDF must not rerun structural rules")

    monkeypatch.setattr(page_element_rules, "check_page_element_requirements", no_reaudit)
    label = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}[kind]
    target = f"Section 2 · {label} · Normal pages"
    if state == "unresolved":
        action = (f"In Word, inspect {target} against your Custom Profile; "
                  "ACA cannot determine this requirement from supported structure.")
    else:
        change = ("insert a PAGE field if needed" if code == "PAGE_NUMBER_FIELD_REQUIRED"
                  else "add the required content if needed")
        action = (f"In Word, review {target} against your Custom Profile and {change}. "
                  "Verify the rendered document manually.")
    finding = dict(
        rule_code=code, severity="REVIEW",
        location=dict(structural_story=True, section_index=1, story_type=kind,
                      story_variant="default", evidence_state=state),
        message=action, expected_value=required, actual_value=current,
    )
    audit_id = _seed_audit(test_engine, weighted_score=100, violations=[finding],
                           paragraph_page_mapping={"0": 7}, rendered_preview_pages=8)
    before = client.get(f"/api/audit/{audit_id}").json()
    response = _export(client, audit_id)
    assert response.status_code == 200
    text = _pdf_text(response.content)
    title = {
        "HEADER_CONTENT_REQUIRED": "Header needs review",
        "FOOTER_CONTENT_REQUIRED": "Footer needs review",
        "PAGE_NUMBER_FIELD_REQUIRED": "Page number needs review",
    }[code]
    assert title in text
    assert target in text
    assert "Structural evidence only: Rendered page could not be determined" in text
    assert "no exact header/footer highlight" in text.lower()
    displayed_action = f"In Word, check this section’s {label.lower()}"
    if state != "unresolved":
        change = ("insert a page-number field if needed" if code == "PAGE_NUMBER_FIELD_REQUIRED"
                  else "add text or a supported field if needed")
        displayed_action += f" and {change}"
    displayed_action += ". Verify the rendered document manually."
    assert current not in text
    assert required not in text
    assert action not in text
    assert "Manual Review Findings" in text
    assert "These findings require manual review and do not affect the score." in text
    assert "1 deterministic finding(s): 0 major" in text
    assert "0 minor" in text
    assert "1 for manual review (never scored)" in text
    assert code not in text
    assert "Figure" not in text
    assert "Starting original document page" not in text
    saved = SimpleNamespace(**finding)
    assert required_action(saved) == displayed_action
    assert _friendly_required_action(saved, target, None) == displayed_action
    assert client.get(f"/api/audit/{audit_id}").json() == before


def test_structural_locations_with_incomplete_section_evidence_do_not_guess_pages(monkeypatch):
    from app.services import pdf_report

    def no_body_mapping(*args, **kwargs):
        raise AssertionError("Stored stories do not have physical body-page locations")

    monkeypatch.setattr(pdf_report, "_pages_for_section", no_body_mapping)
    monkeypatch.setattr(pdf_report, "_page_for_paragraph", no_body_mapping)
    audit = SimpleNamespace(
        paragraph_page_mapping={"0": 7}, rendered_preview_pages=8,
        section_metadata=[{"section_index": 0}],
    )
    for kind, label in (("header", "Header"), ("footer", "Footer"), ("either", "Header or Footer")):
        loc = dict(structural_story=True, section_index=0, story_type=kind,
                   story_variant="default", evidence_state="missing")
        target = f"Section 1 · {label} · Normal pages"
        assert pdf_report.location_text(loc) == target
        assert pdf_report.friendly_location_text(loc) == target
        assert pdf_report.page_label_for_location(
            loc, audit.paragraph_page_mapping, section_metadata=audit.section_metadata,
            rendered_pages=8,
        ) == ("Structural evidence only", "Rendered page could not be determined")
        assert pdf_report._pages_summary_for_group([SimpleNamespace(location=loc)], audit) == ("", 1)


def test_structural_review_sections_remain_individual_in_mixed_review_report(client, test_engine):
    findings = []
    for index in (0, 1):
        findings.append(dict(
            rule_code="HEADER_CONTENT_REQUIRED", severity="REVIEW",
            location=dict(structural_story=True, section_index=index, story_type="header",
                          story_variant="default", evidence_state="missing"),
            message=(f"In Word, review Section {index + 1} · Header · Normal pages against your "
                     "Custom Profile and add the required content if needed. "
                     "Verify the rendered document manually."),
            actual_value="No effective Normal-pages Header definition",
            expected_value="Text or a supported field in each section's Normal-pages Header definition",
        ))
    findings.append(dict(
        rule_code="CITATION_REFERENCE_AMBIGUOUS", severity="REVIEW",
        location={"paragraph_index": 0}, message="Citation could match multiple entries.",
        actual_value="Smith (2024)", expected_value="One unambiguous matching entry",
    ))
    audit_id = _seed_audit(test_engine, weighted_score=100, violations=findings)
    text = _pdf_text(_export(client, audit_id).content)
    for index in (1, 2):
        assert f"Section {index} · Header · Normal pages" in text
    assert "Citation could match more than one entry" in text
    assert "3 for manual review (never scored)" in text
    assert "Grouped Minor Findings" not in text


@pytest.mark.parametrize("placement", ["header", "footer", "either"])
def test_pdf_discloses_only_saved_structural_settings(client, test_engine, monkeypatch, placement):
    from app.services.profile_snapshot import EffectiveProfileSnapshot
    from app.services import profile_snapshot

    def no_profile_resolution(*args, **kwargs):
        raise AssertionError("History/PDF must use the stored snapshot")

    monkeypatch.setattr(profile_snapshot, "resolve_snapshot", no_profile_resolution)

    snapshot = EffectiveProfileSnapshot(
        schema_version=6, profile_id="saved-structural", profile_name="Saved structural profile",
        profile_source="custom", header_check_requirements=True,
        footer_check_requirements=False, page_number_check_requirements=True,
        page_number_placement=placement,
    ).with_fingerprint().to_dict()
    audit_id = _seed_audit(test_engine, weighted_score=100, profile_snapshot=snapshot)
    before = client.get(f"/api/audit/{audit_id}").json()
    assert before["profile_snapshot"] == snapshot
    text = _pdf_text(_export(client, audit_id).content)
    label = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}[placement]
    assert "Formatting Profile: Saved structural profile" in text
    assert "Headers: Manual review only · Unscored" in text
    assert "Footers Not checked Disabled in this Profile" in text
    assert f"Page numbers: Manual review only · Unscored · Placement: {label}" in text
    assert "Checks stored Normal-pages definitions in every document section" in text
    assert "does not establish exact geometry or rendered visibility" in text
    assert "First-page and even-page definitions are not checked." in text
    assert "saved-structural" not in text
    assert snapshot["fingerprint"] not in text
    assert client.get(f"/api/audit/{audit_id}").json() == before


@pytest.mark.parametrize("version", [None, 1, 5, 6])
def test_pdf_missing_or_disabled_structural_settings_stay_not_checked(client, test_engine, version):
    from app.services.profile_snapshot import EffectiveProfileSnapshot

    snapshot = None if version is None else EffectiveProfileSnapshot(
        schema_version=version, profile_name="Saved older requirements",
    ).with_fingerprint().to_dict()
    audit_id = _seed_audit(test_engine, weighted_score=100, profile_snapshot=snapshot)
    text = _pdf_text(_export(client, audit_id).content)
    for label in ("Headers", "Footers", "Page numbers"):
        assert f"{label} Not checked Disabled in this Profile" in text
    assert "Headers: Manual review only" not in text
    assert "Footers: Manual review only" not in text
    assert "Page numbers: Manual review only" not in text
    assert "Normal-pages PAGE field · Placement:" not in text


@pytest.mark.parametrize(
    "mapping,blocks,sections,rendered_pages,expected_page",
    [
        ({"18": 3, "19": 4}, [{"index": 18, "text": "Section starts here"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, 3),
        ({"19": 4}, [{"index": 18, "text": "Unmapped section start"},
                     {"index": 19, "text": "Later mapped paragraph"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
        ({"18": 2, "19": 3}, [{"index": 18, "text": " "},
                              {"index": 19, "text": "Later visible text"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
        ({"18": 3}, None,
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
        (None, [{"index": 18, "text": "Section starts here"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
        ({"18": 3}, [{"index": 18, "text": "Section starts here"}], None, 8, None),
        ({"18": 9}, [{"index": 18, "text": "Section starts here"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
        ({"18": True}, [{"index": 18, "text": "Section starts here"}],
         [{"section_index": 2, "start_paragraph_index": 18, "end_paragraph_index": 22}], 8, None),
    ],
)
def test_structural_pdf_evidence_uses_only_proven_first_rendered_page(
    client, test_engine, mapping, blocks, sections, rendered_pages, expected_page,
):
    from app.services.pdf_report import page_label_for_location, _pages_summary_for_group

    location = dict(structural_story=True, section_index=2, story_type="footer",
                    story_variant="default", evidence_state="missing")
    finding = dict(
        rule_code="FOOTER_CONTENT_REQUIRED", severity="REVIEW", location=location,
        message="Saved protocol action must remain stored but not be displayed.",
        actual_value="No effective Normal-pages Footer definition",
        expected_value="Text or a supported field in each section's Normal-pages Footer definition",
    )
    audit_id = _seed_audit(
        test_engine, weighted_score=100, violations=[finding],
        paragraph_page_mapping=mapping, rendered_preview_pages=rendered_pages,
        section_metadata=sections, document_blocks=blocks,
    )
    before = client.get(f"/api/audit/{audit_id}").json()
    text = _pdf_text(_export(client, audit_id).content)
    assert "Footer needs review" in text
    assert "Section 3 · Footer · Normal pages" in text
    assert "no exact header/footer highlight" in text.lower()
    if expected_page is None:
        assert "Structural evidence only" in text
        assert "Rendered page could not be determined" in text
        assert "Page-level structural evidence" not in text
        expected_label = ("Structural evidence only", "Rendered page could not be determined")
    else:
        assert f"Original document page: {expected_page}" in text
        assert "Page-level structural evidence" in text
        assert "Rendered page could not be determined" not in text
        expected_label = ("Original document page", str(expected_page))
    assert page_label_for_location(
        location, mapping, blocks, sections, rendered_pages,
    ) == expected_label
    compact, unavailable = _pages_summary_for_group(
        [SimpleNamespace(location=location)],
        SimpleNamespace(paragraph_page_mapping=mapping, rendered_preview_pages=rendered_pages,
                        section_metadata=sections, document_blocks=blocks),
    )
    assert (compact, unavailable) == (("", 1) if expected_page is None else (str(expected_page), 0))
    assert "1 for manual review (never scored)" in text
    assert "0 major" in text
    assert "0 minor" in text
    assert "100/100" in text
    assert "Exact evidence" not in text
    assert "Saved protocol action" not in text
    assert "FOOTER_CONTENT_REQUIRED" not in text
    assert client.get(f"/api/audit/{audit_id}").json() == before


def test_pdf_profile_summary_groups_only_immutable_saved_checks(client, test_engine, monkeypatch):
    from app.services import profile_snapshot
    from app.services.profile_snapshot import EffectiveProfileSnapshot

    def no_resolution(*args, **kwargs):
        raise AssertionError("PDF disclosure cannot consult the mutable current profile")

    monkeypatch.setattr(profile_snapshot, "resolve_snapshot", no_resolution)
    snapshot = EffectiveProfileSnapshot(
        profile_id="do-not-display-internal-id", profile_name="Saved requirements",
        profile_source="custom", body_font_family="Arial", body_font_size_pt=11,
        body_line_spacing=1.5, heading_font_family="Arial",
        heading_level_1={"bold": True, "italic": False},
        margin_right_in=1.25, references_check_reference_order=True,
        references_check_doi_format=False, header_check_requirements=True,
        footer_check_requirements=True, page_number_check_requirements=True,
        page_number_placement="footer",
    ).with_fingerprint().to_dict()
    audit_id = _seed_audit(test_engine, weighted_score=100, profile_snapshot=snapshot)
    before = client.get(f"/api/audit/{audit_id}").json()
    text = _pdf_text(_export(client, audit_id).content)
    assert "Body font: Arial" in text
    assert "Body font size: 11 pt" in text
    assert "Body line spacing: 1.5" in text
    assert "Right margin: 1.25 in" in text
    assert "Alphabetical order" in text
    for label in ("Headers", "Footers", "Page numbers"):
        assert f"{label}: Manual review only · Unscored" in text
        assert f"{label}: Not checked" not in text
    assert "Placement: Footer" in text
    assert "Ambiguous citation matches" in text
    assert "Citations have references" in text
    assert "Reference DOI format" in text
    assert "https://doi.org/" not in text
    assert "Heading 1 bold: Yes (stored setting; not checked)" in text
    assert "Heading 1 italic: No (stored setting; not checked)" in text
    assert "Citation style APA 7" in text
    assert snapshot["profile_id"] not in text
    assert snapshot["fingerprint"] not in text
    assert client.get(f"/api/audit/{audit_id}").json() == before


def test_saved_coverage_distinguishes_historical_off_from_unknown():
    from app.services.pdf_report import _coverage_rows
    unknown = list(_coverage_rows(None))
    for area, status, _, impact in unknown:
        assert (status, impact) == (
            ("Not checked", "None") if area in ("Headers", "Footers", "Page numbers")
            else ("Not checked", "N/A")
        )
    historical = {row[0]: row for row in _coverage_rows({"body": {"font_size_pt": 11}})}
    assert historical["Body text"][1] == "Scored"
    for area in ("Headers", "Footers", "Page numbers"):
        assert historical[area][1] == "Not checked"
        assert historical[area][3] == "None"
    stored = {"page_numbers": {"check_page_number_requirements": True, "placement": "header"}}
    page_numbers = {row[0]: row for row in _coverage_rows(stored)}["Page numbers"]
    assert page_numbers[1] == "Manual review"
    assert "Placement: Header" in page_numbers[2]
    assert page_numbers[3] == "None"
    empty = {row[0]: row for row in _coverage_rows({
        "body": {"font_size_pt": None, "allowed_font_combos": []},
        "heading": {"font_family": None, "allowed_font_combos": [], "level_1": {"bold": True}},
    })}
    for area in ("Body text", "Headings"):
        assert empty[area][1] == "Not checked"
        assert empty[area][2] == "Disabled in this Profile"
    assert empty["References"][2] == "Requirements not recorded"


def test_priority_actions_preserve_saved_order_and_cap_without_mutating():
    from app.services.pdf_report import _priority_findings
    findings = [SimpleNamespace(severity=severity, marker=index, location={"paragraph_index": index})
                for index, severity in enumerate(
        ("MINOR", "REVIEW", "MAJOR", "MINOR", "REVIEW", "MINOR", "UNRECOGNISED")
    )]
    assert [v.marker for v in _priority_findings(findings)] == [2, 1, 4]
    assert [v.marker for v in findings] == list(range(7))
    earliest = [
        SimpleNamespace(severity="MINOR", location={"paragraph_index": index})
        for index in (20, 2, 10, 0)
    ]
    assert _priority_findings(earliest) == []


def test_structural_review_pdf_explains_field_and_geometry_limits(client, test_engine):
    audit_id = _seed_audit(test_engine, weighted_score=100, violations=[{
        "rule_code": "PAGE_NUMBER_FIELD_REQUIRED", "severity": "REVIEW",
        "location": {"structural_story": True, "section_index": 0,
                     "story_type": "footer", "evidence_state": "missing"},
        "message": "internal structural message", "actual_value": "internal value",
        "expected_value": "internal expectation",
    }])
    text = _pdf_text(_export(client, audit_id).content)
    assert "Manual review · Unscored" in text
    assert "Found No page-number field was found" in text
    assert "Expected A page-number field" in text
    assert "Action Review the footer in Word; insert an automatic page number if required." in text
    assert "Evidence Structural evidence only" in text
    assert "no exact Header/Footer highlight" in text
    assert "A PAGE field is not a typed number" in text
    assert "internal structural message" not in text
    assert "internal expectation" not in text


def test_long_manual_evidence_exports_without_losing_saved_content(client, test_engine):
    evidence = "Saved ambiguous-citation evidence. " * 150 + "Complete evidence end marker."
    audit_id = _seed_audit(test_engine, weighted_score=100, violations=[{
        "rule_code": "CITATION_REFERENCE_AMBIGUOUS", "severity": "REVIEW",
        "location": {"paragraph_index": 2}, "message": evidence,
        "actual_value": "Smith (2024)", "expected_value": "One unambiguous matching entry",
    }])
    before = client.get(f"/api/audit/{audit_id}").json()
    response = _export(client, audit_id)
    assert response.status_code == 200
    text = _pdf_text(response.content)
    assert "Manual Review Findings" in text
    assert "Manual Review Register" in text
    assert "Complete evidence end marker." in text
    assert "Smith (2024)" in text
    assert "One unambiguous matching entry" in text
    assert client.get(f"/api/audit/{audit_id}").json() == before
