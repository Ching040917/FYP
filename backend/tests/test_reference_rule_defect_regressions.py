"""Regression tests for the three confirmed deterministic-audit defects.

Each test names the defect it pins and the exact behaviour that changed:

  Defect 1 — REFERENCE_HANGING_INDENT was not emitted consistently for
             ordinary zero-indent Reference entries (a style level declaring
             only a left indent `break`-ed the indent resolution, leaving the
             first-line half unresolved).
  Defect 2 — REFERENCE_SECTION_NEW_PAGE could be suppressed when the
             preceding-body scan was aborted by an index-less paragraph.
  Defect 3 — the References heading received the ordinary Heading 1
             font-size / typography rules and produced a spurious MAJOR
             FONT_SIZE finding.

These run through the real formatting-evidence module, the real rule module,
and the real static engine — no direct stubs.
"""

import io
import os

import pytest
from docx import Document
from docx.shared import Inches, Pt

from app.services.document_parser import extract_paragraphs
from app.services.formatting_evidence import (
    SOURCE_DIRECT,
    SOURCE_EFFECTIVE_DEFAULT,
    SOURCE_PARAGRAPH_STYLE,
    SOURCE_STYLE_CHAIN,
    SOURCE_UNRESOLVED,
    resolve_indentation,
)
from app.services.layout_engine import run_static_rules_engine
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_registry import SUC_PROFILE_ID, get_builtin_profile
from app.services.profile_schema import new_custom_profile
from app.services.profile_snapshot import resolve_snapshot
from app.services.reference_rules import run_reference_rules
from app.services.reference_section import (
    PAGE_START_EXPLICIT_NEW_PAGE,
    PAGE_START_MAPPED_NEW_PAGE,
    PAGE_START_MAPPED_SAME_PAGE,
    PAGE_START_UNAVAILABLE,
    PAGE_START_UNCERTAIN,
    classify_reference_page_start,
    reference_section_bounds,
)

ENTRY = "Garcia, R. (2018). Adaptive compliance in practice. Journal of Tests, 4(2), 11-20."


# --- helpers ----------------------------------------------------------------


def _bytes(doc) -> bytes:
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _objects(data: bytes):
    return {i: p for i, p in enumerate(Document(io.BytesIO(data)).paragraphs)}


def _profile(**refs) -> EffectiveProfileConfig:
    profile = new_custom_profile("Regression Profile", base=get_builtin_profile(SUC_PROFILE_ID))
    for name, value in refs.items():
        setattr(profile.references, name, value)
    return EffectiveProfileConfig(resolve_snapshot(profile))


def _run_rules(data: bytes, config, page_mapping=None):
    doc = Document(io.BytesIO(data))
    return run_reference_rules(doc, extract_paragraphs(doc), config, page_mapping=page_mapping)


def _by_code(violations, code):
    return [v for v in violations if v.rule_code == code]


def _entry_doc(*, style=None, left=None, first=None, heading="References"):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph(heading)
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    if style is not None:
        p.style = doc.styles[style]
    if left is not None:
        p.paragraph_format.left_indent = Inches(left)
    if first is not None:
        p.paragraph_format.first_line_indent = Inches(first)
    return _bytes(doc)


# ===========================================================================
# Defect 1 — hanging indent (15 tests)
# ===========================================================================


def test_d1_plain_zero_indent_entry_reports_effective_zero():
    """Case A: no indent stated anywhere → 0 in, honest effective_default."""
    data = _entry_doc()
    evidence = resolve_indentation(_objects(data)[2])
    assert evidence.hanging_indent_in == pytest.approx(0.0)
    assert evidence.source == SOURCE_EFFECTIVE_DEFAULT


