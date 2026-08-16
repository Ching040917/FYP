"""Focused tests for the PDF export endpoint (Phase 1, backend only).

Covers: PDF header/content-type/filename, core sections, 404/409 behavior,
historical NULL stats, long-text wrapping, markup safety, Unicode
punctuation, AI-unavailable export, absence of document blocks, and
non-mutation of persisted results.
"""
import io
import uuid

from sqlalchemy.orm import sessionmaker

from app.models.audit import AuditRecord, Violation, CitationIssue
from app.services.ai_citation import build_apa_suggestion


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _post_audit(client, docx_factory, name="report.docx", paragraphs=None, **docx_kw):
    if paragraphs is None:
        paragraphs = ["Body paragraph."]
    resp = client.post(
        "/api/audit",
        files={"file": (name, docx_factory(paragraphs=paragraphs, **docx_kw), "application/octet-stream")},
    )
    assert resp.status_code == 200
    return resp.json()["audit_id"]


def _export(client, audit_id):
    return client.get(f"/api/audit/{audit_id}/export-pdf")


def _pdf_text(pdf_bytes):
    from pypdf import PdfReader
    return "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)


def _seed_audit(test_engine, status="completed", violations=(), citations=(), **fields):
    """Insert an audit record directly (bypasses POST) for status edge cases."""
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit_id = fields.pop("id", str(uuid.uuid4()))
    rec = AuditRecord(
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
        "Category Breakdown",
        "Priority Findings",
        "Document Statistics",
        "Scope, Limitations and Privacy",
        "Required Action",
        "Deployment Mode",
        "Page Margins",
        "MARGIN_LEFT",
        "HEADING_HIERARCHY",
    ):
        assert section in text, f"missing section: {section}"


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
        violations=[{"rule_code": "FONT_CONSISTENCY", "severity": "MINOR",
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
        violations=[{"rule_code": "FONT_SIZE", "severity": "MINOR",
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
        violations=[{"rule_code": "ALIGNMENT", "severity": "MINOR",
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
    assert "UNAVAILABLE" in _pdf_text(resp.content)


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
    # Group panel: G### id + friendly rule name + severity/count header
    assert "G001" in text
    assert "Font Consistency" in text
    assert "Minor · 10 finding(s)" in text
    # Appendix is a compact register (not verbose Finding N tables)
    assert "Appendix" in text
    assert "Findings Register" in text
    assert "F001" in text
    assert "F010" in text
    # All 10 findings present exactly once in appendix (secondary rule code per row)
    assert text.count("FONT_CONSISTENCY") >= 10


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
    # Each major finding gets its own table with "Finding N" header
    assert "Finding 1" in text
    assert "Finding 2" in text


def test_specific_action_when_values_exist(client, test_engine):
    """When expected/actual values exist, action should be specific."""
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=85,
        violations=[{"rule_code": "SPACE_BEFORE", "severity": "MINOR",
                     "location": {"paragraph_index": 18},
                     "message": "Space before 18pt != required 0pt",
                     "expected_value": "0pt", "actual_value": "18pt"}],
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Change space before for Paragraph 19 from 18pt to 0pt." in text


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


def test_space_before_separate_groups_by_expected_value(client, test_engine):
    """SPACE_BEFORE with 0pt and 12pt expectations must be separate groups."""
    violations = (
        [
            {"rule_code": "SPACE_BEFORE", "severity": "MINOR",
             "location": {"paragraph_index": i},
             "message": f"Space before {i}pt != required 0pt",
             "expected_value": "0pt", "actual_value": f"{i}pt"}
            for i in (2, 6, 18)
        ]
        + [
            {"rule_code": "SPACE_BEFORE", "severity": "MINOR",
             "location": {"paragraph_index": 40 + i},
             "message": f"Space before {6+i}pt != required 12pt",
             "expected_value": "12pt", "actual_value": f"{6+i}pt"}
            for i in range(3)
        ]
    )
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=80,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    # Two distinct groups, each with correct friendly-name header
    assert "G001" in text
    assert "G002" in text
    assert text.count("Space Before") >= 8  # 2 group headers + 6 appendix rows
    # Each group shows its own required value in the comparison row
    assert "Required" in text
    assert "0pt" in text
    assert "12pt" in text
    # Appendix has all 6 findings (secondary rule code per row)
    assert text.count("SPACE_BEFORE") >= 6


def test_consistent_id_format_in_pdf(client, test_engine):
    """P### for major, G### for minor groups/singletons, F### for appendix."""
    violations = [
        {"rule_code": "MARGIN_LEFT", "severity": "MAJOR",
         "location": {"section_index": 0}, "message": "Wrong margin",
         "expected_value": "1.5in", "actual_value": "1.0in"},
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": 0}, "message": "Wrong size",
         "expected_value": "12pt", "actual_value": "14pt"},
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": 1}, "message": "Wrong size",
         "expected_value": "12pt", "actual_value": "11pt"},
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=80,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "P001" in text       # first major
    assert "G001" in text      # FONT_SIZE group (same rule+expected, 2 findings)
    assert "F001" in text      # appendix entry for MARGIN_LEFT
    assert "F002" in text      # appendix entry for FONT_SIZE para 1
    assert "F003" in text      # appendix entry for FONT_SIZE para 2


def test_appendix_is_compact_table(client, test_engine):
    """Appendix must be a table (ID/Severity/Rule/Location/Actual/Expected), not full finding blocks."""
    violations = [
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": i}, "message": f"Font size wrong {i}",
         "expected_value": "12pt", "actual_value": f"{10+i}pt"}
        for i in range(5)
    ]
    audit_id = _seed_audit(
        test_engine, status="completed", weighted_score=80,
        violations=violations,
    )
    text = _pdf_text(_export(client, audit_id).content)
    assert "Findings Register" in text
    # Compact columns present
    assert "Friendly Rule" in text
    assert "ID" in text
    assert "Severity" in text
    assert "Actual" in text
    assert "Expected" in text
    # No verbose "Finding N" header rows in appendix
    assert text.count("Finding ") == 0


def test_group_panel_structure(client, test_engine):
    """Minor groups render as info panels: header, comparison, locations, action."""
    violations = [
        {"rule_code": "LINE_SPACING", "severity": "MINOR",
         "location": {"paragraph_index": i}, "message": "Spacing wrong",
         "expected_value": "1.5", "actual_value": "1.0"}
        for i in range(3)
    ]
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=80,
                           violations=violations)
    text = _pdf_text(_export(client, audit_id).content)
    assert "G001" in text
    assert "Line Spacing" in text
    assert "Minor · 3 finding(s)" in text
    assert "Required" in text
    assert "Observed" in text
    assert "Affected Locations" in text
    assert "Required Action" in text


def test_consecutive_paragraph_locations_compacted_into_ranges(client, test_engine):
    """Consecutive paragraphs collapse to a range; run indexes are preserved."""
    violations = [
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": i, "run_index": i * 2},
         "message": "Wrong size", "expected_value": "12pt", "actual_value": "14pt"}
        for i in range(5)
    ]
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=80,
                           violations=violations)
    text = _pdf_text(_export(client, audit_id).content)
    assert "Paragraphs 1-5 (Run 1, Run 3, Run 5, Run 7, Run 9)" in text


def test_appendix_lands_on_new_landscape_page_split_by_severity(client, test_engine):
    """Appendix starts on a fresh landscape page, Major then Minor sections."""
    violations = [
        {"rule_code": "MARGIN_LEFT", "severity": "MAJOR",
         "location": {"section_index": 0}, "message": "Wrong margin",
         "expected_value": "1.5in", "actual_value": "1.0in"},
    ] + [
        {"rule_code": "FONT_SIZE", "severity": "MINOR",
         "location": {"paragraph_index": i}, "message": "Wrong size",
         "expected_value": "12pt", "actual_value": "14pt"}
        for i in range(3)
    ]
    audit_id = _seed_audit(test_engine, status="completed", weighted_score=75,
                           violations=violations)
    resp = _export(client, audit_id)
    assert resp.status_code == 200
    from pypdf import PdfReader
    pages = PdfReader(io.BytesIO(resp.content)).pages
    assert len(pages) >= 2
    last = pages[-1]
    assert last.mediabox.width > last.mediabox.height  # landscape appendix page
    text = _pdf_text(resp.content)
    assert "Major Findings" in text
    assert "Minor Findings" in text
    assert "Friendly Rule" in text


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
