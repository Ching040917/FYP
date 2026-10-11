"""Reference List FORMATTING rules (Phase 3) — deterministic rule tests.

Covers every rule in `app/services/reference_rules.py`:

  * each of the ten rule codes fires on resolved evidence that contradicts
    the configured requirement;
  * each check is silent when its toggle is off, when its value is
    unconfigured, or when the evidence is unresolved/mixed/numbered;
  * entry findings are consolidated by (rule, current, required) with a
    truthful occurrence count and a capped index list;
  * messages carry the profile label and never leak low-level units,
    OOXML names or internal field names.

Plus the cross-module contracts the new rules depend on: scoring
classification, profile-schema validation, snapshot tri-state line spacing,
and the fixed PDF copy.
"""

import io

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

from app.services.document_parser import extract_paragraphs
from app.services.pdf_report import _REQUIRED_ACTIONS, _RULE_NAME
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_registry import SUC_PROFILE_ID, get_builtin_profile
from app.services.profile_schema import (
    DocumentFormattingProfile,
    ReferencesSettings,
    new_custom_profile,
)
from app.services.profile_snapshot import resolve_snapshot
from app.services.reference_rules import (
    MAX_LOCATION_INDEXES,
    run_reference_rules,
)
from app.services.scoring import rule_code_to_category
from tests import reference_structure_fixtures as fx

ENTRY = fx.REFERENCE_TEXT


# --- helpers ----------------------------------------------------------------


def _bytes(doc) -> bytes:
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _profile(**refs) -> EffectiveProfileConfig:
    """Effective rule config from a custom profile with only the Reference
    List settings overridden."""
    profile = new_custom_profile(
        "Reference Rule Tests", base=get_builtin_profile(SUC_PROFILE_ID),
    )
    for name, value in refs.items():
        setattr(profile.references, name, value)
    return EffectiveProfileConfig(resolve_snapshot(profile))


def _run(docx_bytes: bytes, config, page_mapping=None):
    doc = Document(io.BytesIO(docx_bytes))
    return run_reference_rules(
        doc, extract_paragraphs(doc), config, page_mapping=page_mapping,
    )


def _codes(violations):
    return [v.rule_code for v in violations]


def _by_code(violations, code):
    return [v for v in violations if v.rule_code == code]



# --- 1: no heading means no formatting findings -----------------------------


def test_no_reference_heading_emits_nothing_at_all():
    data = _bytes(_plain_docx([
        "This paragraph discusses prior work (Garcia, 2018).",
        ENTRY,
    ]))
    config = _profile(
        check_hanging_indent=True, hanging_indent_in=0.5,
        check_font_size=True, font_size_pt=12.0,
        check_alignment=True, alignment="left",
    )
    assert _run(data, config) == []


def test_missing_section_is_left_to_the_semantic_rules():
    """Phase 3 must not duplicate the Phase 2 root finding."""
    from app.services.citation_sensor import run_citation_sensor

    data = _bytes(_plain_docx([
        "This paragraph discusses prior work (Garcia, 2018).",
        ENTRY,
    ]))
    doc = Document(io.BytesIO(data))
    paragraphs = extract_paragraphs(doc)
    config = _profile(check_hanging_indent=True, hanging_indent_in=0.5)
    assert _run(data, config) == []
    semantic = run_citation_sensor(doc, paragraphs, config=config)
    assert _codes(semantic) == ["CITATION_MISMATCH"]


def _plain_docx(texts):
    doc = Document()
    for t in texts:
        doc.add_paragraph(t)
    return doc


# --- 2: REFERENCE_HEADING_TEXT ---------------------------------------------


def _heading_text_doc(heading: str):
    return _bytes(_plain_docx([
        "This paragraph discusses prior work (Garcia, 2018).",
        heading,
        ENTRY,
    ]))


def test_heading_text_rule_fires_on_a_non_matching_alias():
    violations = _run(
        _heading_text_doc("Bibliography"),
        _profile(check_heading_text=True, heading_text="references"),
    )
    matches = _by_code(violations, "REFERENCE_HEADING_TEXT")
    assert len(matches) == 1
    assert matches[0].severity == "MINOR"
    assert matches[0].actual_value == "Bibliography"
    assert matches[0].expected_value == "references"
    assert matches[0].location["paragraph_index"] == 1


def test_heading_text_rule_is_silent_on_the_required_wording():
    violations = _run(
        _heading_text_doc("References"),
        _profile(check_heading_text=True, heading_text="references"),
    )
    assert "REFERENCE_HEADING_TEXT" not in _codes(violations)


def test_heading_text_comparison_ignores_case_and_numeric_prefix():
    violations = _run(
        _heading_text_doc("6.1 REFERENCES"),
        _profile(check_heading_text=True, heading_text="references"),
    )
    assert "REFERENCE_HEADING_TEXT" not in _codes(violations)


def test_heading_text_rule_accepts_a_works_cited_heading_when_configured():
    violations = _run(
        _heading_text_doc("Works Cited"),
        _profile(check_heading_text=True, heading_text="works cited"),
    )
    assert "REFERENCE_HEADING_TEXT" not in _codes(violations)


def test_heading_aliases_toggle_permits_any_known_heading():
    """The document heading is "Bibliography" and the profile requires
    "references" — an exact mismatch, allowed only when aliases are on."""
    data = _heading_text_doc("Bibliography")
    assert _by_code(
        _run(data, _profile(check_heading_text=True, heading_text="references")),
        "REFERENCE_HEADING_TEXT",
    )
    assert _by_code(
        _run(data, _profile(
            check_heading_text=True, heading_text="references",
            allow_heading_aliases=True,
        )),
        "REFERENCE_HEADING_TEXT",
    ) == []


