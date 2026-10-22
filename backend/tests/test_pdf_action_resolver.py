"""Saved-evidence PDF recommendations, independent of register pagination."""
from types import SimpleNamespace

import pytest

from app.services import pdf_report
from app.services.layout_engine import check_font_consistency, check_font_size
from app.services.layout_violation import LayoutViolation


def _finding(code, current=None, required=None, *, severity="MINOR", location=None,
             message="Saved finding."):
    return LayoutViolation(
        rule_code=code, severity=severity,
        location={"paragraph_index": 3, "run_index": 0} if location is None else location,
        message=message, expected_value=required, actual_value=current,
    )


@pytest.mark.parametrize("severity", ["MAJOR", "MINOR", "REVIEW", "LEGACY"])
def test_supported_action_does_not_depend_on_severity(severity):
    finding = _finding("FONT_SIZE", "14pt", "16.0pt", severity=severity)
    assert pdf_report._pdf_finding_action(finding) == (
        "Change the font size for the affected text at Paragraph 4 from 14 pt to 16.0 pt."
    )


@pytest.mark.parametrize(
    "code,current,required,property_name,location,label",
    [
        ("FONT_CONSISTENCY", "Calibri", "Times New Roman", "font",
         {"paragraph_index": 3, "run_index": 1}, "for the affected text at Paragraph 4"),
        ("FONT_SIZE", "14pt", "16.0pt", "font size",
         {"paragraph_index": 3, "run_indexes": [0, 2]}, "for the affected text at Paragraph 4"),
        ("LINE_SPACING", "1.0", "1.75", "line spacing", {"paragraph_index": 3}, "at Paragraph 4"),
        ("SPACE_BEFORE", "18pt", "0pt", "space before", {"paragraph_index": 3}, "at Paragraph 4"),
        ("SPACE_AFTER", "0pt", "8pt", "space after", {"paragraph_index": 3}, "at Paragraph 4"),
        ("ALIGNMENT", "left", "justify", "alignment", {"paragraph_index": 3}, "at Paragraph 4"),
        ("MARGIN_LEFT", "1in", "1.25in", "left margin", {"section_index": 1}, "at Section 2"),
        ("MARGIN_RIGHT", "1in", "0.75in", "right margin", {"section_index": 1}, "at Section 2"),
        ("MARGIN_TOP", "1in", "0.8in", "top margin", {"section_index": 1}, "at Section 2"),
        ("MARGIN_BOTTOM", "1in", "0.9in", "bottom margin", {"section_index": 1}, "at Section 2"),
    ],
)
def test_scalar_actions_name_saved_property_and_target_not_paragraph_excerpt(
    code, current, required, property_name, location, label,
):
    finding = _finding(code, current, required, location=location)
    before = finding.to_dict()
    audit = SimpleNamespace(document_blocks=[{
        "index": 3, "text": "This paragraph prefix is not the affected run text.", "style_name": "Normal",
    }])
    assert pdf_report._pdf_finding_action(finding, audit) == (
        f"Change the {property_name} {label} from {pdf_report._student_clean(current)} "
        f"to {pdf_report._student_clean(required)}."
    )
    assert finding.to_dict() == before


@pytest.mark.parametrize("current", [None, "", " \t\n"])
def test_missing_current_uses_set_without_invented_source_value(current):
    action = pdf_report._pdf_finding_action(_finding("FONT_SIZE", current, " 21.5pt "))
    assert action == "Set the font size for the affected text at Paragraph 4 to 21.5 pt."
    assert "Not recorded" not in action
    assert "from" not in action


@pytest.mark.parametrize("required", [None, "", " \t\n"])
@pytest.mark.parametrize("current", [None, "", " \t\n", "14pt"])
@pytest.mark.parametrize("code,property_name", [
    ("FONT_SIZE", "font size"), ("LINE_SPACING", "line spacing"), ("ALIGNMENT", "alignment"),
    ("MARGIN_LEFT", "left margin"),
])
def test_missing_scalar_requirement_never_uses_profile_default(code, property_name, current, required):
    assert pdf_report._pdf_finding_action(_finding(code, current, required)) == (
        f"Review the saved {property_name} finding in the original document; "
        "the required value was not recorded."
    )


@pytest.mark.parametrize("required", [None, "", " \t\n"])
@pytest.mark.parametrize("current", [None, "", " \t\n", "A recorded value"])
def test_unknown_historical_finding_without_requirement_has_no_action(current, required):
    finding = _finding("HISTORICAL_UNKNOWN", current, required, severity="LEGACY")
    assert pdf_report._pdf_finding_action(finding) is None


@pytest.mark.parametrize("current", [None, "", " \t\n", "Old value"])
def test_unknown_historical_requirement_gets_review_not_replacement(current):
    finding = _finding("HISTORICAL_UNKNOWN", current, " Saved requirement ", severity="LEGACY")
    assert pdf_report._pdf_finding_action(finding) == (
        "Review the saved requirement at this location before making changes."
    )


