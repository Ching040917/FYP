from typing import List, Dict, Any, Optional
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

from app.services.document_parser import (
    parse_document,
    extract_paragraphs,
    extract_sections,
    extract_tables,
    get_heading_level,
    iter_paragraphs_with_context,
)
from app.services.citation_sensor import run_citation_sensor
from app.config import settings


# Authoritative LayoutViolation lives in app.services.layout_violation.
# Re-exported here so existing imports (`from app.services.layout_engine
# import LayoutViolation`) keep working. Avoid re-defining the class here
# or you reintroduce the layout_engine <-> citation_sensor import cycle.
LayoutViolation = __import__(
    "app.services.layout_violation", fromlist=["LayoutViolation"]
).LayoutViolation


def check_font_consistency(paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.1: Font Consistency - scan runs, flag mismatched font families per style."""
    violations = []
    expected_font = preset.FONT_FAMILY

    for para in paragraphs:
        style = para.get("style_name", "")
        if not style or style.lower().startswith("heading"):
            continue  # Headings checked separately

        for run in para.get("runs", []):
            font_name = run.get("font_name")
            if font_name and font_name.lower() != expected_font.lower():
                violations.append(LayoutViolation(
                    rule_code="FONT_CONSISTENCY",
                    severity="MINOR",
                    location={"paragraph_index": para["index"], "run_index": run["index"]},
                    message=f"Font '{font_name}' does not match required '{expected_font}'",
                    expected_value=expected_font,
                    actual_value=font_name,
                ))
    return violations


def check_font_size(paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.2: Font Size Alignment - verify heading/body sizes against presets."""
    violations = []

    for para in paragraphs:
        style = para.get("style_name", "")
        level = get_heading_level(style)

        expected_size = None
        if level == 1:
            expected_size = preset.FONT_SIZE_H1
        elif level == 2:
            expected_size = preset.FONT_SIZE_H2
        elif level == 3:
            expected_size = preset.FONT_SIZE_H3
        elif not level:
            expected_size = preset.FONT_SIZE_BODY

        if expected_size is None:
            continue

        for run in para.get("runs", []):
            font_size = run.get("font_size")
            if font_size and abs(font_size - expected_size) > 0.5:  # Allow 0.5pt tolerance
                severity = "MAJOR" if level else "MINOR"
                violations.append(LayoutViolation(
                    rule_code="FONT_SIZE",
                    severity=severity,
                    location={"paragraph_index": para["index"], "run_index": run["index"]},
                    message=f"{style or 'Body'} font size {font_size}pt != required {expected_size}pt",
                    expected_value=f"{expected_size}pt",
                    actual_value=f"{font_size}pt",
                ))
    return violations


def check_paragraph_typography(paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.3: Paragraph Typography - line spacing, spacing before/after, alignment."""
    violations = []

    for para in paragraphs:
        style = para.get("style_name", "")
        level = get_heading_level(style)
        is_heading = level is not None

        # Line spacing
        expected_line_spacing = preset.LINE_SPACING_HEADING if is_heading else preset.LINE_SPACING_BODY
        actual_line_spacing = para.get("line_spacing")
        if actual_line_spacing and abs(actual_line_spacing - expected_line_spacing) > 0.1:
            violations.append(LayoutViolation(
                rule_code="LINE_SPACING",
                severity="MINOR",
                location={"paragraph_index": para["index"]},
                message=f"Line spacing {actual_line_spacing} != required {expected_line_spacing}",
                expected_value=str(expected_line_spacing),
                actual_value=str(actual_line_spacing),
            ))

        # Space before/after
        expected_before = preset.SPACE_BEFORE_HEADING if is_heading else preset.SPACE_BEFORE_BODY
        expected_after = preset.SPACE_AFTER_HEADING if is_heading else preset.SPACE_AFTER_BODY

        actual_before = para.get("space_before")
        actual_after = para.get("space_after")

        if actual_before is not None and abs(actual_before - expected_before) > 1:
            violations.append(LayoutViolation(
                rule_code="SPACE_BEFORE",
                severity="MINOR",
                location={"paragraph_index": para["index"]},
                message=f"Space before {actual_before}pt != required {expected_before}pt",
                expected_value=f"{expected_before}pt",
                actual_value=f"{actual_before}pt",
            ))

        if actual_after is not None and abs(actual_after - expected_after) > 1:
            violations.append(LayoutViolation(
                rule_code="SPACE_AFTER",
                severity="MINOR",
                location={"paragraph_index": para["index"]},
                message=f"Space after {actual_after}pt != required {expected_after}pt",
                expected_value=f"{expected_after}pt",
                actual_value=f"{actual_after}pt",
            ))

        # Alignment
        expected_align = preset.ALIGNMENT_HEADING if is_heading else preset.ALIGNMENT_BODY
        actual_align = para.get("alignment")
        align_map = {
            WD_ALIGN_PARAGRAPH.LEFT: "left",
            WD_ALIGN_PARAGRAPH.CENTER: "center",
            WD_ALIGN_PARAGRAPH.RIGHT: "right",
            WD_ALIGN_PARAGRAPH.JUSTIFY: "justify",
        }
        actual_align_str = align_map.get(actual_align, "unknown")
        if actual_align_str != "unknown" and actual_align_str != expected_align:
            violations.append(LayoutViolation(
                rule_code="ALIGNMENT",
                severity="MINOR",
                location={"paragraph_index": para["index"]},
                message=f"Alignment '{actual_align_str}' != required '{expected_align}'",
                expected_value=expected_align,
                actual_value=actual_align_str,
            ))
    return violations


def check_page_margins(sections: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.4: Page Margins - measure physical page boundaries."""
    violations = []
    margin_checks = [
        ("margin_left", "MARGIN_LEFT", preset.MARGIN_LEFT),
        ("margin_right", "MARGIN_RIGHT", preset.MARGIN_RIGHT),
        ("margin_top", "MARGIN_TOP", preset.MARGIN_TOP),
        ("margin_bottom", "MARGIN_BOTTOM", preset.MARGIN_BOTTOM),
    ]

    for section_idx, section in enumerate(sections):
        for key, rule_code, expected in margin_checks:
            actual = section.get(key)
            if actual is not None and abs(actual - expected) > 0.05:  # 0.05" tolerance
                violations.append(LayoutViolation(
                    rule_code=rule_code,
                    severity="MAJOR",
                    location={"section_index": section_idx},
                    message=f"Page margin {key.replace('margin_', '')} {actual:.2f}in != required {expected}in",
                    expected_value=f"{expected}in",
                    actual_value=f"{actual:.2f}in",
                ))
    return violations


def check_heading_hierarchy(paragraphs: List[Dict]) -> List[LayoutViolation]:
    """FR-2.5: Heading Level Hierarchy - detect skipped levels (e.g., H1 -> H3)."""
    violations = []
    last_heading_level = 0

    for para in paragraphs:
        level = get_heading_level(para.get("style_name"))
        if level is None:
            continue

        if last_heading_level > 0 and level > last_heading_level + 1:
            violations.append(LayoutViolation(
                rule_code="HEADING_HIERARCHY",
                severity="MAJOR",
                location={"paragraph_index": para["index"]},
                message=f"Heading level skipped: H{last_heading_level} -> H{level} (missing H{last_heading_level + 1})",
                expected_value=f"H{last_heading_level + 1}",
                actual_value=f"H{level}",
            ))
        last_heading_level = level

    return violations


def check_media_captions(doc: Document, paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.6: Media Captions - confirm tables/figures have captions."""
    violations = []

    # Check tables
    for table_idx, table in enumerate(doc.tables):
        has_caption = False
        # Check preceding paragraph
        tbl_element = table._tbl
        prev_elem = tbl_element.getprevious()

        if prev_elem is not None:
            from docx.oxml.ns import qn
            p_pr = prev_elem.find(qn('w:pPr'))
            if p_pr is not None:
                # Get text from previous paragraph
                prev_text = ""
                for child in prev_elem:
                    if child.tag.endswith('}t'):
                        prev_text += child.text or ""
                if prev_text and preset.CAPTION_TABLE_PREFIX.lower() in prev_text.lower():
                    has_caption = True

        if not has_caption:
            violations.append(LayoutViolation(
                rule_code="TABLE_CAPTION_MISSING",
                severity="MINOR",
                location={"table_index": table_idx},
                message=f"Table {table_idx + 1} missing required '{preset.CAPTION_TABLE_PREFIX}' caption above",
                expected_value=f"{preset.CAPTION_TABLE_PREFIX} N: Description",
                actual_value="No caption found",
            ))

    # Check figures (inline shapes)
    # Note: python-docx has limited support for detecting figures with captions
    # This is a simplified check - in practice would need more sophisticated XML traversal
    for rel in doc.part.rels.values():
        if "image" in rel.target_ref:
            # For now, just flag that image exists - full caption detection requires
            # more complex XML analysis which is a known limitation
            pass

    return violations


def run_static_rules_engine(file_bytes: bytes) -> List[LayoutViolation]:
    """Main entry point - runs all static layout checks."""
    doc = parse_document(file_bytes)
    preset = settings.PRESET

    paragraphs = extract_paragraphs(doc)
    sections = extract_sections(doc)

    all_violations = []
    all_violations.extend(check_font_consistency(paragraphs, preset))
    all_violations.extend(check_font_size(paragraphs, preset))
    all_violations.extend(check_paragraph_typography(paragraphs, preset))
    all_violations.extend(check_page_margins(sections, preset))
    all_violations.extend(check_heading_hierarchy(paragraphs))
    all_violations.extend(check_media_captions(doc, paragraphs, preset))
    all_violations.extend(run_citation_sensor(doc, paragraphs))

    return all_violations