def test_heading_text_rule_is_silent_when_its_toggle_is_off():
    assert _by_code(
        _run(_heading_text_doc("Bibliography"), _profile(heading_text="references")),
        "REFERENCE_HEADING_TEXT",
    ) == []


def test_heading_text_rule_is_silent_without_a_required_word():
    """Toggle on, no word configured: nothing can be compared."""
    assert _by_code(
        _run(_heading_text_doc("Bibliography"), _profile(check_heading_text=True)),
        "REFERENCE_HEADING_TEXT",
    ) == []


def test_heading_text_message_names_the_profile():
    violation = _by_code(
        _run(
            _heading_text_doc("Bibliography"),
            _profile(check_heading_text=True, heading_text="references"),
        ),
        "REFERENCE_HEADING_TEXT",
    )[0]
    assert "Reference Rule Tests" in violation.message
    assert "Bibliography" in violation.message


# --- 3: REFERENCE_HEADING_BOLD ---------------------------------------------


def _bold_doc(*, run_bold=None, style_bold=None):
    doc = Document()
    if style_bold is not None:
        doc.styles["Normal"].font.bold = style_bold
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph()
    heading.add_run("References").font.bold = run_bold
    doc.add_paragraph(ENTRY)
    return _bytes(doc)


def test_heading_bold_rule_fires_on_definitely_not_bold():
    violations = _run(_bold_doc(run_bold=False), _profile(check_heading_bold=True))
    matches = _by_code(violations, "REFERENCE_HEADING_BOLD")
    assert len(matches) == 1
    assert matches[0].actual_value == "Not bold"
    assert matches[0].expected_value == "Bold"
    assert matches[0].severity == "MINOR"


def test_heading_bold_rule_honours_a_not_bold_requirement():
    violations = _run(
        _bold_doc(run_bold=True),
        _profile(check_heading_bold=True, heading_bold=False),
    )
    matches = _by_code(violations, "REFERENCE_HEADING_BOLD")
    assert matches and matches[0].actual_value == "Bold"
    assert matches[0].expected_value == "Not bold"


def test_heading_bold_rule_is_silent_when_the_heading_is_bold():
    assert _by_code(
        _run(_bold_doc(run_bold=True), _profile(check_heading_bold=True)),
        "REFERENCE_HEADING_BOLD",
    ) == []


def test_heading_bold_rule_accepts_bold_inherited_from_the_style():
    """No direct bold is not "not bold" — a style-bold heading is correct."""
    assert _by_code(
        _run(
            _bold_doc(run_bold=None, style_bold=True),
            _profile(check_heading_bold=True),
        ),
        "REFERENCE_HEADING_BOLD",
    ) == []


def test_heading_bold_rule_is_silent_for_mixed_runs():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph()
    heading.add_run("Ref").font.bold = True
    heading.add_run("erences")
    doc.add_paragraph(ENTRY)
    assert _by_code(
        _run(_bytes(doc), _profile(check_heading_bold=True)),
        "REFERENCE_HEADING_BOLD",
    ) == []


def test_heading_bold_rule_is_silent_when_its_toggle_is_off():
    assert _by_code(_run(_bold_doc(run_bold=False), _profile()), "REFERENCE_HEADING_BOLD") == []


# --- 4: REFERENCE_HEADING_ALIGNMENT ----------------------------------------


def _heading_align_doc(alignment):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph("References")
    heading.alignment = alignment
    doc.add_paragraph(ENTRY)
    return _bytes(doc)


