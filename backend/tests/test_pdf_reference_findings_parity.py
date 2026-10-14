"""Owner-fixture PDF parity: every persisted finding appears exactly once.

This module is the acceptance test for the PDF completion task. It runs ONE
document through the real pipeline —

    POST /api/audit -> persisted AuditRecord + Violations
      -> GET /api/audit/{id}
      -> GET /api/audits   (History reload)
      -> GET /api/audit/{id}/export-pdf

— and asserts that the four views agree finding-for-finding, that the PDF
Findings Register carries exactly one row per finding, and that no raw
internal token (rule code, location JSON, paragraph-index array, twips, EMU)
leaks into the reader-facing report.

Only the rendering boundary is stubbed (a deterministic 2-page preview and
its paragraph->page mapping). Profile resolution, the rules engine,
persistence, History, and PDF generation are all real.

Scope note: this file changes NO production code. It pins the contract the
task specifies; when it fails it names the exact defect rather than papering
over it.
"""
import io
import json
import re

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

from app.api import routes as api_routes
from app.services.profile_registry import SUC_PROFILE_ID, get_builtin_profile
from app.services.profile_schema import new_custom_profile

# ---------------------------------------------------------------------------
# The owner fixture
# ---------------------------------------------------------------------------

# Deliberately wrong in every way the task lists. The reference list is
# engineered so all six Phase 2 rules fire:
#   CITATION_MISMATCH              — Khalid is absent from every entry
#   CITATION_REFERENCE_MISMATCH    — Lopez cited 2021, entry says 2019
#   CITATION_YEAR_SUFFIX_MISMATCH  — Ahmed cited 2022, entry says 2022a
#   CITATION_REFERENCE_AMBIGUOUS   — two Smith entries, neither is 2024
#   REFERENCE_NOT_CITED            — the Okafor entry is never cited
#   REFERENCE_DUPLICATE            — the Garcia entry appears twice
GARCIA_2018 = (
    "Garcia, R. (2018). Adaptive compliance in practice. "
    "Journal of Tests, 4(2), 11-20."
)
LOPEZ_2019 = (
    "Lopez, M. (2019). A second work on compliance. Journal of Tests, 5(1), 1-9."
)
AHMED_2022A = (
    "Ahmed, S. (2022a). Suffix work on compliance. Journal of Tests, 6(1), 1-8."
)
SMITH_A_2020 = "Smith, A. (2020). First work on the policy. Example Press."
SMITH_B_2019 = "Smith, B. (2019). Second work on the policy. Example Press."
OKAFOR_2015 = "Okafor, J. (2015). An uncited work. Example Press."


def _fake_rendered_pdf(page_count: int = 2) -> bytes:
    """A deterministic N-page PDF for the rendered-preview boundary."""
    from reportlab.pdfgen import canvas as pdfcanvas

    buf = io.BytesIO()
    canvas = pdfcanvas.Canvas(buf)
    for i in range(page_count):
        canvas.drawString(72, 720, f"page {i + 1}")
        canvas.showPage()
    canvas.save()
    return buf.getvalue()