@pytest.mark.parametrize("code,current,required,expected", [
    ("TABLE_CAPTION_MISSING", "No caption found", "Table 1: <description>",
     "In Word, use References → Insert Caption to add a Table caption for this table. "
     "Write a description of the actual table; do not insert <description> literally."),
    ("IMAGE_CAPTION_MISSING", "No caption found", "Figure 1: <description>",
     "In Word, use References → Insert Caption to add a Figure caption for this image. "
     "Write a description of the actual image; do not insert <description> literally."),
    ("MANUAL_CAPTION", "Manual 'Table N' text without Caption style or SEQ field",
     "Word caption (References → Insert Caption)",
     "Use Word’s References → Insert Caption feature for this object, preserving the "
     "existing description and replacing the typed label and number with an automatic caption."),
    ("IMAGE_ALT_TEXT_MISSING", "Empty or missing docPr@descr", "Non-empty alt-text description",
     "Add a concise description of the image in Word’s Alt Text pane for screen-reader users."),
])
def test_media_actions_explain_word_mechanism_instead_of_substituting_evidence(
    code, current, required, expected,
):
    finding = _finding(code, current, required, location={"table_index": 0})
    before = finding.to_dict()
    assert pdf_report._pdf_finding_action(finding) == expected
    assert finding.to_dict() == before


@pytest.mark.parametrize("code", [
    "TABLE_CAPTION_MISSING", "IMAGE_CAPTION_MISSING", "MANUAL_CAPTION", "IMAGE_ALT_TEXT_MISSING",
])
def test_media_manual_guidance_is_supported_even_without_saved_values(code):
    assert pdf_report._pdf_finding_action(_finding(code, " \t", None))


@pytest.mark.parametrize("current,required", [("H2", "H1"), ("H4", "H2"), (None, None)])
def test_heading_sequence_evidence_requires_structural_judgement(current, required):
    action = pdf_report._pdf_finding_action(_finding("HEADING_HIERARCHY", current, required))
    assert action == (
        "Review the heading structure at this location. Use Heading 1 for the first heading "
        "and consecutive levels thereafter; add or restyle headings as appropriate to the document structure."
    )
    assert "from" not in action


class _PairPreset:
    profile_label = '"Synthetic allowed-pair profile"'
    FONT_FAMILY = None
    FONT_SIZE_BODY = None
    HEADING_FONT_FAMILY = None
    BODY_ALLOWED_FONT_COMBOS = (("Times New Roman", 12.0), ("Calibri", 11.0))
    HEADING_ALLOWED_FONT_COMBOS = BODY_ALLOWED_FONT_COMBOS

    def heading_expected_size(self, level):
        return 12.0

    def is_font_pair_allowed(self, family, size, heading=False):
        return (family, size) in self.BODY_ALLOWED_FONT_COMBOS


@pytest.mark.parametrize("producer,style", [
    (check_font_consistency, "Normal"), (check_font_size, "Heading 1"),
])
def test_actual_font_producer_pair_lists_are_not_scalar_replacements(producer, style):
    findings = producer([{
        "index": 3, "style_name": style,
        "runs": [{"index": 0, "effective_font_name": "Georgia", "effective_font_size": 11.0}],
    }], _PairPreset())
    assert len(findings) == 1
    finding = findings[0]
    assert finding.expected_value == "Times New Roman 12pt, Calibri 11pt"
    before = finding.to_dict()
    assert pdf_report._pdf_finding_action(finding) == (
        "Choose a permitted font-and-size combination from the saved Required value "
        "and apply it to the affected text at this location."
    )
    assert finding.to_dict() == before


@pytest.mark.parametrize("code,required", [
    ("FONT_CONSISTENCY", "Times New Roman 12pt, Calibri 11pt"),
    ("FONT_CONSISTENCY", "Times New Roman 12pt"),
    ("FONT_CONSISTENCY", "Calibri or Arial"),
    ("FONT_CONSISTENCY", "12pt"),
    ("FONT_SIZE", "11pt or 12pt"),
    ("FONT_SIZE", "Use the saved permitted combinations"),
])
def test_pair_or_ambiguous_font_requirements_do_not_choose_one_value(code, required):
    finding = _finding(code, "Georgia 11pt", required, message="Historical saved finding.")
    assert pdf_report._pdf_finding_action(finding) == (
        "Choose a permitted font-and-size combination from the saved Required value "
        "and apply it to the affected text at this location."
    )


def test_citation_root_requires_section_instead_of_a_single_reference():
    finding = _finding("CITATION_MISMATCH", None, None, severity="MAJOR",
                       location={"missing_references_section": True, "paragraph_index": 3})
    assert pdf_report._pdf_finding_action(finding) == (
        "Add a References section and list every source cited in the text."
    )