def test_heading_alignment_rule_fires_on_a_resolved_mismatch():
    violations = _run(
        _heading_align_doc(WD_ALIGN_PARAGRAPH.CENTER),
        _profile(check_heading_alignment=True, heading_alignment="left"),
    )
    matches = _by_code(violations, "REFERENCE_HEADING_ALIGNMENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "Center"
    assert matches[0].expected_value == "Left"


def test_heading_alignment_rule_is_silent_when_it_matches():
    assert _by_code(
        _run(
            _heading_align_doc(WD_ALIGN_PARAGRAPH.LEFT),
            _profile(check_heading_alignment=True, heading_alignment="left"),
        ),
        "REFERENCE_HEADING_ALIGNMENT",
    ) == []


def test_heading_alignment_rule_is_silent_when_unresolved():
    """No alignment anywhere in the document says nothing about it."""
    assert _by_code(
        _run(
            _heading_align_doc(None),
            _profile(check_heading_alignment=True, heading_alignment="center"),
        ),
        "REFERENCE_HEADING_ALIGNMENT",
    ) == []


def test_heading_alignment_rule_is_silent_without_a_required_value():
    assert _by_code(
        _run(
            _heading_align_doc(WD_ALIGN_PARAGRAPH.CENTER),
            _profile(check_heading_alignment=True),
        ),
        "REFERENCE_HEADING_ALIGNMENT",
    ) == []


# --- 5: REFERENCE_SECTION_NEW_PAGE -----------------------------------------


def test_new_page_rule_fires_only_on_a_proven_same_page_start():
    data = _heading_text_doc("References")  # body at 0, heading at 1
    violations = _run(
        data,
        _profile(check_start_on_new_page=True),
        page_mapping={0: 1, 1: 1},
    )
    matches = _by_code(violations, "REFERENCE_SECTION_NEW_PAGE")
    assert len(matches) == 1
    assert matches[0].severity == "MINOR"
    assert matches[0].location["paragraph_index"] == 1


def test_new_page_rule_reads_the_stored_json_shaped_page_mapping():
    """Production mappings are JSON, so their keys are strings.

    The audit path persists `{paragraph_index: page}` through JSON, which
    turns every key into a string. A rule that looked the heading up by its
    integer index would silently see "no mapping" and never fire.
    """
    violations = _run(
        _heading_text_doc("References"),
        _profile(check_start_on_new_page=True),
        page_mapping={"0": 1, "1": 1},
    )
    assert len(_by_code(violations, "REFERENCE_SECTION_NEW_PAGE")) == 1

def test_new_page_rule_is_silent_when_the_heading_is_on_a_later_page():
    assert _by_code(
        _run(
            _heading_text_doc("References"),
            _profile(check_start_on_new_page=True),
            page_mapping={0: 1, 1: 2},
        ),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []


def test_new_page_rule_is_silent_without_a_page_mapping():
    assert _by_code(
        _run(_heading_text_doc("References"), _profile(check_start_on_new_page=True)),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []


def test_new_page_rule_is_silent_for_a_partial_mapping():
    """Knowing the heading's page but not its predecessor proves nothing."""
    assert _by_code(
        _run(
            _heading_text_doc("References"),
            _profile(check_start_on_new_page=True),
            page_mapping={1: 1},
        ),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []


@pytest.mark.parametrize("fixture", [
    fx.explicit_page_break_run_before_heading,
    fx.page_break_before_property,
])
def test_new_page_rule_is_silent_for_an_explicit_break(fixture):
    data = fixture()
    doc = Document(io.BytesIO(data))
    heading_index = extract_paragraphs(doc) and 0
    paragraphs = extract_paragraphs(doc)
    from app.services.reference_section import reference_section_bounds
    heading_index = reference_section_bounds(paragraphs).heading_index
    # Even a contradictory mapping cannot manufacture a same-page start.
    mapping = {i: 1 for i in range(len(paragraphs))}
    assert _by_code(
        _run(data, _profile(check_start_on_new_page=True), page_mapping=mapping),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []


def test_new_page_rule_is_silent_when_its_toggle_is_off():
    assert _by_code(
        _run(_heading_text_doc("References"), _profile(), page_mapping={0: 1, 1: 1}),
        "REFERENCE_SECTION_NEW_PAGE",
    ) == []



def _hanging_doc(*, left=None, first_line=None, count=1, numbered=False):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for _ in range(count):
        p = doc.add_paragraph()
        p.add_run(ENTRY)
        if left is not None:
            p.paragraph_format.left_indent = Inches(left)
        if first_line is not None:
            p.paragraph_format.first_line_indent = Inches(first_line)
    if numbered:
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        for p in doc.paragraphs[2:]:
            pPr = p._p.get_or_add_pPr()
            numPr = OxmlElement("w:numPr")
            ilvl = OxmlElement("w:ilvl")
            ilvl.set(qn("w:val"), "0")
            numId = OxmlElement("w:numId")
            numId.set(qn("w:val"), "1")
            numPr.append(ilvl)
            numPr.append(numId)
            pPr.append(numPr)
    return _bytes(doc)


def test_hanging_indent_rule_is_silent_on_a_matching_entry():
    assert _by_code(
        _run(
            _hanging_doc(left=0.5, first_line=-0.5),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_rule_fires_on_a_wrong_distance():
    violations = _run(
        _hanging_doc(left=1.0, first_line=-1.0),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "1in"
    assert matches[0].expected_value == "0.5in"
    assert matches[0].severity == "MINOR"
    assert matches[0].location["paragraph_index"] == 2


def test_hanging_indent_rule_tolerates_word_rounding():
    """A twentieth of an inch is below Word's own dialog rounding."""
    assert _by_code(
        _run(
            _hanging_doc(left=0.52, first_line=-0.52),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_rule_reports_a_first_line_indent_as_no_hanging_indent():
    """A positive first-line indent is NOT a hanging indent (case G)."""
    violations = _run(
        _hanging_doc(first_line=0.5),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    # The first line is pushed IN, so there is no hanging indent to compare —
    # the value is never asserted from a positive first line.
    assert matches == []


def test_hanging_indent_rule_reports_effective_zero_against_a_required_indent():
    """The owner's case: entries with no indentation at all (case B/D)."""
    violations = _run(
        _hanging_doc(),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0in"
    assert matches[0].expected_value == "0.5in"
    assert matches[0].severity == "MINOR"


def test_hanging_indent_rule_reports_a_zero_hanging_indent_stated_directly():
    """Case B: an explicit zero first-line indent is zero, not 'unstated'."""
    violations = _run(
        _hanging_doc(left=0.0, first_line=0.0),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0in"


def test_hanging_indent_rule_is_silent_on_a_left_indent_without_a_first_line():
    """Case H: a left indent is not a hanging indent, and is not overstated."""
    assert _by_code(
        _run(
            _hanging_doc(left=0.5),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_rule_skips_numbered_entries():
    """Numbered entries take their indent from the list definition."""
    assert _by_code(
        _run(
            _hanging_doc(numbered=True),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_rule_is_silent_without_a_configured_value():
    assert _by_code(
        _run(
            _hanging_doc(left=1.0, first_line=-1.0),
            _profile(check_hanging_indent=True),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_rule_is_silent_when_its_toggle_is_off():
    assert _by_code(
        _run(
            _hanging_doc(left=1.0, first_line=-1.0),
            _profile(hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    ) == []


def test_hanging_indent_values_are_reported_in_plain_inches():
    violation = _by_code(
        _run(
            _hanging_doc(left=1.0, first_line=-1.0),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    )[0]
    for token in ("twip", "EMU", "w:ind", "hanging="):
        assert token not in violation.message, token


# --- 7: REFERENCE_SPACE_BEFORE / SPACE_AFTER -------------------------------


def _spacing_doc(before_pt, after_pt):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    p.paragraph_format.space_before = Pt(before_pt)
    p.paragraph_format.space_after = Pt(after_pt)
    return _bytes(doc)


def test_space_before_rule_fires_on_a_mismatch():
    violations = _run(
        _spacing_doc(12.0, 0.0),
        _profile(check_space_before=True, space_before_pt=0.0),
    )
    matches = _by_code(violations, "REFERENCE_SPACE_BEFORE")
    assert len(matches) == 1
    assert matches[0].actual_value == "12pt"
    assert matches[0].expected_value == "0pt"
    assert matches[0].severity == "MINOR"


def test_space_after_rule_fires_on_a_mismatch():
    violations = _run(
        _spacing_doc(0.0, 12.0),
        _profile(check_space_after=True, space_after_pt=0.0),
    )
    matches = _by_code(violations, "REFERENCE_SPACE_AFTER")
    assert len(matches) == 1
    assert matches[0].actual_value == "12pt"
    assert matches[0].expected_value == "0pt"


def test_space_rules_are_silent_within_one_point_tolerance():
    assert _by_code(
        _run(
            _spacing_doc(0.8, 0.0),
            _profile(check_space_before=True, space_before_pt=0.0),
        ),
        "REFERENCE_SPACE_BEFORE",
    ) == []


def test_space_rules_are_independent_of_each_other():
    violations = _run(
        _spacing_doc(12.0, 0.0),
        _profile(check_space_after=True, space_after_pt=0.0),
    )
    assert "REFERENCE_SPACE_BEFORE" not in _codes(violations)


def test_space_rules_are_silent_when_their_toggle_is_off():
    assert _by_code(
        _run(_spacing_doc(12.0, 12.0), _profile(space_before_pt=0.0, space_after_pt=0.0)),
        "REFERENCE_SPACE_BEFORE",
    ) == []
    assert _by_code(
        _run(_spacing_doc(12.0, 12.0), _profile(space_before_pt=0.0, space_after_pt=0.0)),
        "REFERENCE_SPACE_AFTER",
    ) == []


def test_space_rules_are_silent_without_a_configured_value():
    assert _by_code(
        _run(_spacing_doc(12.0, 12.0), _profile(check_space_before=True)),
        "REFERENCE_SPACE_BEFORE",
    ) == []


def test_space_rules_ignore_unresolved_spacing():
    assert _by_code(
        _run(fx.no_explicit_indent(),
            _profile(check_space_before=True, space_before_pt=12.0)),
        "REFERENCE_SPACE_BEFORE",
    ) == []


# --- 8: REFERENCE_FONT_FAMILY / REFERENCE_FONT_SIZE ------------------------


def _font_doc(entries):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for runs in entries:
        p = doc.add_paragraph()
        for text, family, size in runs:
            run = p.add_run(text)
            run.font.name = family
            run.font.size = Pt(size)
    return _bytes(doc)


def test_font_family_rule_fires_on_a_mismatch():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). Title. Press.", "Arial", 12.0)]]),
        _profile(check_font_family=True, font_family="Times New Roman"),
    )
    matches = _by_code(violations, "REFERENCE_FONT_FAMILY")
    assert len(matches) == 1
    assert matches[0].actual_value == "Arial"
    assert matches[0].expected_value == "Times New Roman"


def test_font_family_matching_is_case_insensitive():
    assert _by_code(
        _run(
            _font_doc([[("Garcia, R. (2018). Title. Press.", "times new roman", 12.0)]]),
            _profile(check_font_family=True, font_family="Times New Roman"),
        ),
        "REFERENCE_FONT_FAMILY",
    ) == []


def test_mixed_font_family_is_reported_as_mixed():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). ", "Arial", 12.0),
                    ("Title. Press.", "Times New Roman", 12.0)]]),
        _profile(check_font_family=True, font_family="Times New Roman"),
    )
    matches = _by_code(violations, "REFERENCE_FONT_FAMILY")
    assert matches and matches[0].actual_value == "Mixed font families"


def test_font_size_rule_fires_on_a_mismatch():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). Title. Press.", "Times New Roman", 11.0)]]),
        _profile(check_font_size=True, font_size_pt=12.0),
    )
    matches = _by_code(violations, "REFERENCE_FONT_SIZE")
    assert len(matches) == 1
    assert matches[0].actual_value == "11pt"
    assert matches[0].expected_value == "12pt"


def test_font_size_rule_tolerates_half_a_point():
    assert _by_code(
        _run(
            _font_doc([[("Garcia, R. (2018). Title. Press.", "Times New Roman", 11.6)]]),
            _profile(check_font_size=True, font_size_pt=12.0),
        ),
        "REFERENCE_FONT_SIZE",
    ) == []


def test_mixed_font_size_is_reported_as_mixed():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). ", "Times New Roman", 12.0),
                    ("Title. Press.", "Times New Roman", 14.0)]]),
        _profile(check_font_size=True, font_size_pt=12.0),
    )
    matches = _by_code(violations, "REFERENCE_FONT_SIZE")
    assert matches and matches[0].actual_value == "Mixed font sizes"


def test_font_rules_are_independent_of_each_other():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). Title. Press.", "Arial", 12.0)]]),
        _profile(check_font_size=True, font_size_pt=12.0),
    )
    assert "REFERENCE_FONT_SIZE" not in _codes(violations)


def test_font_rules_are_silent_when_their_toggle_is_off():
    violations = _run(
        _font_doc([[("Garcia, R. (2018). Title. Press.", "Arial", 11.0)]]),
        _profile(font_family="Times New Roman", font_size_pt=12.0),
    )
    assert "REFERENCE_FONT_FAMILY" not in _codes(violations)
    assert "REFERENCE_FONT_SIZE" not in _codes(violations)


def test_font_family_rule_is_silent_without_a_configured_family():
    assert _by_code(
        _run(
            _font_doc([[("Garcia, R. (2018). Title. Press.", "Arial", 12.0)]]),
            _profile(check_font_family=True),
        ),
        "REFERENCE_FONT_FAMILY",
    ) == []


# --- 9: REFERENCE_ALIGNMENT ------------------------------------------------


def _entry_align_doc(alignment):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    p.alignment = alignment
    return _bytes(doc)


def test_entry_alignment_rule_fires_on_a_mismatch():
    violations = _run(
        _entry_align_doc(WD_ALIGN_PARAGRAPH.JUSTIFY),
        _profile(check_alignment=True, alignment="left"),
    )
    matches = _by_code(violations, "REFERENCE_ALIGNMENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "Justify"
    assert matches[0].expected_value == "Left"
    assert matches[0].location["paragraph_index"] == 2


def test_entry_alignment_rule_is_silent_when_it_matches():
    assert _by_code(
        _run(
            _entry_align_doc(WD_ALIGN_PARAGRAPH.LEFT),
            _profile(check_alignment=True, alignment="left"),
        ),
        "REFERENCE_ALIGNMENT",
    ) == []


def test_entry_alignment_rule_is_silent_when_unresolved():
    assert _by_code(
        _run(_entry_align_doc(None), _profile(check_alignment=True, alignment="center")),
        "REFERENCE_ALIGNMENT",
    ) == []


def test_entry_alignment_rule_is_silent_when_its_toggle_is_off():
    assert _by_code(
        _run(_entry_align_doc(WD_ALIGN_PARAGRAPH.JUSTIFY), _profile(alignment="left")),
        "REFERENCE_ALIGNMENT",
    ) == []


# --- 10: consolidation -----------------------------------------------------


def _many_wrong_entries(count):
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for _ in range(count):
        p = doc.add_paragraph()
        p.add_run(ENTRY)
        p.paragraph_format.left_indent = Inches(1.0)
        p.paragraph_format.first_line_indent = Inches(-1.0)
    return _bytes(doc)


def test_identically_wrong_entries_produce_one_finding():
    violations = _run(
        _many_wrong_entries(12),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    location = matches[0].location
    assert location["occurrences"] == 12
    # The count stays truthful even when the index list is capped.
    assert len(location["paragraph_indexes"]) == MAX_LOCATION_INDEXES
    assert location["paragraph_indexes"] == list(range(2, 12))
    assert location["paragraph_index"] == 2


def test_different_actual_values_are_not_merged_into_one_finding():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for left in (1.0, 0.75, 1.0):
        p = doc.add_paragraph()
        p.add_run(ENTRY)
        p.paragraph_format.left_indent = Inches(left)
        p.paragraph_format.first_line_indent = Inches(-left)
    violations = _run(
        _bytes(doc), _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 2
    assert sorted(m.location["occurrences"] for m in matches) == [1, 2]


def test_independent_rules_never_merge_with_each_other():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    p.paragraph_format.left_indent = Inches(1.0)
    p.paragraph_format.first_line_indent = Inches(-1.0)
    p.paragraph_format.space_before = Pt(12.0)
    violations = _run(
        _bytes(doc),
        _profile(
            check_hanging_indent=True, hanging_indent_in=0.5,
            check_space_before=True, space_before_pt=0.0,
        ),
    )
    assert sorted(_codes(violations)) == [
        "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
    ]


def test_heading_findings_never_carry_an_occurrence_count():
    """Heading rules are inherently single and anchor at the heading."""
    violation = _by_code(
        _run(
            _heading_text_doc("Bibliography"),
            _profile(check_heading_text=True, heading_text="references"),
        ),
        "REFERENCE_HEADING_TEXT",
    )[0]
    assert "occurrences" not in violation.location
    assert "paragraph_indexes" not in violation.location


def test_empty_paragraphs_between_entries_are_not_entries():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for _ in range(3):
        doc.add_paragraph()
        p = doc.add_paragraph()
        p.add_run(ENTRY)
        p.paragraph_format.left_indent = Inches(1.0)
        p.paragraph_format.first_line_indent = Inches(-1.0)
    violations = _run(
        _bytes(doc), _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].location["occurrences"] == 3
    assert matches[0].location["paragraph_indexes"] == [3, 5, 7]


def test_every_finding_is_minor_severity():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph("Bibliography")
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    heading.runs[0].font.bold = False
    p = doc.add_paragraph()
    run = p.add_run(ENTRY)
    run.font.name = "Arial"
    run.font.size = Pt(11.0)
    p.paragraph_format.left_indent = Inches(1.0)
    p.paragraph_format.first_line_indent = Inches(-1.0)
    p.paragraph_format.space_before = Pt(12.0)
    p.paragraph_format.space_after = Pt(12.0)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    violations = _run(
        _bytes(doc),
        _profile(
            check_heading_text=True, heading_text="references",
            check_heading_bold=True,
            check_heading_alignment=True, heading_alignment="left",
            check_start_on_new_page=True,
            check_hanging_indent=True, hanging_indent_in=0.5,
            check_space_before=True, space_before_pt=0.0,
            check_space_after=True, space_after_pt=0.0,
            check_font_family=True, font_family="Times New Roman",
            check_font_size=True, font_size_pt=12.0,
            check_alignment=True, alignment="left",
        ),
        page_mapping={0: 1, 1: 1},
    )
    assert set(_codes(violations)) == {
        "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
        "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
        "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
        "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
        "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
    }
    assert {v.severity for v in violations} == {"MINOR"}


def test_no_message_leaks_internal_names():
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    heading = doc.add_paragraph("Bibliography")
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    p.paragraph_format.left_indent = Inches(1.0)
    p.paragraph_format.first_line_indent = Inches(-1.0)
    p.paragraph_format.space_before = Pt(12.0)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    violations = _run(
        _bytes(doc),
        _profile(
            check_heading_text=True, heading_text="references",
            check_heading_alignment=True, heading_alignment="left",
            check_hanging_indent=True, hanging_indent_in=0.5,
            check_space_before=True, space_before_pt=0.0,
            check_alignment=True, alignment="left",
        ),
        page_mapping={0: 1, 1: 1},
    )
    forbidden = (
        "twip", "EMU", "w:ind", "w:pPr", "xml", "regex", "unresolved",
        "confidence", "REFERENCES_", "SOURCE_",
    )
    for violation in violations:
        blob = f"{violation.message} {violation.expected_value} {violation.actual_value}"
        for token in forbidden:
            assert token.lower() not in blob.lower(), (violation.rule_code, token)


def test_engine_integration_emits_the_reference_rules_through_the_config():
    """The full static engine reaches these rules with a snapshot config."""
    from app.services.layout_engine import run_static_rules_engine

    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    p = doc.add_paragraph()
    p.add_run(ENTRY)
    p.paragraph_format.left_indent = Inches(1.0)
    p.paragraph_format.first_line_indent = Inches(-1.0)
    violations = run_static_rules_engine(
        _bytes(doc), config=_profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    assert "REFERENCE_HANGING_INDENT" in _codes(violations)


def test_built_in_profiles_gain_no_rule_they_did_not_opt_into():
    """A built-in profile with a stored hanging indent may report exactly
    that — and nothing from the new checks, which all default to off."""
    from app.services.profile_registry import list_builtin_profiles
    data = _many_wrong_entries(3)
    for profile in list_builtin_profiles().values():
        config = EffectiveProfileConfig(resolve_snapshot(profile))
        emitted = set(_codes(_run(data, config)))
        assert emitted <= {"REFERENCE_HANGING_INDENT"}, profile.profile_id
        if "REFERENCE_HANGING_INDENT" in emitted:
            assert profile.references.check_hanging_indent is True
            assert profile.references.hanging_indent_in is not None


# --- 11: scoring classification -------------------------------------------


def test_reference_formatting_rules_score_against_their_own_category():
    expected = {
        "REFERENCE_HEADING_TEXT": "heading_hierarchy",
        "REFERENCE_HEADING_BOLD": "heading_hierarchy",
        "REFERENCE_HEADING_ALIGNMENT": "heading_hierarchy",
        "REFERENCE_SECTION_NEW_PAGE": "heading_hierarchy",
        "REFERENCE_HANGING_INDENT": "paragraph_typography",
        "REFERENCE_SPACE_BEFORE": "paragraph_typography",
        "REFERENCE_SPACE_AFTER": "paragraph_typography",
        "REFERENCE_ALIGNMENT": "paragraph_typography",
        "REFERENCE_FONT_FAMILY": "font_consistency",
        "REFERENCE_FONT_SIZE": "font_size",
    }
    for code, category in expected.items():
        assert rule_code_to_category(code) == category, code


def test_reference_semantic_rules_keep_the_citation_category():
    for code in ("REFERENCE_NOT_CITED", "REFERENCE_DUPLICATE",
                 "CITATION_REFERENCE_MISMATCH", "CITATION_MISMATCH"):
        assert rule_code_to_category(code) == "citation_apa", code


# --- Hanging-indent correction: value, tolerance, inheritance, persistence ---


def _hanging_doc_with_lefts(*lefts):
    """Entries whose hanging indent equals the given left indents."""
    doc = Document()
    doc.add_paragraph("This paragraph discusses prior work (Garcia, 2018).")
    doc.add_paragraph("References")
    for left in lefts:
        p = doc.add_paragraph()
        p.add_run(ENTRY)
        p.paragraph_format.left_indent = Inches(left)
        p.paragraph_format.first_line_indent = Inches(-left)
    return _bytes(doc)


def test_hanging_indent_rule_reports_the_actual_value_it_observed():
    """A 0.25 in hanging indent is reported as 0.25 in, not as 0."""
    violations = _run(
        _hanging_doc_with_lefts(0.25),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0.25in"
    assert matches[0].expected_value == "0.5in"


def test_hanging_indent_tolerance_boundary_is_inclusive():
    """Exactly at the 0.05 in tolerance passes; one step beyond it does not."""
    at_tolerance = _by_code(
        _run(
            _hanging_doc_with_lefts(0.55),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    )
    assert at_tolerance == []
    beyond_tolerance = _by_code(
        _run(
            _hanging_doc_with_lefts(0.56),
            _profile(check_hanging_indent=True, hanging_indent_in=0.5),
        ),
        "REFERENCE_HANGING_INDENT",
    )
    assert len(beyond_tolerance) == 1


def test_hanging_indent_inherited_from_a_style_matches_and_is_silent():
    """Case C: the value lives on the paragraph style, not the paragraph."""
    violations = _run(
        fx.style_inherited_hanging_indent(0.5),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    assert _by_code(violations, "REFERENCE_HANGING_INDENT") == []


def test_hanging_indent_inherited_from_a_style_is_reported_when_wrong():
    """Case D via the style chain: a style-set hanging value is compared too."""
    violations = _run(
        fx.base_style_inherited_hanging_indent(0.25),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].actual_value == "0.25in"


def test_unresolvable_indent_evidence_emits_no_finding():
    """Case F: an unreadable styles part stays unresolved, never asserted."""
    from app.services.formatting_evidence import resolve_indentation

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
    assert evidence.source == "unresolved"
    assert evidence.hanging_indent_in is None


def test_repeated_zero_indent_entries_consolidate_into_one_finding():
    """Case B at scale: every zero entry is one finding with a truthful count."""
    violations = _run(
        _hanging_doc(count=5),
        _profile(check_hanging_indent=True, hanging_indent_in=0.5),
    )
    matches = _by_code(violations, "REFERENCE_HANGING_INDENT")
    assert len(matches) == 1
    assert matches[0].location["occurrences"] == 5
    assert matches[0].location["paragraph_index"] == 2
    assert matches[0].location["paragraph_indexes"] == [2, 3, 4, 5, 6]


def test_snapshot_v3_preserves_the_hanging_indent_check_and_value():
    """Phase 4 case 15: the immutable snapshot carries both."""
    snapshot = _snapshot(ReferencesSettings(
        check_hanging_indent=True, hanging_indent_in=0.5,
    ))
    assert snapshot.references_check_hanging_indent is True
    assert snapshot.references_hanging_indent_in == 0.5
    config = EffectiveProfileConfig(snapshot)
    assert config.REFERENCES_CHECK_HANGING_INDENT is True
    assert config.REFERENCES_HANGING_INDENT_IN == 0.5


def test_no_new_scoring_category_or_weight_was_added():
    from app.services.scoring import CATEGORY_META, CATEGORY_ORDER

    assert set(CATEGORY_ORDER) == {
        "page_margins", "heading_hierarchy", "media_captions",
        "font_consistency", "font_size", "paragraph_typography", "citation_apa",
    }
    assert set(CATEGORY_META) == set(CATEGORY_ORDER)


# --- 12: profile schema validation ----------------------------------------


def test_default_references_settings_keep_every_new_check_off():
    r = ReferencesSettings()
    assert r.check_heading_text is False
    assert r.allow_heading_aliases is False
    assert r.check_heading_bold is False
    assert r.check_heading_alignment is False
    assert r.check_start_on_new_page is False
    assert r.check_hanging_indent is False
    assert r.check_line_spacing is None
    assert r.check_space_before is False
    assert r.check_space_after is False
    assert r.check_font_family is False
    assert r.check_font_size is False
    assert r.check_alignment is False
    assert r.heading_bold is True


def _profile_object(references) -> DocumentFormattingProfile:
    profile = new_custom_profile("Validation Probe")
    profile.references = references
    return profile


def _error_paths(references):
    return {path for path, _ in _profile_object(references).validate()}


@pytest.mark.parametrize("field", [
    "check_heading_text", "allow_heading_aliases", "check_heading_bold",
    "heading_bold", "check_heading_alignment", "check_start_on_new_page",
    "check_hanging_indent", "check_space_before", "check_space_after",
    "check_font_family", "check_font_size", "check_alignment",
])
def test_non_boolean_toggles_are_rejected_not_truthy_coerced(field):
    for bad in ("true", 1, 0, None, []):
        if field == "check_line_spacing":
            continue
        refs = ReferencesSettings(**{field: bad})
        assert f"references.{field}" in _error_paths(refs), (field, bad)


def test_check_line_spacing_is_the_only_toggle_that_accepts_none():
    refs = ReferencesSettings(check_line_spacing=None)
    assert "references.check_line_spacing" not in _error_paths(refs)
    refs = ReferencesSettings(check_line_spacing="true")
    assert "references.check_line_spacing" in _error_paths(refs)


def test_heading_text_must_be_one_of_the_four_words():
    from app.services.profile_schema import REFERENCE_HEADING_TEXT_CHOICES

    assert set(REFERENCE_HEADING_TEXT_CHOICES) == {
        "references", "bibliography", "works cited", "reference list",
    }
    for word in REFERENCE_HEADING_TEXT_CHOICES:
        assert "references.heading_text" not in _error_paths(
            ReferencesSettings(heading_text=word.title())
        )
    assert "references.heading_text" in _error_paths(
        ReferencesSettings(heading_text="Reference")
    )


def test_alignment_values_are_restricted_to_the_shared_vocabulary():
    for field in ("alignment", "heading_alignment"):
        assert f"references.{field}" not in _error_paths(
            ReferencesSettings(**{field: "justify"})
        )
        assert f"references.{field}" in _error_paths(
            ReferencesSettings(**{field: "middle"})
        )


def test_numeric_reference_values_are_range_checked():
    assert "references.hanging_indent_in" in _error_paths(
        ReferencesSettings(hanging_indent_in=9.0)
    )
    assert "references.font_size_pt" in _error_paths(
        ReferencesSettings(font_size_pt=1.0)
    )
    assert "references.space_before_pt" in _error_paths(
        ReferencesSettings(space_before_pt=400.0)
    )
    assert "references.line_spacing" in _error_paths(
        ReferencesSettings(line_spacing=9.0)
    )


def test_a_blank_references_group_validates():
    assert _error_paths(ReferencesSettings()) == set()


# --- 13: snapshot tri-state line spacing ----------------------------------


def _snapshot(references):
    profile = new_custom_profile("Snapshot Probe")
    profile.references = references
    return resolve_snapshot(profile)


def test_absent_line_spacing_toggle_keeps_the_historical_enforcement():
    """None + a stored value ⇒ enforced, exactly as before the feature."""
    assert _snapshot(
        ReferencesSettings(line_spacing=2.0),
    ).references_check_line_spacing is True
    assert _snapshot(
        ReferencesSettings(line_spacing=None),
    ).references_check_line_spacing is False


def test_an_explicit_line_spacing_toggle_always_wins():
    assert _snapshot(
        ReferencesSettings(line_spacing=2.0, check_line_spacing=False),
    ).references_check_line_spacing is False
    assert _snapshot(
        ReferencesSettings(line_spacing=None, check_line_spacing=True),
    ).references_check_line_spacing is True


def test_snapshot_records_the_heading_word_in_lowercase():
    assert _snapshot(
        ReferencesSettings(check_heading_text=True, heading_text="  Works Cited "),
    ).references_heading_text == "works cited"


def test_snapshot_never_drops_a_configured_value_because_its_toggle_is_off():
    """The audit disclosure must show what the profile says."""
    snapshot = _snapshot(
        ReferencesSettings(
            check_hanging_indent=False, hanging_indent_in=0.5,
            check_font_size=False, font_size_pt=14.0,
            check_alignment=False, alignment="justify",
        ),
    )
    assert snapshot.references_hanging_indent_in == 0.5
    assert snapshot.references_font_size_pt == 14.0
    assert snapshot.references_alignment == "justify"
    assert snapshot.references_check_hanging_indent is False


def test_snapshot_rules_receive_their_own_toggle_and_value():
    snapshot = _snapshot(
        ReferencesSettings(
            check_hanging_indent=True, hanging_indent_in=0.5,
            check_font_size=True, font_size_pt=12.0,
        ),
    )
    config = EffectiveProfileConfig(snapshot)
    assert config.REFERENCES_CHECK_HANGING_INDENT is True
    assert config.REFERENCES_HANGING_INDENT_IN == 0.5
    assert config.REFERENCES_CHECK_FONT_SIZE is True
    assert config.REFERENCES_FONT_SIZE_PT == 12.0


def test_v3_snapshot_carries_every_reference_key_and_legacy_ones_do_not():
    from app.services.profile_snapshot import (
        SNAPSHOT_SCHEMA_VERSION,
        _REFERENCES_GROUP_KEYS_LEGACY,
        _REFERENCES_GROUP_KEYS_V3,
    )

    assert SNAPSHOT_SCHEMA_VERSION == 3
    group = _snapshot(ReferencesSettings()).to_dict()["references"]
    assert tuple(group) == _REFERENCES_GROUP_KEYS_V3
    assert set(_REFERENCES_GROUP_KEYS_LEGACY) < set(_REFERENCES_GROUP_KEYS_V3)


# --- 14: fixed reader-facing copy -----------------------------------------


def test_every_new_rule_code_has_a_plain_language_title():
    expected = {
        "REFERENCE_HEADING_TEXT": "Reference List heading does not match",
        "REFERENCE_HEADING_BOLD": "Reference List heading should be bold",
        "REFERENCE_HEADING_ALIGNMENT": "Reference List heading alignment does not match",
        "REFERENCE_SECTION_NEW_PAGE": "Reference List should start on a new page",
        "REFERENCE_HANGING_INDENT": "Reference entry hanging indent does not match",
        "REFERENCE_SPACE_BEFORE": "Space before Reference List entries does not match",
        "REFERENCE_SPACE_AFTER": "Space after Reference List entries does not match",
        "REFERENCE_FONT_FAMILY": "Reference entry font family does not match",
        "REFERENCE_FONT_SIZE": "Reference entry font size does not match",
        "REFERENCE_ALIGNMENT": "Reference entry alignment does not match",
    }
    for code, title in expected.items():
        assert _RULE_NAME[code] == title, code


def test_every_new_rule_code_has_a_required_action():
    for code in expected_codes():
        assert _REQUIRED_ACTIONS[code], code


def expected_codes():
    return (
        "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
        "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
        "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
        "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
        "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
    )


def test_required_action_copy_names_no_low_level_unit():
    for code in expected_codes():
        action = _REQUIRED_ACTIONS[code]
        for token in ("twip", "EMU", "w:ind", "regex", "px"):
            assert token not in action, (code, token)


def test_guided_fixes_never_touches_a_reference_rule():
    from app.services.guided_fix import SAFE_PARA_RULES, SAFE_RUN_RULES

    assert not any("REFERENCE" in rule for rule in SAFE_RUN_RULES | SAFE_PARA_RULES)