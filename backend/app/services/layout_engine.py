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


def _is_list_item(para_dict: Dict) -> bool:
    """Detect whether a paragraph is a numbered/bulleted list item.

    List items are exempt from the body-alignment rule (they're legitimately
    left-aligned even when body is justified). The flag is set by
    extract_paragraphs() which walks the <w:numPr> element.
    """
    return bool(para_dict.get("is_list_item", False))


def check_paragraph_typography(paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.3: Paragraph typography — line spacing, spacing before/after, alignment.

    List items (numbered/bulleted) are EXEMPT from the alignment rule —
    they're legitimately left-aligned even when body text is justified.
    """
    violations = []

    for para in paragraphs:
        style = para.get("style_name", "")
        level = get_heading_level(style)
        is_heading = level is not None
        is_list = _is_list_item(para)

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

        # Alignment — SKIP list items
        if is_list:
            continue

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
    """FR-2.5: Heading hierarchy — detect skipped levels AND orphan first headings.

    Two checks:
    1. Skip detection: H1 -> H3 (missing H2) is a MAJOR violation.
    2. Orphan detection: the very first heading in the document must be H1.
       Starting at H2 or H3 breaks Word's outline view and any auto-TOC.
    """
    violations = []
    last_heading_level = 0
    first_heading_seen = False

    for para in paragraphs:
        level = get_heading_level(para.get("style_name"))
        if level is None:
            continue

        # Orphan check: first heading must be H1
        if not first_heading_seen:
            first_heading_seen = True
            if level != 1:
                violations.append(LayoutViolation(
                    rule_code="HEADING_HIERARCHY",
                    severity="MAJOR",
                    location={"paragraph_index": para["index"]},
                    message=f"First heading is H{level} (should be H1). The outline tree must start at level 1.",
                    expected_value="H1",
                    actual_value=f"H{level}",
                ))
            last_heading_level = level
            continue

        # Skip detection (existing logic)
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


def _extract_paragraph_text(p_elem) -> str:
    """Extract concatenated text from a <w:p> XML element.

    Uses .iter() to walk ALL descendants because <w:t> text elements are
    nested inside <w:r> runs — direct children of <w:p> are <w:pPr> and
    <w:r>, not <w:t>.
    """
    text = ""
    for descendant in p_elem.iter():
        if descendant.tag.endswith("}t"):
            text += descendant.text or ""
    return text


def _find_image_context(doc: Document, image_rel) -> tuple:
    """Find (host_paragraph_index, prev_text, next_text) for an image.

    Walks the document body in order; when a paragraph contains a drawing
    whose r:embed matches the target image's rId, returns that paragraph's
    index plus the text of its neighbours. Returns (-1, "", "") if not found.
    """
    from docx.oxml.ns import qn

    paragraphs = doc.paragraphs
    for idx, para in enumerate(paragraphs):
        # Look for <w:drawing> inside this paragraph's runs
        drawings = para._p.findall(".//" + qn("w:drawing"))
        if not drawings:
            # Fallback: try unprefixed
            drawings = para._p.findall(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing")
        for drawing in drawings:
            # r:embed attribute on <a:blip> tells us which image rel this is
            blips = drawing.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip")
            for blip in blips:
                embed = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
                if embed and embed in doc.part.rels:
                    if doc.part.rels[embed].target_ref == image_rel.target_ref:
                        prev_text = paragraphs[idx - 1].text if idx > 0 else ""
                        next_text = paragraphs[idx + 1].text if idx < len(paragraphs) - 1 else ""
                        return idx, prev_text, next_text
    return -1, "", ""


def _extract_image_alt_text(doc: Document, image_rel) -> str:
    """Extract the docPr@descr (alt-text) for an image.

    Walks all <wp:docPr> elements in the document XML; returns the descr
    attribute (or title as fallback). Returns "" if no alt-text is set.
    """
    body_xml = doc.element.body
    ns = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
    for docpr in body_xml.iter(ns + "docPr"):
        descr = docpr.get("descr") or docpr.get("title") or ""
        if descr:
            return descr
    return ""


def check_media_captions(doc: Document, paragraphs: List[Dict], preset) -> List[LayoutViolation]:
    """FR-2.6: Media captions — tables AND images must have captions.

    Multilingual: uses preset.is_caption_text() which matches English,
    Malay (Jadual/Gambar/Rajah/Graf), and Chinese (表/图) prefixes.

    Bidirectional caption lookup: checks BOTH the preceding AND following
    paragraph, because some style guides place table captions above and
    figure captions below — we accept either position.

    Image alt-text: every embedded image should carry a docPr@descr
    attribute for accessibility. Missing alt-text is a MINOR violation.
    """
    violations = []

    # ---- Tables ----
    for table_idx, table in enumerate(doc.tables):
        has_caption = False
        tbl_element = table._tbl

        # Check preceding paragraph
        prev_elem = tbl_element.getprevious()
        if prev_elem is not None and prev_elem.tag.endswith("}p"):
            prev_text = _extract_paragraph_text(prev_elem)
            if prev_text and preset.is_caption_text(prev_text):
                has_caption = True

        # Check following paragraph (bidirectional)
        if not has_caption:
            next_elem = tbl_element.getnext()
            if next_elem is not None and next_elem.tag.endswith("}p"):
                next_text = _extract_paragraph_text(next_elem)
                if next_text and preset.is_caption_text(next_text):
                    has_caption = True

        if not has_caption:
            violations.append(LayoutViolation(
                rule_code="TABLE_CAPTION_MISSING",
                severity="MINOR",
                location={"table_index": table_idx},
                message=(
                    f"Table {table_idx + 1} has no caption. Add a paragraph "
                    f"above or below it starting with 'Table {table_idx + 1}: ' "
                    f"(or 'Jadual {table_idx + 1}: ' / '表{table_idx + 1}')."
                ),
                expected_value=f"Table {table_idx + 1}: <description>",
                actual_value="No caption found",
            ))

    # ---- Images (inline shapes) — caption + alt-text checks ----
    image_idx = 0
    for rel in doc.part.rels.values():
        if "image" not in rel.target_ref:
            continue
        image_idx += 1

        # Walk the document body to find the paragraph hosting this image,
        # then check its surrounding paragraphs for captions.
        host_para_idx, prev_text, next_text = _find_image_context(doc, rel)
        has_caption = (
            (prev_text and preset.is_caption_text(prev_text)) or
            (next_text and preset.is_caption_text(next_text))
        )
        if not has_caption:
            violations.append(LayoutViolation(
                rule_code="IMAGE_CAPTION_MISSING",
                severity="MINOR",
                location={"image_index": image_idx - 1, "paragraph_index": host_para_idx},
                message=(
                    f"Image {image_idx} has no caption. Add a paragraph "
                    f"below it starting with 'Figure {image_idx}: ' "
                    f"(or 'Gambar {image_idx}: ' / '图{image_idx}')."
                ),
                expected_value=f"Figure {image_idx}: <description>",
                actual_value="No caption found",
            ))

        # Alt-text check — walk the inline drawing's docPr element
        alt_text = _extract_image_alt_text(doc, rel)
        if not alt_text or not alt_text.strip():
            violations.append(LayoutViolation(
                rule_code="IMAGE_ALT_TEXT_MISSING",
                severity="MINOR",
                location={"image_index": image_idx - 1, "paragraph_index": host_para_idx},
                message=(
                    f"Image {image_idx} has no alt-text. Right-click the image "
                    f"-> Alt Text -> enter a concise description for screen readers."
                ),
                expected_value="Non-empty alt-text description",
                actual_value="Empty or missing docPr@descr",
            ))

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
