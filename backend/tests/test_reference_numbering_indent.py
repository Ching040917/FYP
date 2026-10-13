"""Numbered Reference entries — numbering-aware hanging-indent evidence.

A paragraph numbered through its style chain (e.g. built-in List Number)
takes its indentation from the list definition in numbering.xml, which the
evidence layer does not read. Reporting a definite "0 in" for such a
paragraph is a false definite finding: the rule must decline (unresolved /
numbering source) instead. Direct paragraph indentation always wins over
numbering when both are stated.
"""
import io

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches

from app.services.document_parser import extract_paragraphs
from app.services.formatting_evidence import (
    SOURCE_NUMBERING,
    resolve_indentation,
    style_chain_has_numbering,
)
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_registry import SUC_PROFILE_ID, get_builtin_profile
from app.services.profile_schema import new_custom_profile
from app.services.profile_snapshot import resolve_snapshot
from app.services.reference_rules import run_reference_rules

ENTRY = "National Standards Office. (2022). Formatting requirements. Test Press."


def _bytes(doc):
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _profile():
    profile = new_custom_profile(
        "Numbering Tests", base=get_builtin_profile(SUC_PROFILE_ID),
    )
    profile.references.check_hanging_indent = True
    profile.references.hanging_indent_in = 0.5
    return EffectiveProfileConfig(resolve_snapshot(profile))


def _objects(data):
    return {i: p for i, p in enumerate(Document(io.BytesIO(data)).paragraphs)}


def _hanging(data):
    doc = Document(io.BytesIO(data))
    violations = run_reference_rules(
        doc, extract_paragraphs(doc), _profile(), page_mapping=None,
    )
    return [v for v in violations if v.rule_code == "REFERENCE_HANGING_INDENT"]


def _doc_with_entry(text=ENTRY, style=None):
    doc = Document()
    doc.add_paragraph("References")
    if style:
        doc.add_paragraph(text, style=style)
    else:
        doc.add_paragraph(text)
    return doc


def _add_bogus_numbered_style(doc, name="Bogus List"):
    """Paragraph style carrying numPr to a nonexistent numbering definition."""
    style = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
    style.base_style = doc.styles["Normal"]
    pPr = style.element.get_or_add_pPr()
    numPr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    numId = OxmlElement("w:numId")
    numId.set(qn("w:val"), "9999")
    numPr.append(ilvl)
    numPr.append(numId)
    pPr.append(numPr)
    return style


def test_1_direct_numpr_with_stated_indent_compares_direct_values():
    """Direct indentation wins even when numbering is present."""
    doc = _doc_with_entry()
    entry = doc.paragraphs[1]
    entry.paragraph_format.left_indent = Inches(0)
    entry.paragraph_format.first_line_indent = Inches(0)
    violations = _hanging(_bytes(doc))
    assert len(violations) == 1
    assert violations[0].actual_value == "0in"


def test_2_style_inherited_numbering_declines_definite_finding():
    """Live defect: List Number style numPr with no direct indent."""
    doc = _doc_with_entry(style="List Number")
    assert style_chain_has_numbering(doc.paragraphs[1]) is True
    evidence = resolve_indentation(_objects(_bytes(doc))[1])
    assert evidence.source == SOURCE_NUMBERING
    assert evidence.is_numbered is True
    assert evidence.hanging_indent_in is None
    assert _hanging(_bytes(doc)) == []


def test_3_list_number_style_name_alone_is_not_the_evidence():
    """Proof comes from persisted style-chain numPr, never the style name."""
    doc = _doc_with_entry(style="List Number")
    assert style_chain_has_numbering(doc.paragraphs[1]) is True
    plain = _doc_with_entry()
    assert style_chain_has_numbering(plain.paragraphs[1]) is False


def test_4_missing_numbering_definition_still_declines():
    """numPr to a nonexistent definition: unresolved, never 0 in."""
    doc = _doc_with_entry()
    style = _add_bogus_numbered_style(doc)
    doc.paragraphs[1].style = style
    assert style_chain_has_numbering(doc.paragraphs[1]) is True
    evidence = resolve_indentation(_objects(_bytes(doc))[1])
    assert evidence.is_numbered is True
    assert _hanging(_bytes(doc)) == []


def test_5_conflicting_numbering_and_direct_indent_prefers_direct():
    """Direct w:ind wins; a mismatch there still emits a finding."""
    doc = _doc_with_entry(style="List Number")
    entry = doc.paragraphs[1]
    entry.paragraph_format.left_indent = Inches(0)
    entry.paragraph_format.first_line_indent = Inches(0)
    violations = _hanging(_bytes(doc))
    assert len(violations) == 1
    assert violations[0].actual_value == "0in"


def test_6_non_numbered_zero_indent_still_emits_finding():
    doc = _doc_with_entry()
    violations = _hanging(_bytes(doc))
    assert len(violations) == 1
    assert violations[0].actual_value == "0in"
    assert violations[0].location["paragraph_index"] == 1


def test_7_correct_hanging_indent_still_passes():
    doc = _doc_with_entry()
    entry = doc.paragraphs[1]
    entry.paragraph_format.left_indent = Inches(0.5)
    entry.paragraph_format.first_line_indent = Inches(-0.5)
    assert _hanging(_bytes(doc)) == []