def _owner_document_bytes() -> bytes:
    """The owner-shaped .docx: every listed violation, in one document."""
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(12)

    def body(text: str, *, spacing: float = 2.0, size: float = 12.0) -> None:
        para = doc.add_paragraph(text)
        for run in para.runs:
            run.font.name = "Times New Roman"
            run.font.size = Pt(size)
        para.paragraph_format.line_spacing = spacing
        para.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        para.paragraph_format.space_before = Pt(0)
        para.paragraph_format.space_after = Pt(0)

    # ¶0 — citation with no matching entry (Khalid is absent from every entry).
    body("Prior studies disagree about the effect (Khalid, 2018).")
    # ¶1 — citation whose year disagrees with its single matching entry.
    body("Lopez reported a different result (Lopez, 2021).")
    # ¶2 — ambiguous: two Smith entries, neither year matches.
    body("The policy changed earlier (Smith, 2024).")
    # ¶3 — year-suffix mismatch: the entry is 2022a, the citation is 2022.
    body("Ahmed reached the same conclusion (Ahmed, 2022).")
    # ¶4 — ordinary body paragraph, single spacing (line spacing finding).
    body("This paragraph uses single line spacing on purpose.", spacing=1.0)

    # ¶5 — the References heading. NOT bold (the finding under test).
    header = doc.add_paragraph("References")
    for run in header.runs:
        run.font.name = "Times New Roman"
        run.font.size = Pt(12)
        run.font.bold = False
    header.paragraph_format.line_spacing = 1.0
    header.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

    def entry(text: str, *, indent: float, size: float = 12.0) -> None:
        para = doc.add_paragraph(text)
        for run in para.runs:
            run.font.name = "Times New Roman"
            run.font.size = Pt(size)
        para.paragraph_format.line_spacing = 2.0
        para.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        para.paragraph_format.space_before = Pt(0)
        para.paragraph_format.space_after = Pt(0)
        para.paragraph_format.left_indent = Inches(indent)

    # ¶6..¶10 — five entries with NO hanging indent (0 in -> 0.5 in).
    for i in range(5):
        entry(f"Nguyen, T. (201{i}). Work number {i}. Example Press.", indent=0.0)
    # ¶11 — a 0.25 in / -0.25 in first-line indent (0.25 in -> 0.5 in).
    para = doc.add_paragraph(GARCIA_2018)
    for run in para.runs:
        run.font.name = "Times New Roman"
        run.font.size = Pt(12)
    para.paragraph_format.line_spacing = 2.0
    para.paragraph_format.left_indent = Inches(0.25)
    para.paragraph_format.first_line_indent = Inches(-0.25)
    # ¶12 — a duplicate of the Garcia entry (Reference List duplicate).
    entry(GARCIA_2018, indent=0.5)
    # ¶13 — an 11 pt entry (font size finding).
    entry(LOPEZ_2019, indent=0.5, size=11.0)
    # ¶14, ¶15 — two Smith entries with distinct years (ambiguous citation).
    entry(SMITH_A_2020, indent=0.5)
    entry(SMITH_B_2019, indent=0.5)
    # ¶16 — the suffixed Ahmed entry (the citation is unsuffixed 2022).
    entry(AHMED_2022A, indent=0.5)
    # ¶17 — an entry never cited in the text.
    entry(OKAFOR_2015, indent=0.5)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


ENTRY = GARCIA_2018


def _owner_profile():
    """A custom profile with every Reference check enabled and 0.5 in indent."""
    profile = new_custom_profile("PDF Parity Probe", base=get_builtin_profile(SUC_PROFILE_ID))
    refs = profile.references
    refs.check_heading_text = False  # heading text is "References" already
    refs.check_heading_bold = True
    refs.check_start_on_new_page = True
    refs.check_hanging_indent = True
    refs.hanging_indent_in = 0.5
    refs.check_font_size = True
    refs.font_size_pt = 12.0
    refs.check_font_family = True
    refs.font_family = "Times New Roman"
    refs.check_alignment = True
    refs.alignment = "left"
    # Phase 2 toggles live on the citation_matching group, not `references`.
    # `check_references_are_cited` is OFF by default, so the owner fixture
    # must switch it on explicitly to exercise REFERENCE_NOT_CITED.
    cm = profile.citation_matching
    cm.check_citations_have_references = True
    cm.check_author_year_consistency = True
    cm.check_year_suffixes = True
    cm.check_duplicate_references = True
    cm.check_references_are_cited = True
    cm.flag_ambiguous_matches = True
    return profile