def test_unmatched_citation_preserves_author_specific_choice():
    finding = _finding("CITATION_MISMATCH", "Jones (2019)", "Matching References entry",
                       message="Citation 'Jones (2019)' was found in text, but no matching entry was found.")
    assert pdf_report._pdf_finding_action(finding) == (
        "Add a matching References entry for Jones (2019), or correct or remove "
        "the in-text citation if it refers to the wrong source."
    )


@pytest.mark.parametrize("code", sorted(pdf_report._CITATION_MATCH_RULES))
def test_citation_reference_matching_preserves_dedicated_manual_instruction(code):
    assert pdf_report._pdf_finding_action(_finding(code)) == pdf_report._REQUIRED_ACTIONS[code]


def test_ambiguous_citation_remains_confirmation_not_automatic_repair():
    assert pdf_report._pdf_finding_action(_finding("CITATION_REFERENCE_AMBIGUOUS", severity="REVIEW")) == (
        "Confirm which listed source this citation refers to; initials are not compared."
    )


@pytest.mark.parametrize("required", [None, "", " \t\n", "0.35in"])
def test_reference_hanging_indent_uses_only_recorded_amount(required):
    action = pdf_report._pdf_finding_action(_finding("REFERENCE_HANGING_INDENT", "0.1in", required))
    if required == "0.35in":
        assert action == (
            "Apply a 0.35 in hanging indent so the first line stays at the left margin "
            "and the following lines are indented."
        )
    else:
        assert action == pdf_report._REQUIRED_ACTIONS["REFERENCE_HANGING_INDENT"]
    assert "0.5" not in action


def test_custom_reference_line_spacing_is_saved_scalar_not_body_default():
    finding = _finding("LINE_SPACING", "1.0", "2.25",
                       message="This reference entry uses 1 line spacing. The selected profile requires 2.25.")
    assert pdf_report._pdf_finding_action(finding) == (
        "Change the line spacing at Paragraph 4 from 1.0 to 2.25."
    )


@pytest.mark.parametrize("code", sorted(pdf_report._REFERENCE_FORMAT_RULES - {"REFERENCE_HANGING_INDENT"}))
def test_reference_formatting_preserves_existing_evidence_independent_guidance(code):
    assert pdf_report._pdf_finding_action(_finding(code)) == pdf_report._REQUIRED_ACTIONS[code]


@pytest.mark.parametrize("code,kind,state,expected", [
    ("HEADER_CONTENT_REQUIRED", "header", "unresolved",
     "Review the header in Word; supported evidence could not verify this requirement."),
    ("FOOTER_CONTENT_REQUIRED", "footer", "empty",
     "Review the footer in Word; add the required content if needed."),
    ("PAGE_NUMBER_FIELD_REQUIRED", "either", "missing",
     "Review the header or footer in Word; insert an automatic page number if required."),
])
def test_structural_review_keeps_priority_panel_conditional_wording(code, kind, state, expected):
    finding = _finding(code, severity="REVIEW", location={
        "structural_story": True, "story_type": kind, "section_index": 1, "evidence_state": state,
    })
    assert pdf_report._pdf_finding_action(finding) == expected


@pytest.mark.parametrize("state", ["unresolved", "empty"])
def test_other_page_element_cases_use_existing_display_guidance(state):
    finding = _finding("HEADER_CONTENT_REQUIRED", severity="REVIEW", location={
        "story_type": "header", "section_index": 1, "evidence_state": state,
    })
    assert pdf_report._pdf_finding_action(finding) == pdf_report._page_element_display(finding)[2]


@pytest.mark.parametrize("severity", ["MAJOR", "REVIEW"])
def test_priority_panel_uses_resolver_output_without_its_own_action_override(monkeypatch, severity):
    finding = _finding("PAGE_NUMBER_FIELD_REQUIRED", severity=severity, location={
        "structural_story": True, "story_type": "header", "section_index": 0,
        "evidence_state": "unresolved",
    })
    audit = SimpleNamespace(document_blocks=[])
    calls = []

    def resolve(value, saved_audit):
        calls.append((value, saved_audit))
        return "Resolved conditional user step."

    monkeypatch.setattr(pdf_report, "_pdf_finding_action", resolve)
    monkeypatch.setattr(pdf_report, "_panel", lambda title, status, rows, **kwargs: rows)
    rows = pdf_report._priority_table(finding, audit)
    assert calls == [(finding, audit)]
    assert [value for label, value in rows if label == "Action"] == ["Resolved conditional user step."]


def test_priority_panel_omits_action_label_when_no_supported_guidance(monkeypatch):
    monkeypatch.setattr(pdf_report, "_panel", lambda title, status, rows, **kwargs: rows)
    rows = pdf_report._priority_table(_finding("UNKNOWN", "Some evidence", severity="MAJOR"))
    assert ("Current", "Some evidence") in rows
    assert ("Required", "Not recorded") in rows
    assert all(label != "Action" for label, value in rows)