def test_d1_plain_zero_indent_entry_emits_the_finding():
    """Case A/B: 0 in → 0.5 in is a real MINOR finding."""
    violations = _run_rules(
        _entry_doc(), _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0in"
    assert matches[0].expected_value == "0.5in"
    assert matches[0].severity == "MINOR"


def test_d1_effective_zero_source_is_never_labelled_direct():
    """Honest provenance: the document declared nothing."""
    evidence = resolve_indentation(_objects(_entry_doc())[2])
    assert evidence.source != SOURCE_DIRECT
    assert evidence.source != SOURCE_PARAGRAPH_STYLE


def test_d1_direct_hanging_indent_passes_silently():
    """Case: direct 0.5 in hanging matches the requirement."""
    assert _by_code(
        _run_rules(
            _entry_doc(left=0.5, first=-0.5),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_style_inherited_hanging_indent_passes_silently():
    """Case C: the value lives on the paragraph style."""
    doc = Document()
    normal = doc.styles["Normal"]
    normal.paragraph_format.left_indent = Inches(0.5)
    normal.paragraph_format.first_line_indent = Inches(-0.5)
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    doc.add_paragraph(ENTRY)
    assert _by_code(
        _run_rules(
            _bytes(doc),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_left_only_style_no_longer_hides_a_deeper_hanging_indent():
    """The Defect 1 root cause: a style that declares only `left` must not
    abort resolution of the first-line half declared on its BASE style."""
    doc = Document()
    base = doc.styles.add_style("BaseRef", 1)
    base.paragraph_format.left_indent = Inches(0.5)
    base.paragraph_format.first_line_indent = Inches(-0.5)
    child = doc.styles.add_style("ChildRef", 1)
    child.base_style = base
    child.paragraph_format.left_indent = Inches(0.5)  # left only — no first line
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    doc.add_paragraph(ENTRY, style="ChildRef")

    evidence = resolve_indentation(_objects(_bytes(doc))[2])
    assert evidence.hanging_indent_in == pytest.approx(0.5)
    assert evidence.source == SOURCE_PARAGRAPH_STYLE
    assert evidence.first_line_indent_in == pytest.approx(-0.5)


def test_d1_left_only_style_with_no_hanging_anywhere_stays_silent():
    """Case H: a plain left indent is NOT a hanging indent."""
    assert _by_code(
        _run_rules(
            _entry_doc(left=0.5),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_builtin_list_paragraph_style_does_not_error():
    """The built-in `List Paragraph` style declares only `w:left` — the exact
    shape whose naive `break` caused the original inconsistency. Resolution
    must stay well-defined and never raise."""
    data = _entry_doc(style="List Paragraph")
    evidence = resolve_indentation(_objects(data)[2])
    assert evidence.left_indent_in == pytest.approx(0.5)
    # No first-line value is stated anywhere, so hanging is genuinely unstated.
    assert evidence.hanging_indent_in is None
    assert _by_code(
        _run_rules(data, _profile(check_hanging_indent=True, hanging_indent_in=0.5)),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_wrong_distance_reports_the_observed_value():
    """Case D: 0.25 in → 0.25 in vs 0.5 in."""
    violations = _run_rules(
        _entry_doc(left=0.25, first=-0.25),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0.25in"
    assert matches[0].expected_value == "0.5in"


def test_d1_tolerance_is_inclusive_at_the_boundary():
    """Exactly 0.05 in from the requirement passes; one step beyond fails."""
    assert _by_code(
        _run_rules(
            _entry_doc(left=0.55, first=-0.55),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []
    assert len(_by_code(
        _run_rules(
            _entry_doc(left=0.56, first=-0.56),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    )) == 1


def test_d1_positive_first_line_is_not_a_hanging_indent():
    """Case G: a positive first-line indent is never reported as hanging."""
    evidence = resolve_indentation(_objects(_entry_doc(first=0.5))[2])
    assert evidence.hanging_indent_in is None
    assert _by_code(
        _run_rules(
            _entry_doc(first=0.5),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_explicit_zero_first_line_is_a_real_zero():
    """A stated 0.0 first line is 0 — it is compared truthfully."""
    violations = _run_rules(
        _entry_doc(left=0.0, first=0.0),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0in"


def test_d1_numbered_entry_stays_conservative():
    """Numbered entries take their indent from the list definition — no claim."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    p = doc.add_paragraph(ENTRY)
    pPr = p._p.get_or_add_pPr()
    numPr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl"); ilvl.set(qn("w:val"), "0")
    numId = OxmlElement("w:numId"); numId.set(qn("w:val"), "1")
    numPr.append(ilvl); numPr.append(numId); pPr.append(numPr)
    assert _by_code(
        _run_rules(
            _bytes(doc),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_d1_unreadable_styles_part_stays_unresolved():
    """Case F: conflicting/unsupported inheritance is never asserted."""
    class _BrokenPart:
        @property
        def rels(self):
            raise RuntimeError("styles part unreadable")

    class _BrokenParagraph:
        paragraph_format = type("fmt", (), {"left_indent": None, "first_line_indent": None})()
        part = _BrokenPart()

        @property
        def style(self):
            raise RuntimeError("styles part unreadable")

    evidence = resolve_indentation(_BrokenParagraph(), is_numbered=False)
    assert evidence.source == SOURCE_UNRESOLVED
    assert evidence.hanging_indent_in is None


def test_d1_repeated_zero_entries_consolidate_into_one_finding():
    """Consolidation: one finding, truthful count, first entry as primary."""
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for _ in range(4):
        doc.add_paragraph(ENTRY)
    violations = _run_rules(
        _bytes(doc), _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    location = matches[0].location
    assert location["occurrences"] == 4
    assert location["paragraph_index"] == 2
    assert location["paragraph_indexes"] == [2, 3, 4, 5]


def test_d1_style_chain_source_is_reported_for_deep_inheritance():
    """Provenance stays honest across the base-style chain."""
    doc = Document()
    normal = doc.styles["Normal"]
    normal.paragraph_format.left_indent = Inches(0.25)
    normal.paragraph_format.first_line_indent = Inches(-0.25)
    ref_style = doc.styles.add_style("RefEntry", 1)
    ref_style.base_style = normal
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    doc.add_paragraph(ENTRY, style="RefEntry")
    evidence = resolve_indentation(_objects(_bytes(doc))[2])
    assert evidence.hanging_indent_in == pytest.approx(0.25)
    assert evidence.source == SOURCE_STYLE_CHAIN


# ===========================================================================
# Defect 2 — Reference new-page detection (11 tests)
# ===========================================================================


def _paras(*texts):
    return [{"index": i, "text": t} for i, t in enumerate(texts)]


def test_d2_integer_mapping_keys_prove_a_same_page_start():
    evidence = classify_reference_page_start(
        _paras("Body content here.", "References", ENTRY), 1,
        page_mapping={0: 1, 1: 1},
    )
    assert evidence.state == PAGE_START_MAPPED_SAME_PAGE


def test_d2_string_mapping_keys_prove_a_same_page_start():
    """Production mappings are persisted through JSON → string keys."""
    evidence = classify_reference_page_start(
        _paras("Body content here.", "References", ENTRY), 1,
        page_mapping={"0": 1, "1": 1},
    )
    assert evidence.state == PAGE_START_MAPPED_SAME_PAGE


def test_d2_later_page_is_a_pass_not_a_violation():
    evidence = classify_reference_page_start(
        _paras("Body content here.", "References", ENTRY), 1,
        page_mapping={0: 1, 1: 2},
    )
    assert evidence.state == PAGE_START_MAPPED_NEW_PAGE


def test_d2_explicit_break_outranks_a_contradictory_mapping():
    from docx.enum.text import WD_BREAK

    doc = Document()
    doc.add_paragraph("Body cites (Garcia, 2018).")
    h = doc.add_paragraph()
    h.add_run().add_break(WD_BREAK.PAGE)
    h.add_run("References")
    doc.add_paragraph(ENTRY)
    data = _bytes(doc)
    doc2 = Document(io.BytesIO(data))
    paragraphs = extract_paragraphs(doc2)
    bounds = reference_section_bounds(paragraphs)
    evidence = classify_reference_page_start(
        paragraphs, bounds.heading_index,
        page_mapping={i: 1 for i in range(len(paragraphs))},
        paragraph_objs={i: p for i, p in enumerate(doc2.paragraphs)},
    )
    assert evidence.state == PAGE_START_EXPLICIT_NEW_PAGE


def test_d2_page_break_before_outranks_a_contradictory_mapping():
    doc = Document()
    doc.add_paragraph("Body cites (Garcia, 2018).")
    h = doc.add_paragraph("References")
    h.paragraph_format.page_break_before = True
    doc.add_paragraph(ENTRY)
    data = _bytes(doc)
    doc2 = Document(io.BytesIO(data))
    paragraphs = extract_paragraphs(doc2)
    bounds = reference_section_bounds(paragraphs)
    evidence = classify_reference_page_start(
        paragraphs, bounds.heading_index,
        page_mapping={i: 1 for i in range(len(paragraphs))},
        paragraph_objs={i: p for i, p in enumerate(doc2.paragraphs)},
    )
    assert evidence.state == PAGE_START_EXPLICIT_NEW_PAGE


def test_d2_missing_mapping_is_unavailable_not_a_violation():
    evidence = classify_reference_page_start(
        _paras("Body content here.", "References", ENTRY), 1,
    )
    assert evidence.state == PAGE_START_UNAVAILABLE


def test_d2_partial_mapping_is_uncertain():
    """Knowing only the heading's page proves nothing."""
    evidence = classify_reference_page_start(
        _paras("Body content here.", "References", ENTRY), 1,
        page_mapping={1: 1},
    )
    assert evidence.state == PAGE_START_UNCERTAIN


def test_d2_index_less_paragraph_does_not_suppress_a_proven_start():
    """The Defect 2 root cause: an index-less paragraph earlier in the list
    must not abort the previous-body scan and hide a same-page start."""
    paragraphs = [
        {"index": None, "text": "stray"},
        {"index": 0, "text": "Body one."},
        {"index": 1, "text": "References"},
        {"index": 2, "text": ENTRY},
    ]
    evidence = classify_reference_page_start(paragraphs, 1, page_mapping={0: 1, 1: 1})
    assert evidence.state == PAGE_START_MAPPED_SAME_PAGE
    assert evidence.previous_body_index == 0


def test_d2_last_content_paragraph_before_the_heading_is_selected():
    """A blank separator line before the heading must not become the
    'previous body paragraph'."""
    paragraphs = [
        {"index": 0, "text": "Body one."},
        {"index": 1, "text": "   "},
        {"index": 2, "text": "References"},
        {"index": 3, "text": ENTRY},
    ]
    evidence = classify_reference_page_start(paragraphs, 2, page_mapping={0: 1, 2: 1})
    assert evidence.previous_body_index == 0
    assert evidence.state == PAGE_START_MAPPED_SAME_PAGE


def test_d2_rule_emits_one_heading_anchored_finding():
    data = _bytes(_doc_with_heading_and_entries())
    violations = _run_rules(
        data, _profile(check_start_on_new_page=True), page_mapping={0: 1, 1: 1, 2: 1},
    )
    matches = _by_code(violations, "REFERENCE_SECTION_NEW_PAGE")
    assert len(matches) == 1
    assert matches[0].severity == "MINOR"
    assert matches[0].location == {"paragraph_index": 1}


def test_d2_rule_is_silent_for_a_natural_later_page():
    data = _bytes(_doc_with_heading_and_entries())
    assert _by_code(
        _run_rules(
            data, _profile(check_start_on_new_page=True), page_mapping={0: 1, 1: 2, 2: 2},
        ),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []


def _doc_with_heading_and_entries():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    doc.add_paragraph(ENTRY)
    return doc


# ===========================================================================
# Defect 3 — Reference-heading role gating (6 tests)
# ===========================================================================


def _heading_role_config(**refs):
    return _profile(**refs)


def _doc_with_reference_heading(size_pt=12.0, entries=(ENTRY,)):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph()
    run = heading.add_run("References")
    run.font.name = "Times New Roman"
    run.font.size = Pt(size_pt)
    for text in entries:
        p = doc.add_paragraph(text)
        for r in p.runs:
            r.font.name = "Times New Roman"
            r.font.size = Pt(12.0)
    return doc


def test_d3_references_heading_gets_no_generic_heading_font_size():
    """The reported defect: no MAJOR FONT_SIZE against the References heading."""
    data = _bytes(_doc_with_reference_heading())
    violations = run_static_rules_engine(data, config=_heading_role_config())
    for v in violations:
        if v.rule_code == "FONT_SIZE":
            assert v.location["paragraph_index"] != 1


def test_d3_ordinary_heading_font_size_is_still_reported():
    """The gate must not disable genuine Heading 1 findings."""
    doc = Document()
    doc.add_paragraph("Body prose that is long enough to be classified as body text.")
    h = doc.add_paragraph("1. Introduction")
    h.style = doc.styles["Heading 1"]
    for r in h.runs:
        r.font.name = "Times New Roman"
        r.font.size = Pt(12.0)
    violations = run_static_rules_engine(_bytes(doc), config=_heading_role_config())
    assert any(
        v.rule_code == "FONT_SIZE" and v.location["paragraph_index"] == 1
        for v in violations
    )


def test_d3_reference_heading_text_rule_still_fires():
    data = _entry_doc(heading="Bibliography")
    violations = _run_rules(
        data, _profile(check_heading_text=True, heading_text="references"),
        page_mapping={0: 1, 1: 1, 2: 1},
    )
    assert len(_by_code(violations, "REFERENCE_HEADING_TEXT")) == 1


def test_d3_reference_heading_bold_rule_still_fires():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph()
    heading.add_run("References").font.bold = False
    doc.add_paragraph(ENTRY)
    violations = _run_rules(_bytes(doc), _profile(check_heading_bold=True))
    assert len(_by_code(violations, "REFERENCE_HEADING_BOLD")) == 1


def test_d3_reference_heading_alignment_rule_still_fires():
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph("References")
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_paragraph(ENTRY)
    violations = _run_rules(
        _bytes(doc), _profile(check_heading_alignment=True, heading_alignment="left"),
    )
    assert len(_by_code(violations, "REFERENCE_HEADING_ALIGNMENT")) == 1


def test_d3_reference_heading_new_page_rule_still_fires():
    data = _bytes(_doc_with_heading_and_entries())
    violations = _run_rules(
        data, _profile(check_start_on_new_page=True),
        page_mapping={0: 1, 1: 1, 2: 1},
    )
    assert len(_by_code(violations, "REFERENCE_SECTION_NEW_PAGE")) == 1