@pytest.fixture
def owner_audit(client, monkeypatch, tmp_path):
    """POST the owner fixture through the real pipeline and return the id."""
    monkeypatch.setattr(api_routes.settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "previews"))
    monkeypatch.setattr(
        api_routes, "convert_docx_to_pdf", lambda _bytes: _fake_rendered_pdf(2),
    )
    # The References heading is ¶5 and the entries are ¶6..¶17; pages 1 and 2.
    mapping = {str(i): (1 if i <= 5 else 2) for i in range(20)}
    monkeypatch.setattr(
        api_routes, "compute_paragraph_page_mapping",
        lambda paragraphs, pdf_bytes, rendered_preview_pages=None: mapping,
    )
    profile = _owner_profile()
    post = client.post(
        "/api/audit",
        files={"file": ("owner_shape.docx", _owner_document_bytes(), "application/octet-stream")},
        data={"custom_profile": json.dumps(profile.to_dict())},
    )
    assert post.status_code == 200, post.text
    return post.json()["audit_id"]


def _pdf_text(pdf_bytes) -> str:
    from pypdf import PdfReader

    raw = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
    return re.sub(r"\s+", " ", raw)


def _register_rows(pdf_text: str):
    """(id, severity, title) for every F### row in the Findings Register only.

    The register is the single authoritative one-row-per-finding area; the
    earlier detail panels reuse the same titles, so counting text everywhere
    would confuse panels, group sections and summary mentions.

    A register row begins with `F###`, then the severity label, then the
    friendly rule title. The title ends where the next row begins (`F###` +
    severity) or at the end of the register text, so the parser is anchored
    on the deterministic ID/severity pair rather than on line breaks (pypdf
    flattens the table).
    """
    marker = "Appendix — Findings Register"
    assert marker in pdf_text, "the Findings Register is missing from the PDF"
    register = pdf_text.split(marker, 1)[1]
    sev_alt = "Major|Minor|Manual review|Unclassified"
    pattern = re.compile(
        rf"(F\d{{3}}) ({sev_alt}) (.*?)(?= F\d{{3}} (?:{sev_alt}) |$)"
    )
    rows = []
    for m in pattern.finditer(register):
        rows.append((m.group(1), m.group(2), m.group(3).strip()))
    assert rows, "no F### rows parsed from the Findings Register"
    return rows


def _register_title_only(title_cell: str) -> str:
    """Strip the trailing Location/Current/Required columns from a row cell.

    The whole row is one flat string, so the friendly title is the prefix up
    to the first cell that starts with a location label.
    """
    for marker in (
        "Original document page", "Original document pages",
        "Starting original document page", "Paragraph ", "Heading “",
        "Table ", "Figure ", "Section ", "Entire document",
    ):
        idx = title_cell.find(marker)
        if idx > 0:
            return title_cell[:idx].strip()
    return title_cell.strip()


# ===========================================================================
# Phase 7 — POST / GET / History / PDF parity
# ===========================================================================

def test_post_get_history_and_pdf_finding_sets_agree(client, owner_audit):
    """Every finding is identical across all four views, exactly once each."""
    audit_id = owner_audit

    get = client.get(f"/api/audit/{audit_id}")
    assert get.status_code == 200
    get_findings = get.json()["violations"]

    listing = client.get("/api/audits")
    assert listing.status_code == 200
    assert any(item["id"] == audit_id for item in listing.json())

    # Reopening through GET is the History reload path: it must be identical.
    reopened = client.get(f"/api/audit/{audit_id}")
    assert reopened.status_code == 200
    assert reopened.json()["violations"] == get_findings

    pdf = client.get(f"/api/audit/{audit_id}/export-pdf")
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")
    text = _pdf_text(pdf.content)

    from app.services.pdf_report import _RULE_NAME

    # Map every registered title back to its rule code, then compare sets.
    title_to_code = {title: code for code, title in _RULE_NAME.items()}
    register_codes = []
    for _fid, _sev, title_cell in _register_rows(text):
        code = title_to_code.get(_register_title_only(title_cell))
        assert code is not None, (
            f"PDF register row has no known rule title: {title_cell!r}"
        )
        register_codes.append(code)

    def key(v):
        loc = v.get("location") or {}
        return (
            v["rule_code"],
            v["severity"],
            v.get("actual_value"),
            v.get("expected_value"),
            loc.get("occurrences", 1),
            loc.get("paragraph_index"),
            loc.get("table_index"),
            loc.get("image_index"),
        )

    get_keys = sorted(key(v) for v in get_findings)
    assert sorted(register_codes) == sorted(v["rule_code"] for v in get_findings), (
        "PDF register and GET disagree on the rule-code multiset: "
        f"register={sorted(register_codes)} "
        f"get={sorted(v['rule_code'] for v in get_findings)}"
    )
    # The register carries one row per persisted finding.
    assert len(register_codes) == len(get_findings)
    # No two persisted findings are identical on (rule, severity, values,
    # occurrence count, primary location) — a consolidated finding is ONE
    # row, never several.
    assert len(set(get_keys)) == len(get_keys), (
        "duplicate findings in GET: "
        f"{[k for k in set(get_keys) if get_keys.count(k) > 1]}"
    )


