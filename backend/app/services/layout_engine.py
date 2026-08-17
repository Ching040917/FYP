from typing import List, Dict, Any, Optional
import re
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
from app.services.citation_sensor import (
    run_citation_sensor,
    _find_references_start,
    APPENDIX_HEADER_PATTERN,
)
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


def _paragraph_visible_text(para: Dict) -> str:
    """Visible text from actual text runs, trimmed.

    Drawing/image runs, field-instruction runs, and empty runs contribute
    nothing — a paragraph that only hosts an image (or only carries an
    uncached field) has no visible text and is not body text.
    """
    return "".join((r.get("text") or "") for r in para.get("runs", [])).strip()


def _style_has_numbering(style) -> bool:
    """True when a style (or any of its base styles) carries list numbering.

    Numbering inherited through the style chain (e.g. Word's List Bullet /
    List Number styles) lives on the STYLE's <w:numPr>, not on the
    paragraph — direct <w:numPr> detection alone misses those.
    """
    from docx.oxml.ns import qn

    seen = set()
    current = style
    while current is not None and getattr(current, "style_id", None) not in seen:
        seen.add(current.style_id)
        pPr = current.element.pPr
        if pPr is not None and pPr.find(qn("w:numPr")) is not None:
            return True
        current = current.base_style
    return False


def _references_span(paragraphs: List[Dict]):
    """Index span of the References section, or None when undetected.

    Reuses the citation sensor's References-header detection; the span ends
    at the first Appendix heading (bibliography ends there), matching the
    sensor's own boundary logic.
    """
    start = _find_references_start(paragraphs)
    if start is None:
        return None
    end = len(paragraphs)
    for para in paragraphs[start:]:
        text = (para.get("text") or "").strip()
        if text and APPENDIX_HEADER_PATTERN.match(text):
            end = para.get("index", end)
            break
    return range(start, end)


def _alignment_eligible(
    para: Dict,
    paragraph_obj,
    preset,
    references_span,
) -> bool:
    """ALIGNMENT applies only to eligible visible-text paragraphs.

    Skipped (alignment is a design choice, not a body-text requirement):
      - empty / field-only / image-only paragraphs (no visible text);
      - semantic Caption-style paragraphs;
      - manual caption text classified by the caption logic;
      - Title and Subtitle styles;
      - list items, including numbering inherited through the style chain;
      - Reference-list entries inside the detected References section.

    Headings and mixed text-and-image paragraphs remain eligible — headings
    use their configured preset alignment, and mixed paragraphs validate
    whenever visible text exists.
    """
    # 1/2/3. Empty, field-only, image-only: no visible text.
    if not _paragraph_visible_text(para):
        return False

    style_name = (para.get("style_name") or "").lower()

    # 6. Title / Subtitle styles.
    if style_name.startswith(("title", "subtitle")):
        return False

    # 4. Semantic Caption style.
    if "caption" in style_name:
        return False

    # 5. Manual caption text already classified by caption logic.
    if preset.is_caption_text(para.get("text") or ""):
        return False

    # 7. Numbering inherited through the style chain.
    if paragraph_obj is not None:
        try:
            style = paragraph_obj.style
        except Exception:
            style = None
        if style is not None and _style_has_numbering(style):
            return False

    # 8. Reference-list entries inside the detected References section.
    if references_span is not None and para.get("index", -1) in references_span:
        return False

    return True


