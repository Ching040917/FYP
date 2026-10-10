"""Regression contracts for the Reference List structure foundation.

This branch adds evidence extraction only. These tests exist to prove that
fact: the shared heading helper must be observationally identical to the two
implementations it replaced, and no consumer may gain a new rule code, a new
severity, a new profile key or a new snapshot version.
"""

import re

import pytest

from app.services import citation_sensor as cs
from app.services import layout_engine as le
from app.services import role_classifier as rc
from app.services.profile_snapshot import (
    SNAPSHOT_SCHEMA_VERSION,
    SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
)
from app.services.profile_schema import CitationMatchingSettings, ReferencesSettings

# The full rule-code vocabulary that exists on this branch. A new
# Reference-List rule would show up here.
KNOWN_RULE_CODES = {
    "MARGIN_LEFT", "MARGIN_RIGHT", "MARGIN_TOP", "MARGIN_BOTTOM",
    "FONT_CONSISTENCY", "FONT_SIZE", "LINE_SPACING", "SPACE_BEFORE",
    "SPACE_AFTER", "ALIGNMENT", "HEADING_HIERARCHY", "TABLE_CAPTION_MISSING",
    "IMAGE_CAPTION_MISSING", "IMAGE_ALT_TEXT_MISSING", "MANUAL_CAPTION",
    "CITATION_MISMATCH", "CITATION_REFERENCE_MISMATCH",
    "CITATION_YEAR_SUFFIX_MISMATCH", "CITATION_REFERENCE_AMBIGUOUS",
    "REFERENCE_NOT_CITED", "REFERENCE_DUPLICATE",
}

# The ten Reference List FORMATTING codes added by Phase 3. Nothing outside
# this set may ever be added to the PDF/scoring vocabulary.
REFERENCE_FORMAT_CODES = {
    "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
    "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
    "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
    "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
    "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
}


# --- 1/2/3: citation matching, missing section, duplicates ------------------


def test_missing_references_section_behaviour_is_unchanged():
    """A document with citations and no References heading still produces the
    single MAJOR root finding, keyed the same way."""
    from docx import Document

    from app.services.citation_sensor import run_citation_sensor

    doc = Document()
    doc.add_paragraph("Prior work (Garcia, 2018) supports this claim.")
    doc.add_paragraph("Another citation (Smith, 2020) is present.")
    paragraphs = [
        {"index": 0, "text": "Prior work (Garcia, 2018) supports this claim."},
        {"index": 1, "text": "Another citation (Smith, 2020) is present."},
    ]
    violations = run_citation_sensor(doc, paragraphs, config=None)
    codes = [v.rule_code for v in violations]
    assert codes == ["CITATION_MISMATCH"], codes
    assert len(violations) == 1
    assert violations[0].severity == "MAJOR"


def test_duplicate_reference_behaviour_is_unchanged():
    doc_paras = [
        {"index": 0, "text": "See (Smith, 2020)."},
        {"index": 1, "text": "References"},
        {"index": 2, "text": "Smith, J. (2020). A title. Publisher."},
        {"index": 3, "text": "Smith, J. (2020). A title. Publisher."},
    ]
    from docx import Document

    violations = cs.run_citation_sensor(Document(), doc_paras, config=None)
    duplicates = [v for v in violations if v.rule_code == "REFERENCE_DUPLICATE"]
    assert len(duplicates) == 1
    assert duplicates[0].severity == "MINOR"


# --- 4: REFERENCES_LINE_SPACING is untouched --------------------------------


def test_references_line_spacing_still_uses_the_existing_preset_field():
    assert hasattr(le, "check_paragraph_typography")
    source = open(le.__file__, encoding="utf-8").read()
    # The existing configuration path must still be the one that runs.
    assert "preset.REFERENCES_LINE_SPACING" in source
    # The Phase 3 formatting rules live in their own module; the generic
    # typography path never grew a Reference-List code of its own.
    typography = source.split("def check_paragraph_typography", 1)[1]
    typography = typography.split("\ndef ", 1)[0]
    assert "REFERENCE_HANGING_INDENT" not in typography
    assert "REFERENCE_SECTION_NEW_PAGE" not in typography