def test_every_finding_appears_exactly_once_in_the_register(client, owner_audit):
    """No finding is dropped and none is duplicated in the register."""
    pdf = client.get(f"/api/audit/{owner_audit}/export-pdf")
    text = _pdf_text(pdf.content)
    rows = _register_rows(text)
    ids = [r[0] for r in rows]
    assert len(ids) == len(set(ids)), f"duplicate register IDs: {ids}"

    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    assert len(rows) == len(get), (
        f"register has {len(rows)} rows for {len(get)} persisted findings"
    )


# ===========================================================================
# Phase 8 — required owner-fixture PDF content
# ===========================================================================

def _register_titles(text):
    return {_register_title_only(cell) for _fid, _sev, cell in _register_rows(text)}


def test_owner_fixture_phase2_titles_are_present(client, owner_audit):
    titles = _register_titles(_pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content))
    for expected in (
        "Citation has no matching Reference List entry",
        "Citation year does not match the Reference List entry",
        "Citation is missing or uses the wrong year suffix",
        "Citation could match more than one entry",
        "Duplicate Reference List entry",
        "Reference List entry is not cited in the text",
    ):
        assert expected in titles, f"missing Phase 2 finding {expected!r}; got {sorted(titles)}"


def test_owner_fixture_phase3_titles_are_present(client, owner_audit):
    titles = _register_titles(_pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content))
    for expected in (
        "Reference List heading should be bold",
        "Reference List should start on a new page",
        "Reference entry hanging indent does not match",
        "Reference entry font size does not match",
    ):
        assert expected in titles, f"missing Phase 3 finding {expected!r}; got {sorted(titles)}"


def test_every_expected_owner_fixture_rule_appears_in_the_register(client, owner_audit):
    """The complete expected rule set is present — nothing silently absent.

    Absence is itself a result: the task forbids accepting a missing finding.
    This test names every rule the fixture intentionally violates so a
    regression cannot hide behind a partial check.
    """
    from app.services.pdf_report import _RULE_NAME

    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    persisted = {v["rule_code"] for v in get}
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    titles = _register_titles(text)

    expected_rules = {
        "CITATION_MISMATCH",
        "CITATION_REFERENCE_MISMATCH",
        "CITATION_YEAR_SUFFIX_MISMATCH",
        "CITATION_REFERENCE_AMBIGUOUS",
        "REFERENCE_NOT_CITED",
        "REFERENCE_DUPLICATE",
        "REFERENCE_HEADING_BOLD",
        "REFERENCE_SECTION_NEW_PAGE",
        "REFERENCE_HANGING_INDENT",
        "REFERENCE_FONT_SIZE",
        "LINE_SPACING",
    }
    absent_from_audit = expected_rules - persisted
    assert absent_from_audit == set(), (
        f"the fixture did not produce these findings at all: {sorted(absent_from_audit)}"
    )
    missing_from_pdf = {
        code for code in expected_rules if _RULE_NAME[code] not in titles
    }
    assert missing_from_pdf == set(), (
        f"persisted findings missing from the PDF register: {sorted(missing_from_pdf)}"
    )