def check_paragraph_typography(
    paragraphs: List[Dict],
    preset,
    doc: Optional[Document] = None,
) -> List[LayoutViolation]:
    """FR-2.3: Paragraph typography — line spacing, spacing before/after, alignment.

    ALIGNMENT applies only to eligible visible-text paragraphs (see
    _alignment_eligible): empty, image-only, caption, title/subtitle, list,
    and Reference-list paragraphs are skipped; ordinary body paragraphs
    keep the justify requirement and headings keep their configured preset
    alignment. Line-spacing and spacing-before/after checks are unchanged.
    """
    violations = []
    references_span = _references_span(paragraphs)

    # doc.paragraphs aligns 1:1 with extract_paragraphs output — pairing
    # gives access to the paragraph style chain for inherited numbering.
    paired = zip(paragraphs, doc.paragraphs) if doc is not None else ((p, None) for p in paragraphs)

    for para, paragraph_obj in paired:
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

        # Alignment — only eligible visible-text paragraphs are validated:
        # empty/image-only/caption/title/list/References paragraphs skip.
        if is_list:
            continue
        if not _alignment_eligible(para, paragraph_obj, preset, references_span):
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
    <w:r>, not <w:t>. Field instruction text (<w:instrText>) is NOT <w:t>,
    so SEQ field instructions never leak into the visible text.
    """
    text = ""
    for descendant in p_elem.iter():
        if descendant.tag.endswith("}t"):
            text += descendant.text or ""
    return text


# --- Semantic caption detection (FR-2.6) ------------------------------------
# A caption is VALID only when it carries Word semantics (Caption paragraph
# style and/or a SEQ Table/Figure field). Plain text that merely looks like
# "Table 2: ..." is a MANUAL caption. Labels are split by object type so a
# table never accepts a figure label and vice versa.

_CAPTION_STYLE_ID = "caption"

_TABLE_LABEL_RE = re.compile(r"^\s*(?:table|tab\.|jadual|表)\s*\d+", re.IGNORECASE)
_FIGURE_LABEL_RE = re.compile(
    r"^\s*(?:figure|fig\.|chart|gambar|rajah|graf|图|图表)\s*\d+", re.IGNORECASE
)

MANUAL_CAPTION_ACTION = (
    "Use Word's References → Insert Caption feature so the label and "
    "numbering remain consistent."
)


def _paragraph_caption_semantics(p_elem, style_names) -> dict:
    """Semantic caption signals of a <w:p>: Caption style, SEQ labels, flags.

    `style_names`: {style_id: lowercase style name} resolved from the doc.
    SEQ labels are collected from ALL <w:instrText> runs — Word splits field
    instructions across multiple runs, e.g. " SEQ " + "Table \\* ARABIC ".
    """
    from docx.oxml.ns import qn

    info = {"caption_style": False, "seq": set(), "heading": False, "list": False}
    pPr = p_elem.find(qn("w:pPr"))
    if pPr is not None:
        if pPr.find(qn("w:numPr")) is not None:
            info["list"] = True
        pStyle = pPr.find(qn("w:pStyle"))
        if pStyle is not None:
            style_id = (pStyle.get(qn("w:val")) or "").lower()
            style_name = style_names.get(style_id, "")
            if style_id == _CAPTION_STYLE_ID or style_name == _CAPTION_STYLE_ID:
                info["caption_style"] = True
            if style_id.startswith("heading") or style_name.startswith("heading"):
                info["heading"] = True
    joined_instr = "".join(
        (t.text or "") for t in p_elem.iter(qn("w:instrText"))
    )
    for m in re.finditer(r"\bSEQ\s+(\w+)", joined_instr, re.IGNORECASE):
        info["seq"].add(m.group(1).lower())
    return info


def _caption_status(p_elem, label_re, seq_label, style_names) -> str:
    """Classify an adjacent paragraph as 'valid', 'manual', or 'none'.

    - valid:   label matches the object type AND (Caption style or matching
               SEQ field). Headings and list items are never valid.
    - manual:  text matches the label pattern but carries no Word semantics.
    - none:    not a caption of this object type (e.g. wrong label, prose
               without a number, or the object type's label is absent).
    """
    text = _extract_paragraph_text(p_elem)
    if not text or not label_re.search(text):
        return "none"
    info = _paragraph_caption_semantics(p_elem, style_names)
    if info["heading"] or info["list"]:
        return "manual"
    if info["caption_style"] or seq_label in info["seq"]:
        return "valid"
    return "manual"


def _adjacent_caption_status(element, label_re, seq_label, style_names, paragraphs=None):
    """Caption status from an element's sibling paragraphs (both directions).

    VALID beats MANUAL; a valid caption on either side satisfies the rule.
    When `paragraphs` (the doc-level paragraph list) is given and a MANUAL
    caption sibling is found, the second return value is that caption
    paragraph's zero-based index — the authoritative association the
    frontend uses to locate the caption block (the typed number may
    legitimately differ from the object's ordinal, so it is never required
    to match).
    """
    status = "missing"
    caption_index = None
    for direction in (element.getprevious, element.getnext):
        sibling = direction()
        if sibling is None or not sibling.tag.endswith("}p"):
            continue
        s = _caption_status(sibling, label_re, seq_label, style_names)
        if s == "valid":
            return "valid", caption_index
        if s == "manual":
            status = "manual"
            if paragraphs is not None:
                caption_index = next(
                    (i for i, p in enumerate(paragraphs) if p._p is sibling),
                    None,
                )
    return status, caption_index


def _find_image_context(doc: Document, image_rel) -> tuple:
    """Find (host_paragraph_index, prev_elem, next_elem) for an image.

    Walks the document body in order; when a paragraph contains a drawing
    whose r:embed matches the target image's rId, returns that paragraph's
    index plus the XML elements of its neighbours (None if absent/missing).
    Returns (-1, None, None) if not found.
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
                        return idx, para._p.getprevious(), para._p.getnext()
    return -1, None, None


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

    Adjacent captions are classified semantically:
    - VALID:   Caption paragraph style and/or a matching SEQ Table/Figure
               field, with a label matching the object type.
    - MANUAL:  text matches 'Table N'/'Figure N' but no Word semantics —
               flagged with MANUAL_CAPTION (MINOR).
    - MISSING: no matching adjacent caption — TABLE_CAPTION_MISSING /
               IMAGE_CAPTION_MISSING.

    Multilingual labels (English, Malay Jadual/Gambar/Rajah/Graf, Chinese
    表/图/图表) are preserved and split by object type. Headings, list
    items, and table-cell text are never accepted as captions. No visual
    appearance (colour, bold) is consulted. Both caption positions are
    accepted (tables above, figures below, or the reverse).

    Image alt-text: every embedded image should carry a docPr@descr
    attribute for accessibility. Missing alt-text is a MINOR violation.
    """
    violations = []
    style_names = {s.style_id: (s.name or "").lower() for s in doc.styles}

    # ---- Tables ----
    for table_idx, table in enumerate(doc.tables):
        status, caption_idx = _adjacent_caption_status(
            table._tbl, _TABLE_LABEL_RE, "table", style_names, doc.paragraphs
        )
        if status == "valid":
            continue
        if status == "manual":
            location = {"table_index": table_idx}
            if caption_idx is not None:
                location["paragraph_index"] = caption_idx
            violations.append(LayoutViolation(
                rule_code="MANUAL_CAPTION",
                severity="MINOR",
                location=location,
                message=(
                    f"Table {table_idx + 1} has a manually typed caption. "
                    f"{MANUAL_CAPTION_ACTION}"
                ),
                expected_value="Word caption (References → Insert Caption)",
                actual_value="Manual 'Table N' text without Caption style or SEQ field",
            ))
        else:
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
        host_para_idx, prev_elem, next_elem = _find_image_context(doc, rel)
        status = "missing"
        for elem in (prev_elem, next_elem):
            if elem is None or not elem.tag.endswith("}p"):
                continue
            s = _caption_status(elem, _FIGURE_LABEL_RE, "figure", style_names)
            if s == "valid":
                status = "valid"
                break
            if s == "manual":
                status = "manual"
        if status == "manual":
            violations.append(LayoutViolation(
                rule_code="MANUAL_CAPTION",
                severity="MINOR",
                location={"image_index": image_idx - 1, "paragraph_index": host_para_idx},
                message=(
                    f"Image {image_idx} has a manually typed caption. "
                    f"{MANUAL_CAPTION_ACTION}"
                ),
                expected_value="Word caption (References → Insert Caption)",
                actual_value="Manual 'Figure N' text without Caption style or SEQ field",
            ))
        elif status == "missing":
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
    all_violations.extend(check_paragraph_typography(paragraphs, preset, doc=doc))
    all_violations.extend(check_page_margins(sections, preset))
    all_violations.extend(check_heading_hierarchy(paragraphs))
    all_violations.extend(check_media_captions(doc, paragraphs, preset))
    all_violations.extend(run_citation_sensor(doc, paragraphs))

    return all_violations