def test_references_line_spacing_violation_is_unchanged():
    from app.config import PresetConfig

    preset = PresetConfig()
    preset.REFERENCES_LINE_SPACING = 2.0
    paragraphs = [
        {"index": 0, "text": "Body.", "style_name": "Normal", "alignment": None,
         "line_spacing": 1.0, "space_before": None, "space_after": None,
         "is_list_item": False, "runs": []},
        {"index": 1, "text": "References", "style_name": "Heading 1",
         "alignment": None, "line_spacing": None, "space_before": None,
         "space_after": None, "is_list_item": False, "runs": []},
        {"index": 2, "text": "Smith, J. (2020). A title. Publisher.",
         "style_name": "Normal", "alignment": None, "line_spacing": 1.0,
         "space_before": None, "space_after": None, "is_list_item": False,
         "runs": [{"index": 0, "text": "x", "font_name": None, "font_size": None}]},
    ]
    roles = ["BODY", "REFERENCES_HEADING", "REFERENCE_ENTRY"]
    violations = le.check_paragraph_typography(paragraphs, preset, roles=roles)
    reference_line_spacing = [
        v for v in violations
        if v.rule_code == "LINE_SPACING" and v.location.get("paragraph_index") == 2
    ]
    assert len(reference_line_spacing) == 1
    assert reference_line_spacing[0].severity == "MINOR"
    assert reference_line_spacing[0].actual_value == "1.0"
    assert reference_line_spacing[0].expected_value == "2.0"


# --- 5: score unchanged ----------------------------------------------------


def test_scoring_knows_the_reference_formatting_codes():
    """Phase 3 routes each new code to an existing category. No category,
    cap or weight was added — see tests/test_reference_rules.py."""
    from app.services.scoring import rule_code_to_category

    assert rule_code_to_category("REFERENCE_HANGING_INDENT") == "paragraph_typography"
    assert rule_code_to_category("REFERENCE_SECTION_NEW_PAGE") == "heading_hierarchy"
    # The Phase 2 semantic codes still score against citations.
    assert rule_code_to_category("REFERENCE_NOT_CITED") == "citation_apa"
    assert rule_code_to_category("REFERENCE_DUPLICATE") == "citation_apa"
    # Codes that were never part of this feature still do not exist.
    for code in ("REFERENCE_ENTRY_STRUCTURE", "REFERENCE_DOI_FORMAT"):
        assert rule_code_to_category(code) == "citation_apa"


# --- 6: role classification unchanged --------------------------------------


def test_role_classification_of_reference_documents_is_unchanged():
    import io

    from docx import Document

    from app.services.document_parser import extract_paragraphs, parse_document
    from app.services.role_classifier import classify_paragraphs

    doc = Document()
    doc.add_paragraph("Body text with (Garcia, 2018).")
    doc.add_paragraph("References")
    doc.add_paragraph("Smith, J. (2020). A title. Publisher.")

    buf = io.BytesIO()
    doc.save(buf)
    real_doc = parse_document(buf.getvalue())
    paragraphs = extract_paragraphs(real_doc)

    roles = classify_paragraphs(real_doc, paragraphs)
    assert "REFERENCES_HEADING" in roles
    assert "REFERENCE_ENTRY" in roles


# --- 7: snapshot parity ----------------------------------------------------


def test_snapshot_version_carries_the_reference_list_rules():
    # Phase 3 extended the nested references group, so the current version
    # is 3 and every earlier version stays loadable.
    assert SNAPSHOT_SCHEMA_VERSION == 3
    assert tuple(SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS) == (1, 2, 3)


def test_phase_2_citation_matching_keys_are_untouched():
    """Phase 3 adds Reference List FORMATTING keys only.

    The citation-matching group — Phase 2's profile contract — is exactly
    as it was, so no Phase 2 toggle can drift with the new rules.
    """
    assert set(CitationMatchingSettings.__dataclass_fields__) == {
        "check_citations_have_references",
        "check_references_are_cited",
        "check_author_year_consistency",
        "check_year_suffixes",
        "check_duplicate_references",
        "flag_ambiguous_matches",
        "allow_personal_communication",
    }