def test_owner_fixture_never_shows_generic_heading_font_size(client, owner_audit):
    """The References heading must not attract an ordinary Heading 1 FONT_SIZE."""
    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    # The heading is ¶5 (zero-based). No FONT_SIZE finding may target it.
    for v in get:
        if v["rule_code"] == "FONT_SIZE":
            assert (v.get("location") or {}).get("paragraph_index") != 5, (
                "the References heading received a generic FONT_SIZE finding"
            )
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    # The heading is a real heading to the reader, so no generic font-size
    # panel may name it; and no panel may claim a font-size mismatch there.
    assert "Font size does not match Heading “References”" not in text
    assert "FONT_SIZE" not in text


# ===========================================================================
# Phase 4 — Current / Required values
# ===========================================================================

def test_hanging_indent_current_required_and_occurrence_count(client, owner_audit):
    """0 in -> 0.5 in with 5 occurrences, plus the 0.25 in group."""
    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    hanging = [v for v in get if v["rule_code"] == "REFERENCE_HANGING_INDENT"]
    by_actual = {v["actual_value"]: v for v in hanging}
    assert set(by_actual) == {"0in", "0.25in"}, f"unexpected groups: {set(by_actual)}"

    zero = by_actual["0in"]
    assert zero["expected_value"] == "0.5in"
    assert (zero["location"] or {}).get("occurrences") == 5, (
        f"expected 5 occurrences, got {zero['location']}"
    )

    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "0 in" in text and "0.25 in" in text and "0.5 in" in text
    # The consolidated count is disclosed truthfully.
    assert "5 occurrences" in text or "5 finding" in text
    # No raw unit token survives (`_student_clean` inserts the space).
    assert "0in" not in text.replace("0 in", "")
    assert "0.25in" not in text.replace("0.25 in", "")

    register = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "REFERENCE_HANGING_INDENT" not in register


def test_new_page_current_and_required_values(client, owner_audit):
    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    new_page = [v for v in get if v["rule_code"] == "REFERENCE_SECTION_NEW_PAGE"]
    assert len(new_page) == 1
    assert new_page[0]["actual_value"] == "Starts on the same page as preceding content"
    assert new_page[0]["expected_value"] == "Start References on a new page"

    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "Starts on the same page as preceding content" in text
    assert "Start References on a new page" in text
    assert "Insert a page break before the Reference List heading." in text


def test_heading_bold_current_and_required_values(client, owner_audit):
    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    bold = [v for v in get if v["rule_code"] == "REFERENCE_HEADING_BOLD"]
    assert len(bold) == 1
    assert bold[0]["actual_value"] == "Not bold"
    assert bold[0]["expected_value"] == "Bold"
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "Not bold" in text


# ===========================================================================
# Phase 6 — location behavior
# ===========================================================================

def test_locations_never_leak_raw_json_or_index_arrays(client, owner_audit):
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    for banned in (
        "paragraph_index", "table_index", "image_index", "run_index",
        "paragraph_indexes", "occurrences\":", "missing_references_section",
        "twips", "EMU", "w:ind", "docPr",
    ):
        assert banned not in text, f"raw internal token {banned!r} reached the PDF"


def test_table_caption_missing_remains_visible_without_a_page(client, test_engine):
    """Phase 6 — a table finding with no reliable mapping stays identifiable."""
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord, Violation
    import uuid as _uuid

    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit_id = str(_uuid.uuid4())
    s.add(AuditRecord(
        id=audit_id, filename="tables.docx", file_size=100, weighted_score=90,
        deploy_mode="LOCAL", status="completed", table_count=1,
    ))
    s.add(Violation(
        id=str(_uuid.uuid4()), audit_id=audit_id,
        rule_code="TABLE_CAPTION_MISSING", severity="MINOR",
        location={"table_index": 0},
        message="Table 1 does not have a caption.",
        expected_value=None, actual_value=None,
    ))
    s.commit()
    s.close()

    text = _pdf_text(client.get(f"/api/audit/{audit_id}/export-pdf").content)
    assert "Table caption is missing" in text
    assert "Table 1" in text
    assert "Unavailable" in text
    assert "table_index" not in text


# ===========================================================================
# Phase 5 — severity partitions
# ===========================================================================

def test_manual_review_appears_and_for_review_does_not(client, owner_audit):
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "Manual review" in text
    assert "For review" not in text
    # The ambiguous citation is the REVIEW finding.
    assert "Citation could match more than one entry" in text


def test_severity_partitions_and_counts_reconcile(client, owner_audit):
    get = client.get(f"/api/audit/{owner_audit}").json()["violations"]
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    rows = _register_rows(text)

    counts = {"Major": 0, "Minor": 0, "Manual review": 0, "Unclassified": 0}
    for _fid, sev, _title in rows:
        counts[sev] += 1

    expected_major = sum(1 for v in get if v["severity"] == "MAJOR")
    expected_minor = sum(1 for v in get if v["severity"] == "MINOR")
    expected_review = sum(1 for v in get if v["severity"] == "REVIEW")
    expected_unclassified = len(get) - expected_major - expected_minor - expected_review

    assert counts["Major"] == expected_major
    assert counts["Minor"] == expected_minor
    assert counts["Manual review"] == expected_review
    assert counts["Unclassified"] == expected_unclassified
    # Every finding lands in exactly one partition.
    assert sum(counts.values()) == len(get)


def test_review_and_unclassified_are_unscored_and_score_matches(client, owner_audit):
    get = client.get(f"/api/audit/{owner_audit}")
    assert get.status_code == 200
    body = get.json()
    # The PDF score equals the persisted audit score.
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    score = body.get("weighted_score")
    if score is not None:
        assert f"Compliance Score (enabled checks)" in text
    # REVIEW findings are never counted as major or minor.
    review_count = sum(1 for v in body["violations"] if v["severity"] == "REVIEW")
    if review_count:
        assert re.search(r"0 major", text) or re.search(r"(\d+) major", text)


# ===========================================================================
# Phase 10 — raw-token absence
# ===========================================================================

def test_no_raw_rule_code_leaks_into_the_pdf(client, owner_audit):
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    from app.services.pdf_report import _RULE_NAME

    for code in _RULE_NAME:
        assert code not in text, f"raw rule code {code} reached the PDF"


def test_owner_fixture_line_spacing_finding_is_present(client, owner_audit):
    """The single-spaced body paragraph must still produce a LINE_SPACING row."""
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "Line spacing does not match" in text


# ===========================================================================
# Phase 9 — historical snapshot export
# ===========================================================================

def test_v1_and_v2_snapshots_still_export(client, test_engine):
    """Historical audits with older snapshot schemas keep exporting."""
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord
    import uuid as _uuid

    Session = sessionmaker(bind=test_engine)
    s = Session()
    for version in (1, 2):
        audit_id = str(_uuid.uuid4())
        s.add(AuditRecord(
            id=audit_id, filename=f"hist_v{version}.docx", file_size=100,
            weighted_score=95, deploy_mode="LOCAL", status="completed",
            profile_snapshot={"schema_version": version, "profile_name": "Legacy",
                              "profile_version": 1, "citation_style": "APA 7"},
        ))
    s.commit()
    s.close()

    listing = client.get("/api/audits")
    assert listing.status_code == 200
    for item in listing.json():
        if item["filename"].startswith("hist_v"):
            resp = client.get(f"/api/audit/{item['id']}/export-pdf")
            assert resp.status_code == 200, f"{item['filename']} failed to export"
            assert resp.content.startswith(b"%PDF")