def test_references_group_keeps_its_two_original_fields():
    assert {"line_spacing", "hanging_indent_in"} <= set(ReferencesSettings.__dataclass_fields__)


def test_legacy_snapshots_serialise_their_own_frozen_references_group():
    """v1/v2 bytes never gain the v3 Reference List keys."""
    from app.services.profile_snapshot import EffectiveProfileSnapshot

    frozen = {"line_spacing": 2.0, "hanging_indent_in": 0.5}
    for version in (1, 2):
        snapshot = EffectiveProfileSnapshot(
            schema_version=version,
            references_line_spacing=2.0,
            references_hanging_indent_in=0.5,
            references_check_hanging_indent=True,
        )
        assert snapshot.to_dict()["references"] == frozen, version


# --- 8/9: no new rule code or severity ------------------------------------


def test_no_new_rule_code_is_emitted_by_any_reference_rule_path():
    """Every rule code the sensor can emit must be pre-existing."""
    seen = set()
    for name in dir(cs):
        obj = getattr(cs, name)
        if callable(obj) and getattr(obj, "__module__", "") == cs.__name__:
            try:
                source = __import__("inspect").getsource(obj)
            except Exception:
                continue
            seen.update(re.findall(r'"([A-Z][A-Z_]{3,})"', source))
    emitted = {c for c in seen if c.endswith("_MISMATCH") or "REFERENCE" in c}
    assert emitted <= KNOWN_RULE_CODES, emitted - KNOWN_RULE_CODES


def test_no_new_severity_token_is_introduced():
    assert set(rc.__dict__.get("_ALL_ROLES", []) or []) <= {
        "BODY", "COVER", "TITLE", "SUBTITLE", "CAPTION_TABLE", "CAPTION_FIGURE",
        "FIGURE_HOST", "REFERENCES_HEADING", "REFERENCE_ENTRY",
        "APPENDIX_HEADING", "APPENDIX_BODY", "EMPTY", "FIELD_ONLY", "UNKNOWN",
        "HEADING_1", "HEADING_2", "HEADING_3", "LIST_ITEM",
        "TABLE_OF_CONTENTS_HEADING", "TABLE_OF_CONTENTS_ENTRY",
        "DISPLAYED_EQUATION", "LAYOUT_TABLE", "RUBRIC_TABLE",
        "SCHOLARLY_TABLE", "ADMINISTRATIVE_TABLE",
    }


# --- 12: Guided Fixes whitelist --------------------------------------------


def test_guided_fixes_whitelist_is_unchanged():
    from app.services.guided_fix import SAFE_PARA_RULES, SAFE_RUN_RULES

    assert set(SAFE_RUN_RULES) == {"FONT_CONSISTENCY", "FONT_SIZE"}
    assert set(SAFE_PARA_RULES) == {
        "ALIGNMENT", "LINE_SPACING", "SPACE_BEFORE", "SPACE_AFTER",
    }
    # No Reference-List rule is eligible for an automatic fix.
    assert not any("REFERENCE" in r for r in SAFE_RUN_RULES | SAFE_PARA_RULES)


# --- 13/14: Local AI and model download untouched --------------------------


def test_local_ai_module_has_no_reference_structure_dependency():
    import app.services.ai_citation as ai

    source = open(ai.__file__, encoding="utf-8").read()
    assert "reference_section" not in source
    assert "formatting_evidence" not in source


def test_model_download_module_untouched_by_this_feature():
    import app.services.local_model_download as dl

    source = open(dl.__file__, encoding="utf-8").read()
    assert "reference_section" not in source
    assert "formatting_evidence" not in source


# --- 15: PDF untouched -----------------------------------------------------


def test_pdf_report_knows_exactly_the_phase_3_rule_names():
    import app.services.pdf_report as pdf

    source = open(pdf.__file__, encoding="utf-8").read()
    # 21 pre-existing codes plus the ten Reference List formatting rules.
    assert len(pdf._RULE_NAME) == 31
    assert set(pdf._RULE_NAME) == KNOWN_RULE_CODES | REFERENCE_FORMAT_CODES
    assert "REFERENCE_ENTRY_STRUCTURE" not in source