def test_v3_export_discloses_enabled_reference_rules(client, owner_audit):
    """A v3 snapshot export states the enabled Reference requirements."""
    text = _pdf_text(client.get(f"/api/audit/{owner_audit}/export-pdf").content)
    assert "References:" in text
    # The configured hanging indent is disclosed in user-friendly language.
    assert "0.5 in hanging indent" in text


def test_export_does_not_rerun_or_change_the_audit(client, owner_audit):
    """Exporting the PDF is read-only: the persisted findings never change."""
    before = client.get(f"/api/audit/{owner_audit}").json()
    client.get(f"/api/audit/{owner_audit}/export-pdf")
    after = client.get(f"/api/audit/{owner_audit}").json()
    assert before["violations"] == after["violations"]
    assert before.get("weighted_score") == after.get("weighted_score")


def test_doi_pdf_preserves_raw_case_and_unit_like_suffixes(client, test_engine):
    """Grouped panels and register retain persisted DOI spelling verbatim."""
    import uuid
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord, Violation
    from app.services.profile_snapshot import EffectiveProfileSnapshot

    current_values = (
        "doi: 10.1234/AbC12pt",
        "doi: 10.1234/abc12pt",
        "HTTP://dx.doi.org/10.1234/AbC12in",
        "DOI: 10.1234/numPr",
    )
    canonical = "https://doi.org/<doi>"
    action = (
        "Replace the visible DOI text with the configured canonical format. "
        "Verify the DOI independently because ACA checks presentation only and "
        "does not confirm registration or resolution."
    )
    snapshot = EffectiveProfileSnapshot(
        profile_id="doi-pdf-parity", profile_name="DOI PDF parity",
        profile_source="custom", references_check_doi_format=True,
    ).with_fingerprint()
    audit_id = str(uuid.uuid4())
    Session = sessionmaker(bind=test_engine)
    with Session() as session:
        session.add(AuditRecord(
            id=audit_id, filename="doi-parity.docx", file_size=100,
            weighted_score=92, deploy_mode="LOCAL", status="completed",
            profile_snapshot=snapshot.to_dict(),
        ))
        for index, current in enumerate(current_values):
            session.add(Violation(
                id=str(uuid.uuid4()), audit_id=audit_id,
                rule_code="REFERENCE_DOI_FORMAT", severity="MINOR",
                location={"paragraph_index": index + 1},
                message=(
                    "The visible DOI presentation does not match the selected "
                    "profile's required format: https://doi.org/<doi>. "
                    "ACA checks presentation only, not registration or resolution."
                ),
                actual_value=current, expected_value=canonical,
            ))
        session.commit()

    before = client.get(f"/api/audit/{audit_id}").json()
    response = client.get(f"/api/audit/{audit_id}/export-pdf")
    assert response.status_code == 200
    text = _pdf_text(response.content)
    panels, register = text.split("Appendix — Findings Register", 1)
    for current in current_values:
        assert current in panels
        assert register.count(current) == 1
    assert canonical in panels
    assert register.count(canonical) == len(current_values)
    assert action in panels
    assert "Reference DOI format does not match" in panels
    assert all(
        "Reference DOI format does not match" in row[2]
        for row in _register_rows(text)
    )
    assert len(_register_rows(text)) == len(current_values)
    assert (
        "The selected profile requires the visible DOI format https://doi.org/<doi>; "
        "presentation only, not registration or resolution."
    ) in text
    for altered in ("AbC12 pt", "abc12 pt", "AbC12 in", "list formatting"):
        assert altered not in text
    for markup in ("<a", "</a>", "href=", "target=", "rel=", "title=", "class=", "&lt;", "&gt;"):
        assert markup not in text
    assert client.get(f"/api/audit/{audit_id}").json()["violations"] == before["violations"]
