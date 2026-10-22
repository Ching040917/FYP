"""PDF export report generator (Phase 1).

Deterministic and offline: reads only persisted audit data — no AI calls,
no document bytes, no network. Every dynamic string is escaped before it
enters ReportLab markup. Only built-in PDF fonts are used (Helvetica plus
the STSong-Light CID font as a fallback for non-WinAnsi text), so no
external font files or PDF programs are required.
"""
import io
import logging
import re
from collections import defaultdict
from xml.sax.saxutils import escape as _xml_escape

logger = logging.getLogger("app.services.pdf_report")

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.graphics.shapes import Drawing, Circle, Line, Polygon, Rect, String
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from app.services.layout_violation import LayoutViolation
from app.services.page_element_rules import PAGE_ELEMENT_RULES, structural_story_label
from app.services.scoring import (
    calculate_weighted_score_detailed,
    select_scoring_contract,
)
from app.services.table_page_resolution import resolve_table_page
from app.services.structural_page_mapping import section_first_rendered_page

# Built-in CID font — renders any Unicode text (incl. Chinese captions)
# without shipping font files. Latin text keeps the Helvetica look.
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

# Restrained semantic colours; meaning is always also expressed in text.
NAVY = colors.HexColor("#173A63")
BLUE = colors.HexColor("#2D6CDF")
INK = colors.HexColor("#243247")
PAPER = colors.HexColor("#F5F7FA")
GREEN = colors.HexColor("#2E7D5B")
AMBER = colors.HexColor("#B7791F")
RED = colors.HexColor("#B42318")
PURPLE = colors.HexColor("#6B5CA5")
MUTED = colors.HexColor("#667085")
LIGHT = colors.HexColor("#E1E6ED")

_MARGIN = 15 * mm
_PAGE_W, _PAGE_H = A4
_LAND_W, _LAND_H = A4[1], A4[0]

# Author/year embedded in deterministic CITATION_MISMATCH messages.
_CITATION_AUTHOR_YEAR = re.compile(r"^Citation '(.+?) \((\d{4}[a-z]?)\)'")


# ---------------------------------------------------------------------------
# Text safety helpers
# ---------------------------------------------------------------------------

def _clean(text) -> str:
    """Escape arbitrary DB/AI text for ReportLab Paragraph markup."""
    if text is None:
        return ""
    s = str(text)
    s = "".join(ch for ch in s if ch >= " " or ch in "\n\r\t")
    return _xml_escape(s).replace("\n", "<br/>")


def _student_clean(text) -> str:
    """Student-facing wording cleanup for the exported PDF.

    The API keeps raw deterministic messages untouched; the PDF is a
    student-facing surface, so banned tokens (`!=`, `->`, `=>`, `SEQ field`,
    `numPr`) never appear and units are normalized ("15pt" → "15 pt").
    """
    if text is None:
        return ""
    s = str(text)
    s = s.replace("!=", "is not").replace("->", "to").replace("=>", "to")
    s = re.sub(r"\bSEQ\s+field\b", "automatic caption numbering", s, flags=re.IGNORECASE)
    s = re.sub(r"\bnumPr\b", "list formatting", s, flags=re.IGNORECASE)
    s = re.sub(r"\bdocPr@descr\b", "image description", s, flags=re.IGNORECASE)
    s = re.sub(r"(\d)pt\b", r"\1 pt", s, flags=re.IGNORECASE)
    s = re.sub(r"(\d)in\b", r"\1 in", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _font_for(text: str) -> str:
    """Helvetica when WinAnsi covers the text, STSong-Light otherwise."""
    try:
        str(text).encode("cp1252")
        return "Helvetica"
    except UnicodeEncodeError:
        return "STSong-Light"


def _p(text, size=9.5, font="Helvetica", color=INK, leading=None, **kw):
    """Paragraph with font auto-picked from the text content."""
    safe = _clean(text)
    name = "STSong-Light" if _font_for(safe) == "STSong-Light" else font
    style = ParagraphStyle(
        f"auto-{name}-{size}",
        fontName=name,
        fontSize=size,
        leading=leading or size * 1.35,
        textColor=color,
        alignment=kw.get("alignment", 0),
        keepWithNext=kw.get("keepWithNext", False),
    )
    return Paragraph(safe, style)




def _section(text, size=11):
    return _p(text, size=size, font="Helvetica-Bold", color=NAVY,
              leading=size * 1.3, keepWithNext=True)


# ---------------------------------------------------------------------------
# Filename helpers
# ---------------------------------------------------------------------------

def sanitise_filename(name: str, fallback: str = "document") -> str:
    """ASCII-safe filename base: keep [A-Za-z0-9._-], collapse junk."""
    base = re.sub(r"[^A-Za-z0-9._-]", "_", (name or "").strip())
    base = re.sub(r"_+", "_", base).strip("._")[:80].rstrip(".-")
    return base or fallback


def build_export_filename(doc_name: str) -> str:
    """Safe attachment filename: `<sanitized-document>-compliance-report.pdf`."""
    base = (doc_name or "").strip()
    if base.lower().endswith(".docx"):
        base = base[:-5]
    elif base.lower().endswith(".doc"):
        base = base[:-4]
    return f"{sanitise_filename(base)}-compliance-report.pdf"


# ---------------------------------------------------------------------------
# Narrow finding presentation helpers
# ---------------------------------------------------------------------------

_REQUIRED_ACTIONS = {
    "FONT_CONSISTENCY": "Use the required font family for every body-text run.",
    "FONT_SIZE": "Set the font size to the required value (body 12 pt, headings per SUC hierarchy).",
    "LINE_SPACING": "Set line spacing to the required value (1.5 for body, 1.0 for headings).",
    "SPACE_BEFORE": "Set the required space before this paragraph.",
    "SPACE_AFTER": "Set the required space after this paragraph.",
    "ALIGNMENT": "Align this paragraph as required (justified body, left headings).",
    "MARGIN_LEFT": "Set the left page margin to the required width (1.5 in).",
    "MARGIN_RIGHT": "Set the right page margin to the required width (1.0 in).",
    "MARGIN_TOP": "Set the top page margin to the required width (1.0 in).",
    "MARGIN_BOTTOM": "Set the bottom page margin to the required width (1.0 in).",
    "HEADING_HIERARCHY": "Restructure headings so no level is skipped and the outline starts at Heading 1.",
    "TABLE_CAPTION_MISSING": "Add a caption above or below the table starting with 'Table N: '.",
    "IMAGE_CAPTION_MISSING": "Add a caption below the image starting with 'Figure N: '.",
    "IMAGE_ALT_TEXT_MISSING": "Add a concise alt-text description to the image for screen readers.",
    "MANUAL_CAPTION": "Use Word's References → Insert Caption feature so the label and numbering remain consistent.",
    "CITATION_MISMATCH": "Add the matching APA 7 reference entry or correct the in-text citation.",
    "CITATION_REFERENCE_MISMATCH": (
        "Correct the year in the in-text citation or in the Reference List entry so both "
        "state the same year."
    ),
    "CITATION_YEAR_SUFFIX_MISMATCH": (
        "Add the matching year suffix (a, b, ...) to the in-text citation or correct it in "
        "the Reference List entry."
    ),
    "CITATION_REFERENCE_AMBIGUOUS": (
        "Confirm which listed source this citation refers to; initials are not compared."
    ),
    "REFERENCE_NOT_CITED": "Cite this source in the text, or remove the Reference List entry.",
    "REFERENCE_DUPLICATE": "Keep one entry and remove the duplicate.",
    # Reference List FORMATTING rules (Phase 3) — manual corrections only.
    "REFERENCE_HEADING_TEXT": "Rename the Reference List heading to the required wording.",
    "REFERENCE_HEADING_BOLD": "Apply or remove bold on the Reference List heading as required.",
    "REFERENCE_HEADING_ALIGNMENT": "Align the Reference List heading as required.",
    "REFERENCE_SECTION_NEW_PAGE": "Insert a page break before the Reference List heading.",
    "REFERENCE_HANGING_INDENT": (
        "Apply a hanging indent so the first line is flush left and the following lines "
        "are indented by the configured amount."
    ),
    "REFERENCE_SPACE_BEFORE": "Set the required space before these Reference List entries.",
    "REFERENCE_SPACE_AFTER": "Set the required space after these Reference List entries.",
    "REFERENCE_FONT_FAMILY": "Set every Reference List entry to the required font family.",
    "REFERENCE_FONT_SIZE": "Set every Reference List entry to the required font size.",
    "REFERENCE_ALIGNMENT": "Align the Reference List entries as required.",
    "REFERENCE_ORDER": (
        "Move this Reference List entry to the correct alphabetical position "
        "according to the selected profile."
    ),
    "REFERENCE_DOI_FORMAT": (
        "Replace the visible DOI text with the configured canonical format. "
        "Verify the DOI independently because ACA checks presentation only and "
        "does not confirm registration or resolution."
    ),
}


def _hanging_indent_action(expected_value) -> str:
    """Required Action naming the CONFIGURED hanging indent, never a constant.

    `expected_value` is the profile's configured required value (e.g. "0.5in"),
    so the sentence changes with the profile instead of always saying 0.5.
    Falls back to the fixed copy when no value was carried.
    """
    amount = _student_clean(expected_value) if expected_value else ""
    if not amount:
        return _REQUIRED_ACTIONS["REFERENCE_HANGING_INDENT"]
    return (
        f"Apply a {amount} hanging indent so the first line stays at the left margin "
        "and the following lines are indented."
    )


def _reference_format_action(rule_code, expected_value) -> str:
    """Value-driven Required Action for the Reference List formatting rules."""
    if rule_code == "REFERENCE_HANGING_INDENT":
        return _hanging_indent_action(expected_value)
    return _REQUIRED_ACTIONS[rule_code]





# Deterministic citation/reference rules: fixed Required Action copy
# (never a formatting instruction, never AI-generated). The alphabetical
# order review is author-identity only and equally deterministic.
_CITATION_MATCH_RULES = frozenset({
    "CITATION_REFERENCE_MISMATCH",
    "CITATION_YEAR_SUFFIX_MISMATCH",
    "CITATION_REFERENCE_AMBIGUOUS",
    "REFERENCE_NOT_CITED",
    "REFERENCE_DUPLICATE",
    "REFERENCE_ORDER",
})

# Reference List FORMATTING rules (Phase 3). Manual corrections only, with
# the same fixed-copy treatment the citation matching rules get: "change
# 0.25in to 0.5in" does not tell a student what a hanging indent is.
_REFERENCE_FORMAT_RULES = frozenset({
    "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
    "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
    "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
    "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
    "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
    "REFERENCE_DOI_FORMAT",
})

# Reader-facing severities match the audit UI. REVIEW is a manual-review
# flag: never scored, never counted as major or minor.
_SEVERITY_LABEL = {
    "MAJOR": "Major",
    "MINOR": "Minor",
    "REVIEW": "Manual review",
}

# Any historical/unrecognised Violation.severity token renders as this, never
# as the raw snake_case token.
_UNCLASSIFIED_SEVERITY = "Unclassified"

# The three severities that carry panels; anything else is unclassified.
_PANEL_SEVERITIES = ("MAJOR", "MINOR", "REVIEW")

_PROP_NAME = {
    "FONT_CONSISTENCY": "font",
    "FONT_SIZE": "font size",
    "LINE_SPACING": "line spacing",
    "SPACE_BEFORE": "space before",
    "SPACE_AFTER": "space after",
    "ALIGNMENT": "alignment",
    "MARGIN_LEFT": "left margin",
    "MARGIN_RIGHT": "right margin",
    "MARGIN_TOP": "top margin",
    "MARGIN_BOTTOM": "bottom margin",
    "HEADING_HIERARCHY": "heading level",
    "TABLE_CAPTION_MISSING": "table caption",
    "IMAGE_CAPTION_MISSING": "image caption",
    "IMAGE_ALT_TEXT_MISSING": "alt text",
    "MANUAL_CAPTION": "caption",
    "CITATION_MISMATCH": "citation entry",
    "CITATION_REFERENCE_MISMATCH": "citation year",
    "CITATION_YEAR_SUFFIX_MISMATCH": "citation year suffix",
    "CITATION_REFERENCE_AMBIGUOUS": "citation match",
    "REFERENCE_NOT_CITED": "in-text citation",
    "REFERENCE_DUPLICATE": "Reference List entry",
    "REFERENCE_ORDER": "Reference List entry",
}

# Plain-language rule titles shared with the audit UI's presentation contract.
_RULE_NAME = {
    "FONT_CONSISTENCY": "Font family does not match",
    "FONT_SIZE": "Font size does not match",
    "LINE_SPACING": "Line spacing does not match",
    "SPACE_BEFORE": "Space before the paragraph does not match",
    "SPACE_AFTER": "Space after the paragraph does not match",
    "ALIGNMENT": "Paragraph alignment does not match",
    "MARGIN_LEFT": "Left page margin does not match",
    "MARGIN_RIGHT": "Right page margin does not match",
    "MARGIN_TOP": "Top page margin does not match",
    "MARGIN_BOTTOM": "Bottom page margin does not match",
    "HEADING_HIERARCHY": "Heading levels skip a step",
    "TABLE_CAPTION_MISSING": "Table caption is missing",
    "IMAGE_CAPTION_MISSING": "Figure caption is missing",
    "IMAGE_ALT_TEXT_MISSING": "Figure alternative text is missing",
    "MANUAL_CAPTION": "Caption was typed instead of inserted",
    "CITATION_MISMATCH": "Citation has no matching Reference List entry",
    "CITATION_REFERENCE_MISMATCH": "Citation year does not match the Reference List entry",
    "CITATION_YEAR_SUFFIX_MISMATCH": "Citation is missing or uses the wrong year suffix",
    "CITATION_REFERENCE_AMBIGUOUS": "Citation could match more than one entry",
    "REFERENCE_NOT_CITED": "Reference List entry is not cited in the text",
    "REFERENCE_DUPLICATE": "Duplicate Reference List entry",
    "REFERENCE_ORDER": "Reference List is not in alphabetical order",
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
    "REFERENCE_DOI_FORMAT": "Reference DOI format does not match",
    "HEADER_CONTENT_REQUIRED": "Header needs review",
    "FOOTER_CONTENT_REQUIRED": "Footer needs review",
    "PAGE_NUMBER_FIELD_REQUIRED": "Page number needs review",
}


def _rule_name(code: str) -> str:
    return _RULE_NAME.get(code, str(code).replace("_", " ").strip().capitalize() or "Unclassified finding")


def _severity_label(severity: str) -> str:
    """Reader-facing severity label; unknown tokens never print raw."""
    return _SEVERITY_LABEL.get(severity, _UNCLASSIFIED_SEVERITY)


def _page_element_display(v):
    """Friendly display copy derived from the saved outcome, never persisted."""
    location = v.location or {}
    kind = {"header": "header", "footer": "footer", "either": "header or footer"}.get(
        location.get("story_type"), "header or footer",
    )
    state = location.get("evidence_state")
    if state == "unresolved":
        current = "ACA could not check this requirement from the supported document content."
    elif v.rule_code == "PAGE_NUMBER_FIELD_REQUIRED":
        current = "No page-number field was found in the selected header or footer."
    elif state == "empty":
        current = f"The normal-pages {kind} has no text or supported field."
    else:
        current = f"No {kind} is defined for normal pages in this section."
    if v.rule_code == "PAGE_NUMBER_FIELD_REQUIRED":
        required = f"A page-number field in this section’s normal-pages {kind}."
        change = "insert a page-number field if needed"
    else:
        required = f"Text or a supported field in this section’s normal-pages {kind}."
        change = "add text or a supported field if needed"
    action = f"In Word, check this section’s {kind}"
    if state != "unresolved":
        action += f" and {change}"
    action += ". Verify the rendered document manually."
    return current, required, action


def _citation_action(v) -> str:
    """Author-specific Required Action for CITATION_MISMATCH.

    Never says "Change citation entry from X to Y".  Uses the deterministic
    personalised correction pattern (same wording as _build_personalised_correction
    in ai_citation.py) so Garcia and Lee get distinct, correct instructions.
    """
    author, year = None, None
    if v.message:
        m = _CITATION_AUTHOR_YEAR.match(v.message.strip())
        if m:
            author, year = m.group(1), m.group(2)
    target = f"{author} ({year})" if author and year else "this citation"
    return (
        f"Add a matching References entry for {target}, or correct or remove "
        "the in-text citation if it refers to the wrong source."
    )


_LOCATION_KEYS = (
    ("paragraph_index", "Paragraph {n}"),
    ("section_index", "Section {n}"),
    ("table_index", "Table {n}"),
    ("image_index", "Figure {n}"),
)


# The authoritative role the classifier assigns to the Reference List
# heading. The heading usually carries no `heading_level` (it is styled as a
# heading but not by a Heading N style), so role is the only reliable signal
# for the "Heading “References”" wording in Phase 6.
_REFERENCE_HEADING_ROLE = "REFERENCES_HEADING"


def _heading_text_for_paragraph(paragraph_index, document_blocks):
    """Return heading text for a paragraph index when it is a heading, else None.

    A numbered heading (`heading_level` 1–6) and the Reference List heading
    (identified by its classified `role`) both count: the References heading
    is a heading to the reader even though Word stores it as body text.
    """
    if paragraph_index is None or not isinstance(document_blocks, list):
        return None
    for block in document_blocks:
        if block.get("index") == paragraph_index:
            level = block.get("heading_level")
            role = block.get("role")
            text = (block.get("text") or "").strip()
            is_heading = (
                (isinstance(level, int) and 1 <= level <= 6)
                or role == _REFERENCE_HEADING_ROLE
            )
            if is_heading and text:
                # Normalize whitespace, truncate to 60 chars for display.
                txt = re.sub(r"\s+", " ", text).strip()
                if len(txt) > 60:
                    txt = txt[:60].rstrip() + "…"
                return txt
            return None
    return None


def location_text(location) -> str:
    """Compact, human-readable location for ordinary users. Never shows Run."""
    if not location:
        return "—"
    if location.get("structural_story") is True:
        return structural_story_label(location)
    # Heading detection requires blocks; without blocks, fall back to paragraph.
    # This simple formatter is used in contexts without block access (e.g.
    # appendix when blocks unavailable). For full page-aware formatting, use
    # friendly_location_text.
    parts = []
    for key, fmt in _LOCATION_KEYS:
        value = location.get(key)
        if value is not None:
            parts.append(fmt.format(n=value + 1))
    return ", ".join(parts) or "—"


def friendly_location_text(location, document_blocks=None) -> str:
    """User-facing location without Run, with Heading/Figure wording."""
    if not location:
        return "Entire document"
    if location.get("structural_story") is True:
        return structural_story_label(location)
    # Table / Figure take precedence over paragraph.
    if location.get("table_index") is not None:
        return f"Table {location['table_index'] + 1}"
    if location.get("image_index") is not None:
        return f"Figure {location['image_index'] + 1}"
    if location.get("section_index") is not None:
        return f"Section {location['section_index'] + 1}"
    para_idx = location.get("paragraph_index")
    if para_idx is not None:
        heading = _heading_text_for_paragraph(para_idx, document_blocks)
        if heading:
            return f'Heading “{heading}”'
        return f"Paragraph {para_idx + 1}"
    return "Entire document"


def occurrence_label(location) -> str:
    """Reader-facing occurrence count for a consolidated finding.

    Empty unless the finding genuinely repeats — a single hit says nothing,
    matching `occurrenceLabel` in frontend/src/lib/friendly-finding.ts. The
    count must never be dropped from the PDF: a consolidated hanging-indent
    finding that affects five entries is five corrections, not one.
    """
    if not isinstance(location, dict):
        return ""
    n = location.get("occurrences")
    if isinstance(n, bool) or not isinstance(n, int) or n <= 1:
        return ""
    return f"{n} occurrences"


def _sanitize_mapping_for_pdf(raw, rendered_pages=None):
    """Validate stored mapping: {paragraph_index: page_number} integers only."""
    if not isinstance(raw, dict):
        return {}
    cleaned = {}
    for k, v in raw.items():
        try:
            ik = int(str(k))
            iv = int(v)
            if ik < 0 or iv < 1:
                continue
            if rendered_pages is not None and iv > rendered_pages:
                continue
            cleaned[str(ik)] = iv
        except (TypeError, ValueError):
            continue
    return cleaned


def _page_for_paragraph(paragraph_index, mapping, rendered_pages=None):
    if paragraph_index is None or not isinstance(mapping, dict):
        return None
    key = str(paragraph_index)
    page = mapping.get(key)
    if page is None:
        return None
    try:
        iv = int(page)
        if 1 <= iv and (rendered_pages is None or iv <= rendered_pages):
            return iv
    except (TypeError, ValueError):
        return None
    return None


def _pages_for_section(section_index, section_metadata, mapping, rendered_pages=None):
    """Derive pages for a section via its paragraph range, if reliable."""
    if section_index is None or not isinstance(section_metadata, list) or not isinstance(mapping, dict):
        return None, None
    for sec in section_metadata:
        if sec.get("section_index") == section_index:
            start = sec.get("start_paragraph_index")
            end = sec.get("end_paragraph_index")
            pages = []
            if start is not None:
                p = _page_for_paragraph(start, mapping, rendered_pages)
                if p is not None:
                    pages.append(p)
            if end is not None and end != start:
                p2 = _page_for_paragraph(end, mapping, rendered_pages)
                if p2 is not None:
                    pages.append(p2)
            if len(pages) == 2 and pages[0] != pages[1]:
                return (min(pages), max(pages))
            if len(pages) == 1:
                return (pages[0], pages[0])
            return None, None
    return None, None


def page_label_for_location(location, mapping, document_blocks=None, section_metadata=None, rendered_pages=None):
    """
    Return a user-facing page label for a single finding location.
    Returns (label, value) e.g. ("Original document page", "12") or
    ("Original document page", "Unavailable") or ("Original document pages", "12–18")
    or ("Starting original document page", "12").
    Physical rendered pages only, one-based, never 0/null/empty.
    """
    if not location:
        return ("Original document page", "Document-wide")
    if location.get("structural_story") is True:
        page = section_first_rendered_page(
            location, section_metadata, mapping, document_blocks, rendered_pages,
        )
        if page is not None:
            return ("Original document page", str(page))
        return ("Structural evidence only", "Rendered page could not be determined")
    # Document-wide: no paragraph/section/table/image
    if all(location.get(k) is None for k in ("paragraph_index", "section_index", "table_index", "image_index")):
        return ("Original document page", "Document-wide")
    # Table / Figure: page from paragraph_index if present
    para_idx = location.get("paragraph_index")
    if location.get("table_index") is not None or location.get("image_index") is not None:
        # TABLE_CAPTION_MISSING carries no paragraph_index; its page is resolved
        # from its same-page boundary anchors (one rule shared with the frontend).
        # Any other case (or unmapped anchors) keeps the historical fallbacks.
        if location.get("table_index") is not None:
            anchor_page = resolve_table_page(
                location,
                lambda idx: _page_for_paragraph(idx, mapping, rendered_pages),
                rendered_pages,
            )
            if anchor_page is not None:
                return ("Original document page", str(anchor_page))
            # No anchor evidence: fall back to a legacy paragraph_index when a
            # historical finding happens to carry one, else "Unavailable".
        page = _page_for_paragraph(para_idx, mapping, rendered_pages)
        if page is not None:
            return ("Original document page", str(page))
        return ("Original document page", "Unavailable")
    # Section: try range via section_metadata
    if location.get("section_index") is not None:
        start_page, end_page = _pages_for_section(location["section_index"], section_metadata, mapping, rendered_pages)
        if start_page is not None and end_page is not None and start_page != end_page:
            return ("Original document pages", f"{start_page}–{end_page}")
        if start_page is not None:
            # Only reliable start page — use Starting... per contract
            return ("Starting original document page", str(start_page))
        return ("Original document page", "Unavailable")
    # Paragraph / Heading
    if para_idx is not None:
        page = _page_for_paragraph(para_idx, mapping, rendered_pages)
        if page is not None:
            return ("Original document page", str(page))
        return ("Original document page", "Unavailable")
    return ("Original document page", "Unavailable")


def _compact_pages(pages):
    """Compact sorted unique pages into '18, 20–21' style."""
    if not pages:
        return ""
    uniq = sorted(set(pages))
    spans = []
    start = prev = uniq[0]
    for n in uniq[1:]:
        if n == prev + 1:
            prev = n
        else:
            spans.append((start, prev))
            start = prev = n
    spans.append((start, prev))
    parts = []
    for a, b in spans:
        if a == b:
            parts.append(str(a))
        else:
            parts.append(f"{a}–{b}")
    return ", ".join(parts)


# Maximum excerpt length for affected text — reuse existing 140 char snippet
# convention but shorter for conciseness; 80 chars is small and documented.
_AFFECTED_TEXT_MAX = 80


def _affected_text_info(violation, document_blocks):
    """
    Return (label, value) for affected content/text, or None.

    - Whole paragraph affected → ("Affected content", "Entire paragraph")
    - Part of paragraph with safe excerpt → ("Affected text", "“excerpt”")
    - Table/Figure/Section → no affected text line (location already specific)
    - Otherwise → None (omit)
    """
    loc = violation.location or {}
    if loc.get("structural_story") is True:
        return None
    # Table/Figure/Section findings are self-contained; no paragraph excerpt.
    if loc.get("table_index") is not None or loc.get("image_index") is not None or loc.get("section_index") is not None:
        return None
    para_idx = loc.get("paragraph_index")
    if para_idx is None:
        return None
    # Determine if whole paragraph is affected.
    has_run = loc.get("run_index") is not None or loc.get("run_indexes") is not None
    # Whole-paragraph rules always affect entire paragraph.
    whole_rules = {"ALIGNMENT", "LINE_SPACING", "SPACE_BEFORE", "SPACE_AFTER", "HEADING_HIERARCHY"}
    if violation.rule_code in whole_rules:
        return ("Affected content", "Entire paragraph")
    if not has_run:
        return ("Affected content", "Entire paragraph")
    # Part of paragraph: try to produce excerpt from document_blocks text.
    if isinstance(document_blocks, list):
        for block in document_blocks:
            if block.get("index") == para_idx:
                raw = (block.get("text") or "").strip()
                if raw:
                    norm = re.sub(r"\s+", " ", raw).strip()
                    if len(norm) >= 8:
                        if len(norm) > _AFFECTED_TEXT_MAX:
                            norm = norm[:_AFFECTED_TEXT_MAX].rstrip() + "…"
                        return ("Affected text", f"“{norm}”")
                break
    # Fallback: try actual_value if it looks like text (not a measurement)
    # Only for non-measurement actuals; otherwise omit.
    return None


def _is_missing_reference_section(location) -> bool:
    """True for the document-wide "no References section" citation finding.

    Identified by the explicit flag the sensor sets — never by a missing
    paragraph index, which would also match findings with no location.
    """
    loc = location or {}
    return isinstance(loc, dict) and loc.get("missing_references_section") is True


def _pdf_finding_action(v, audit=None) -> str | None:
    """Resolve supported PDF guidance from saved evidence, never a guessed repair."""
    code = v.rule_code
    location = v.location or {}
    if v.severity == "REVIEW" and location.get("structural_story") is True:
        kind = {"header": "header", "footer": "footer", "either": "header or footer"}.get(
            location.get("story_type"), "header or footer")
        if location.get("evidence_state") == "unresolved":
            return f"Review the {kind} in Word; supported evidence could not verify this requirement."
        if code == "PAGE_NUMBER_FIELD_REQUIRED":
            return f"Review the {kind} in Word; insert an automatic page number if required."
        return f"Review the {kind} in Word; add the required content if needed."
    if code in PAGE_ELEMENT_RULES:
        return _page_element_display(v)[2]
    if code == "CITATION_MISMATCH":
        if _is_missing_reference_section(location):
            return "Add a References section and list every source cited in the text."
        return _citation_action(v)
    if code in _CITATION_MATCH_RULES:
        return _REQUIRED_ACTIONS[code]

    required = _student_clean(v.expected_value)
    current = _student_clean(v.actual_value)
    if code in _REFERENCE_FORMAT_RULES:
        return _reference_format_action(code, required)
    if code in ("TABLE_CAPTION_MISSING", "IMAGE_CAPTION_MISSING"):
        label, obj = ("Table", "table") if code == "TABLE_CAPTION_MISSING" else ("Figure", "image")
        return (
            f"In Word, use References → Insert Caption to add a {label} caption for this {obj}. "
            f"Write a description of the actual {obj}; do not insert <description> literally."
        )
    if code == "MANUAL_CAPTION":
        return (
            "Use Word’s References → Insert Caption feature for this object, preserving the "
            "existing description and replacing the typed label and number with an automatic caption."
        )
    if code == "IMAGE_ALT_TEXT_MISSING":
        return "Add a concise description of the image in Word’s Alt Text pane for screen-reader users."
    if code == "HEADING_HIERARCHY":
        return (
            "Review the heading structure at this location. Use Heading 1 for the first heading "
            "and consecutive levels thereafter; add or restyle headings as appropriate to the document structure."
        )

    # Non-scalar _PROP_NAME rules have already taken their dedicated branches.
    if code in _PROP_NAME:
        prop = _PROP_NAME[code]
        if not required:
            return (
                f"Review the saved {prop} finding in the original document; "
                "the required value was not recorded."
            )
        if code in ("FONT_CONSISTENCY", "FONT_SIZE"):
            # layout_engine emits pairs as "Times New Roman 12pt, Calibri 11pt".
            # Recognize that presentation, not an invented schema for arbitrary text.
            pair = r"[^,]+? \d+(?:\.\d+)? pt"
            message = v.message or ""
            choice = (
                re.fullmatch(rf"{pair}(?:, {pair})*", required) is not None
                or "allowed font-and-size combination" in message
                or "not an allowed combination" in message
                or any(separator in required.lower() for separator in (",", ";", " or ", " / "))
            )
            scalar_size = re.fullmatch(r"\d+(?:\.\d+)?(?: pt)?", required) is not None
            if choice or (code == "FONT_SIZE" and not scalar_size) or (
                code == "FONT_CONSISTENCY" and scalar_size
            ):
                return (
                    "Choose a permitted font-and-size combination from the saved Required value "
                    "and apply it to the affected text at this location."
                )
        loc = friendly_location_text(location, getattr(audit, "document_blocks", None))
        target = (
            f"for the affected text at {loc}"
            if code in ("FONT_CONSISTENCY", "FONT_SIZE") else f"at {loc}"
        )
        if current:
            return f"Change the {prop} {target} from {current} to {required}."
        return f"Set the {prop} {target} to {required}."

    if code in _REQUIRED_ACTIONS:
        return _REQUIRED_ACTIONS[code]
    if required:
        return "Review the saved requirement at this location before making changes."
    return None


def split_apa_suggestion(suggestion: str) -> dict:
    """Split the persisted APA guidance blob into named sections."""
    result = {"correction": "", "checklist": "", "template": "", "warning": ""}
    if not suggestion:
        return result
    current = None
    for part in suggestion.split("\n\n"):
        part = part.strip()
        if not part:
            continue
        heading = next(
            (h for h in ("Recommended correction", "What to verify", "APA 7 formatting example")
             if part.startswith(h + "\n") or part == h),
            None,
        )
        if heading:
            current = {"Recommended correction": "correction",
                       "What to verify": "checklist",
                       "APA 7 formatting example": "template"}[heading]
            result[current] = part.split("\n", 1)[1].strip() if "\n" in part else ""
        elif current:
            result[current] = (result[current] + "\n" + part).strip()
        else:
            result["correction"] = (result["correction"] + "\n" + part).strip()
    return result



# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------

def _kv_table(rows, label_width=38 * mm):
    """Label/value table; values wrap via Paragraph cells."""
    data = [[_p(k, size=8.5, font="Helvetica-Bold", color=MUTED),
             _p(v, size=9.5)] for k, v in rows]
    table = Table(data, colWidths=[label_width, _PAGE_W - 2 * _MARGIN - label_width])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, colors.HexColor("#D8D5CB")),
    ]))
    return table




def _symbol(kind, color, size=14):
    """Small vector symbols, independent of platform fonts."""
    icon = Drawing(size, size)
    middle = size / 2
    if kind == "major":
        icon.add(Polygon([middle, size - 1, size - 1, 1, 1, 1],
                         strokeColor=color, fillColor=None, strokeWidth=1.2))
        icon.add(Line(middle, 5, middle, 9, strokeColor=color, strokeWidth=1.3))
        icon.add(Circle(middle, 3, 0.7, fillColor=color, strokeColor=color))
    elif kind == "minor":
        icon.add(Rect(2, 2, size - 4, size - 4, fillColor=None,
                      strokeColor=color, strokeWidth=1.2))
        icon.add(Line(5, 5, 9, 9, strokeColor=color, strokeWidth=1.2))
    else:
        icon.add(Circle(middle, middle, middle - 1, fillColor=None,
                        strokeColor=color, strokeWidth=1.2))
        if kind == "score":
            icon.add(Line(3, 7, 6, 4, strokeColor=color, strokeWidth=1.3))
            icon.add(Line(6, 4, 11, 10, strokeColor=color, strokeWidth=1.3))
        else:
            icon.add(String(middle - 1, 3, "i", fontName="Helvetica-Bold",
                            fontSize=10, fillColor=color))
    return icon


def _appendix_frame():
    """Use the same padded landscape frame for layout measurement and output."""
    return Frame(_MARGIN, 18 * mm, _LAND_W - 2 * _MARGIN,
                 _LAND_H - 34 * mm, id="appendix-body")


class _RegisterTable(Table):
    """Keep finding/action association while delegating text splitting to ReportLab."""

    def _listCellGeom(self, value, width, style, *args, **kwargs):
        # ReportLab 4.0.7's in-row splitter passes the first column's width,
        # not the span width. Use guidance's actual displayed width instead.
        width = getattr(style, "registerSpanWidth", width)
        return super()._listCellGeom(value, width, style, *args, **kwargs)

    def _splitCell(self, value, style, oldHeight, newHeight, width):
        width = getattr(style, "registerSpanWidth", width)
        return super()._splitCell(value, style, oldHeight, newHeight, width)

    @staticmethod
    def _flowables(value):
        return list(value) if isinstance(value, (list, tuple)) else [value]

    def _native_split(self, width, height, in_row=False):
        original = self.splitByRow
        try:
            self.splitByRow = 0 if in_row else 1
            parts = super().split(width, height)
        finally:
            self.splitByRow = original
        for part in parts:
            part.splitByRow = original
        return parts

    def _fragment_rows(self, parts):
        """ReportLab duplicates exactly one data row on an in-row split."""
        repeated = self.repeatRows
        count = len(parts[0]._cellvalues)
        split_row = (count + len(parts[1]._cellvalues) - repeated
                     > len(self._cellvalues))
        first = self._register_rows[:count]
        rest = self._register_rows[count - int(split_row):]
        return first, self._register_rows[:repeated] + rest

    def split(self, availWidth, availHeight):
        parts = self._native_split(availWidth, availHeight)
        if len(parts) != 2 or not hasattr(self, "_register_rows"):
            return parts
        first, rest = self._fragment_rows(parts)
        # NOSPLIT prevents a boundary break, but ReportLab may still retry an
        # in-row split inside that same pair. Reject both kinds of break for a
        # pair measured to fit a fresh frame, retaining any preceding findings.
        split_in_row = (len(parts[0]._cellvalues) + len(parts[1]._cellvalues)
                        - self.repeatRows > len(self._cellvalues))
        split_index = len(parts[0]._cellvalues) - int(split_in_row)
        role = self._register_rows[split_index][0]
        comparison_index = None
        if role == "action":
            comparison_index = split_index - 1
        elif (split_in_row and role == "finding"
              and split_index + 1 < len(self._register_rows)
              and self._register_rows[split_index + 1][0] == "action"):
            comparison_index = split_index
        if comparison_index is not None and self._register_rows[comparison_index][0] == "finding":
            header_height = sum(self._rowHeights[:self.repeatRows])
            pair_height = sum(self._rowHeights[comparison_index:comparison_index + 2])
            if header_height + pair_height <= _appendix_frame()._aH:
                if comparison_index == self.repeatRows:
                    return []
                parts = self._native_split(
                    availWidth, sum(self._rowHeights[:comparison_index]))
                if len(parts) != 2:
                    return []
                first, rest = self._fragment_rows(parts)
        headers = self.repeatRows
        # Native row-first splitting prefers the comparison/action boundary,
        # even when the first lines of an oversized Action fit beside it.
        if first[-1][0] == "finding" and rest[headers][0] == "action":
            parts = self._native_split(availWidth, availHeight, in_row=True)
            if len(parts) == 2:
                first, rest = self._fragment_rows(parts)
            if len(parts) != 2 or first[-1][0] != "action":
                if availHeight < _appendix_frame()._aH - 0.01:
                    return []
                # Leave a final comparison fragment for the next fresh frame,
                # where its Action can start. Paragraph splitting retains text.
                action_index = next(i for i, row in enumerate(self._register_rows)
                                    if row == rest[headers])
                style = self._cellStyles[action_index][1]
                guidance = self._flowables(self._cellvalues[action_index][1])
                leading = max((v.style.leading for v in guidance
                               if isinstance(v, Paragraph)), default=12.15)
                minimum = 2 * leading + style.topPadding + style.bottomPadding
                parts = self._native_split(availWidth, availHeight - minimum, in_row=True)
                if len(parts) != 2:
                    return []
                first, rest = self._fragment_rows(parts)
        parts[0]._register_rows = first
        parts[1]._register_rows = rest
        if rest[headers][0] == "action":
            continuation = parts[1]
            continuation._cellvalues[headers][0] = _p(
                "Action (continued)", size=8, font="Helvetica-Bold", color=NAVY)
            context = _p(rest[headers][1], size=8, font="Helvetica-Bold", color=MUTED)
            context._register_context = True
            guidance = [v for v in self._flowables(continuation._cellvalues[headers][1])
                        if not getattr(v, "_register_context", False)]
            continuation._cellvalues[headers][1] = [context] + guidance
            # Added context must be remeasured, not clipped to native heights.
            continuation._argH[headers] = None
            continuation._rowHeights[headers] = None
        return parts


def _report_table(headers, rows, widths, size=8.5, accent=NAVY, title=None, padding=5,
                  action_rows=(), register_contexts=None):
    """Quiet, splittable tables with repeated labels and wrapped cells."""
    header_row = 1 if title else 0
    data = [[_p(title, size=10, font="Helvetica-Bold", color=accent)] + [""] * (len(headers) - 1)] if title else []
    data.append([_p(label, size=8, font="Helvetica-Bold", color=accent) for label in headers])
    data.extend([value if isinstance(value, (Paragraph, Table, list)) else _p(value, size=size)
                 for value in row] for row in rows)
    table_type = _RegisterTable if register_contexts is not None else Table
    table = table_type(data, colWidths=[width * mm for width in widths],
                       repeatRows=header_row + 1, splitInRow=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, header_row), PAPER),
        ("LINEBELOW", (0, header_row), (-1, header_row), 0.8, accent),
        ("ROWBACKGROUNDS", (0, header_row + 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFD")]),
        ("LINEBELOW", (0, header_row + 1), (-1, -1), 0.3, LIGHT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    if title:
        style.append(("SPAN", (0, 0), (-1, 0)))
    for index in action_rows:
        row = header_row + 1 + index
        style.append(("SPAN", (1, row), (-1, row)))
    if register_contexts is not None:
        # Both rows share a finding-ordinal background and one final separator.
        style = [command for command in style
                 if command[0] != "ROWBACKGROUNDS"
                 and not (command[0] == "LINEBELOW" and command[1][1] > header_row)]
        ordinal = -1
        for index in range(len(rows)):
            if index not in action_rows:
                ordinal += 1
            row = header_row + 1 + index
            background = colors.white if ordinal % 2 == 0 else colors.HexColor("#F1F5FA")
            style.append(("BACKGROUND", (0, row), (-1, row), background))
            if index + 1 not in action_rows:
                style.append(("LINEBELOW", (0, row), (-1, row), 0.3, LIGHT))
        table._register_rows = ([("header", "")] * (header_row + 1)
                                + register_contexts)
    table.setStyle(TableStyle(style))
    if register_contexts is not None:
        for index in action_rows:
            row = header_row + 1 + index
            table._cellStyles[row][1].registerSpanWidth = sum(table._colWidths[1:])
        frame = _appendix_frame()
        table.wrap(frame._aW, frame._aH)
        header_height = sum(table._rowHeights[:header_row + 1])
        pairs = []
        for index in action_rows:
            row = header_row + 1 + index
            if header_height + sum(table._rowHeights[row - 1:row + 1]) <= frame._aH:
                pairs.append(("NOSPLIT", (0, row - 1), (-1, row)))
        table.setStyle(TableStyle(pairs))
    return table


def _panel(title, status, rows, manual=False):
    accent = PURPLE if manual else RED
    data = [
        [_symbol("review" if manual else "major", accent),
         _p(title, size=10, font="Helvetica-Bold", color=accent), ""],
        ["", _p(status, size=8, font="Helvetica-Bold", color=accent), ""],
    ]
    data.extend([_p(label, size=8, font="Helvetica-Bold", color=MUTED), "", _p(value, size=9)]
                for label, value in rows)
    # Keep every cell a directly splittable flowable. ReportLab's in-row
    # splitter cannot split nested Tables, even when the nested table wraps.
    table = Table(data, colWidths=[8 * mm, 21 * mm, 151 * mm],
                  repeatRows=2, splitInRow=1)
    style = [
        ("SPAN", (1, 0), (-1, 0)), ("SPAN", (1, 1), (-1, 1)),
        ("NOSPLIT", (0, 0), (-1, 1)),
        ("BACKGROUND", (0, 0), (-1, 0), PAPER),
        ("BACKGROUND", (1, 1), (-1, 1),
         colors.HexColor("#F1EEF8") if manual else colors.HexColor("#FCEFED")),
        ("LINEBEFORE", (0, 0), (0, -1), 2, accent),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    style.extend(("SPAN", (0, index), (1, index)) for index in range(2, len(data)))
    table.setStyle(TableStyle(style))
    return table


def _finding_location(v, audit=None):
    blocks = getattr(audit, "document_blocks", None)
    location = friendly_location_text(v.location, blocks)
    raw_mapping = getattr(audit, "paragraph_page_mapping", None)
    mapping = raw_mapping if (v.location or {}).get("structural_story") is True else _sanitize_mapping_for_pdf(
        raw_mapping, getattr(audit, "rendered_preview_pages", None))
    label, page = page_label_for_location(
        v.location or {}, mapping, blocks, getattr(audit, "section_metadata", None),
        getattr(audit, "rendered_preview_pages", None))
    if page == "Document-wide":
        return location
    return f"{location}\n{label}: {page}"


def _display_values(v):
    if v.rule_code in PAGE_ELEMENT_RULES:
        return _page_element_display(v)[:2]
    clean = str if v.rule_code == "REFERENCE_DOI_FORMAT" else _student_clean
    return clean(v.actual_value or "Not recorded"), clean(v.expected_value or "Not recorded")


def _priority_table(v, audit=None):
    """Evidence-led detail, with no invented location or persisted identifier."""
    blocks = getattr(audit, "document_blocks", None)
    current, required = _display_values(v)
    manual = v.severity == "REVIEW"
    rows = [("Location", _finding_location(v, audit))]
    if not manual:
        rows.append(("Finding", _student_clean(v.message)))
    action = _pdf_finding_action(v, audit)
    structural = (v.location or {}).get("structural_story") is True
    rows.extend([("Found" if manual else "Current", current),
                 ("Expected" if manual else "Required", required)])
    if action:
        rows.append(("Action", action))
    affected = _affected_text_info(v, blocks)
    if affected:
        rows.append(affected)
    if structural:
        evidence = ("Page-level structural evidence; no exact Header/Footer highlight."
                    if "Original document page:" in _finding_location(v, audit) else
                    "Structural evidence only; no exact Header/Footer highlight.")
        if v.rule_code == "PAGE_NUMBER_FIELD_REQUIRED":
            evidence += " A PAGE field is not a typed number; the rendered sequence is not verified."
        rows.append(("Evidence", evidence))
    elif manual:
        rows.append(("Evidence", _student_clean(v.message) or "Saved finding; inspect the original document."))
    status = "Manual review · Unscored" if manual else "Major · Scored"
    if structural and (v.location or {}).get("evidence_state") == "unresolved":
        status += " · Could not verify"
    return _panel(_rule_name(v.rule_code), status, rows, manual=manual)




def _pages_summary_for_group(violations, audit):
    """Compact page list for grouped findings, with availability disclosure."""
    mapping = _sanitize_mapping_for_pdf(
        getattr(audit, "paragraph_page_mapping", None) if audit else None,
        getattr(audit, "rendered_preview_pages", None) if audit else None,
    )
    rendered_pages = getattr(audit, "rendered_preview_pages", None) if audit else None
    sections = getattr(audit, "section_metadata", None) if audit else None
    blocks = getattr(audit, "document_blocks", None) if audit else None
    pages = []
    unavailable = 0
    for v in violations:
        loc = v.location or {}
        if loc.get("structural_story") is True:
            page = section_first_rendered_page(
                loc, sections, getattr(audit, "paragraph_page_mapping", None) if audit else None,
                blocks, rendered_pages,
            )
            if page is None:
                unavailable += 1
            else:
                pages.append(page)
            continue
        pi = loc.get("paragraph_index")
        si = loc.get("section_index")
        if pi is not None:
            p = _page_for_paragraph(pi, mapping, rendered_pages)
            if p is not None:
                pages.append(p)
            else:
                unavailable += 1
        elif si is not None:
            sp, ep = _pages_for_section(si, sections, mapping, rendered_pages)
            if sp is not None and ep is not None:
                if sp != ep:
                    pages.extend(range(sp, ep + 1))
                else:
                    pages.append(sp)
            elif sp is not None:
                pages.append(sp)
            else:
                unavailable += 1
        elif loc.get("table_index") is not None or loc.get("image_index") is not None:
            p = _page_for_paragraph(loc.get("paragraph_index"), mapping, rendered_pages)
            if p is not None:
                pages.append(p)
            else:
                unavailable += 1
        else:
            unavailable += 1
    compact = _compact_pages(pages) if pages else ""
    return compact, unavailable




def _appendix_table(entries, audit=None, title=None):
    """Complete register: severity order and stable saved order within each group."""
    rows = []
    action_rows = []
    register_contexts = []
    for v in entries:
        location = _finding_location(v, audit)
        location = (location.replace("\nOriginal document page: ", " · Original page ")
                    .replace("\nOriginal document pages: ", " · Original pages ")
                    .replace("\nStarting original document page: ", " · First proven original page "))
        occurrences = occurrence_label(v.location)
        if occurrences:
            location += f"\n{occurrences}"
        current, required = _display_values(v)
        status = _severity_label(v.severity)
        if v.severity == "REVIEW":
            status += " · Unscored"
        finding = _rule_name(v.rule_code)
        # The register is a concise factual comparison, not a second detail panel.
        rows.append((status, finding, location, current, required))
        context = f"{finding} — {friendly_location_text(v.location, getattr(audit, 'document_blocks', None))}"
        register_contexts.append(("finding", context))
        action = _pdf_finding_action(v, audit)
        if action and action.strip():
            action_rows.append(len(rows))
            rows.append((_p("Action", size=8, font="Helvetica-Bold", color=NAVY),
                         _p(action, size=9), "", "", ""))
            register_contexts.append(("action", context))
    table = _report_table(("Status", "Finding", "Location", "Current", "Required"),
                          rows, (27, 57, 63, 60, 60), size=8,
                          accent=PURPLE if title == "Manual Review Register" else NAVY,
                          title=title, padding=4, action_rows=action_rows,
                          register_contexts=register_contexts)
    return table


def _coverage_rows(snapshot):
    """Coverage comes only from saved requirements, never current defaults."""
    areas = (
        ("Body text", "body", None), ("Headings", "heading", None),
        ("References", "references", None), ("Citations", "citation_matching", None),
        ("Headers", "headers", "check_header_requirements"),
        ("Footers", "footers", "check_footer_requirements"),
        ("Page numbers", "page_numbers", "check_page_number_requirements"),
        ("Margins", "margins", None),
    )
    labels = {"font_family": "font family", "font_size_pt": "font size",
              "line_spacing": "line spacing", "alignment": "alignment",
              "space_before_pt": "space before", "space_after_pt": "space after",
              "first_line_indent_in": "first-line indent"}
    for area, key, toggle in areas:
        group = snapshot.get(key) if isinstance(snapshot, dict) else None
        if toggle:
            enabled = isinstance(group, dict) and group.get(toggle) is True
            description = "Normal-pages content in each section"
            if key == "page_numbers":
                placement = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}
                description = "Normal-pages PAGE field · Placement: " + placement.get(
                    (group or {}).get("placement"), "Not recorded")
            yield area, "Manual review" if enabled else "Not checked", (
                description if enabled else "Disabled in this Profile"), "None"
            continue
        if not isinstance(group, dict):
            yield area, "Not checked", "Requirements not recorded", "N/A"
            continue
        if key == "references":
            selected = []
            formatting = ("heading_text", "heading_bold", "heading_alignment", "start_on_new_page",
                          "hanging_indent", "line_spacing", "space_before", "space_after",
                          "font_family", "font_size", "alignment")
            if any(group.get(f"check_{name}") is True for name in formatting) or any(
                group.get(name) is not None and group.get(f"check_{name}") is not False
                for name in ("line_spacing", "hanging_indent_in")):
                selected.append("Formatting")
            if group.get("check_reference_order") is True:
                selected.append("Alphabetical order")
            if group.get("check_doi_format") is True:
                selected.append("DOI presentation")
            description = ", ".join(selected)
            enabled = bool(selected)
        elif key == "citation_matching":
            names = {"check_citations_have_references": "citations have references",
                     "check_references_are_cited": "references are cited",
                     "check_author_year_consistency": "author/year consistency",
                     "check_year_suffixes": "year suffixes", "check_duplicate_references": "duplicates"}
            description = ", ".join(label for name, label in names.items() if group.get(name) is True)
            enabled = bool(description)
            if group.get("flag_ambiguous_matches") is True:
                description += ("; " if description else "") + "ambiguous matches: manual"
                if not enabled:
                    yield area, "Manual review", description, "None"
                    continue
        elif key == "margins":
            description = ", ".join(side for side in ("left", "right", "top", "bottom")
                                    if group.get(f"{side}_in") is not None) + " margins"
            enabled = any(group.get(f"{side}_in") is not None for side in ("left", "right", "top", "bottom"))
        else:
            selected = [label for name, label in labels.items() if group.get(name) is not None]
            if group.get("allowed_font_combos") and not any(label.startswith("font") for label in selected):
                selected.insert(0, "allowed font choices")
            description = ", ".join(selected)
            enabled = bool(selected)
        yield area, "Scored" if enabled else "Not checked", (
            description if enabled else "Disabled in this Profile"), "Included" if enabled else "None"


def _append_profile_coverage(story, snapshot):
    story.append(_section("Profile Coverage Matrix"))
    rows = list(_coverage_rows(snapshot))
    story.append(_report_table(("Area", "Status", "Coverage", "Score"), rows, (26, 30, 94, 30), size=8))


def _category_disabled(category, snapshot):
    """Only mark known saved disabled requirements N/A; absent history is unknown."""
    if not isinstance(snapshot, dict):
        return False
    coverage = {row[0]: (row[1], row[3]) for row in _coverage_rows(snapshot)}
    if category == "page_margins":
        return coverage["Margins"] == ("Not checked", "None")
    if category == "heading_hierarchy":
        return all(coverage[area] == ("Not checked", "None") for area in ("Headings", "References"))
    if category in ("font_consistency", "font_size"):
        groups = [snapshot.get(key) for key in ("body", "heading", "references")]
        if not all(isinstance(group, dict) for group in groups):
            return False
        key, toggle = (("font_family", "check_font_family") if category == "font_consistency"
                       else ("font_size_pt", "check_font_size"))
        return not (any(group.get(key) is not None or group.get("allowed_font_combos")
                        for group in groups[:2]) or
                    (groups[2].get(toggle) is True and groups[2].get(key) is not None))
    if category == "paragraph_typography":
        keys = ("line_spacing", "alignment", "space_before_pt", "space_after_pt", "first_line_indent_in")
        groups = [snapshot.get(key) for key in ("body", "heading", "captions", "lists", "references")]
        if not all(isinstance(group, dict) for group in groups):
            return False
        if any(group.get(key) is not None for group in groups[:4] for key in keys):
            return False
        refs = groups[4]
        return not any(refs.get(key) is not None and refs.get(toggle) is not False
                       for key, toggle in (("line_spacing", "check_line_spacing"),
                                           ("hanging_indent_in", "check_hanging_indent"),
                                           ("space_before_pt", "check_space_before"),
                                           ("space_after_pt", "check_space_after"),
                                           ("alignment", "check_alignment")))
    if category == "citation_apa":
        matching, refs = snapshot.get("citation_matching"), snapshot.get("references")
        if not isinstance(matching, dict) or not isinstance(refs, dict):
            return False
        return not (any(value is True for key, value in matching.items() if key.startswith("check_")) or
                    refs.get("check_reference_order") is True or refs.get("check_doi_format") is True)
    # Caption presence/semantics and historical adjustments have no saved off switch.
    return False


def _priority_findings(violations):
    """Major before manual review; saved order is stable, minor never promoted."""
    return ([v for v in violations if v.severity == "MAJOR"] +
            [v for v in violations if v.severity == "REVIEW"])[:3]


def _append_priority_actions(story, violations, audit):
    story.append(Spacer(1, 3 * mm))
    story.append(_section("Attention Required"))
    selected = _priority_findings(violations)
    if not selected:
        story.append(_p("No major or manual-review findings. See the formatting summary for minor findings.",
                        size=9, color=MUTED))
    for v in selected:
        if v.rule_code in PAGE_ELEMENT_RULES:
            action = ("Inspect this section in Word; the supported evidence could not verify the requirement."
                      if (v.location or {}).get("evidence_state") == "unresolved" else
                      ("Inspect normal-pages numbering and insert a PAGE field if needed."
                       if v.rule_code == "PAGE_NUMBER_FIELD_REQUIRED" else
                       "Inspect the normal-pages header/footer and add the required content if needed."))
        elif v.rule_code.startswith("MARGIN_"):
            side = v.rule_code.removeprefix("MARGIN_").lower()
            action = f"Set this section’s {side} margin to {_student_clean(v.expected_value) or 'the saved requirement'}."
        else:
            action = {
                "HEADING_HIERARCHY": "Restore consecutive heading levels in Word.",
                "CITATION_MISMATCH": "Add the missing References entry or correct the citation.",
                "CITATION_REFERENCE_MISMATCH": "Make the citation year match the intended Reference List entry.",
                "CITATION_YEAR_SUFFIX_MISMATCH": "Match the citation’s year suffix to its Reference List entry.",
                "CITATION_REFERENCE_AMBIGUOUS": "Identify the intended source and disambiguate the citation.",
                "TABLE_CAPTION_MISSING": "Insert a Word caption for this table.",
                "IMAGE_CAPTION_MISSING": "Insert a Word caption for this figure.",
                "IMAGE_ALT_TEXT_MISSING": "Add meaningful alternative text to this figure in Word.",
            }.get(v.rule_code, "Apply the saved requirement at this location; see the complete register.")
        accent = RED if v.severity == "MAJOR" else PURPLE
        heading = Table([[_symbol("major" if v.severity == "MAJOR" else "review", accent),
                          _p(f"{_severity_label(v.severity)} · {_rule_name(v.rule_code)}",
                             size=9, font="Helvetica-Bold", color=accent)]],
                        colWidths=[7 * mm, 173 * mm])
        heading.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                    ("TOPPADDING", (0, 0), (-1, -1), 1),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        story.append(KeepTogether([
            heading,
            _p(_finding_location(v, audit).replace("\n", " · "), size=8, color=MUTED),
            _p(action, size=8.5), Spacer(1, 2 * mm),
        ]))


def _minor_frequency(violations):
    """Count saved MINOR finding rows, not runs, occurrences or inferred issues."""
    counts = defaultdict(int)
    for v in violations:
        if v.severity == "MINOR":
            counts[v.rule_code] += 1
    return list(counts.items())


def _append_frequency(story, violations):
    story.append(Spacer(1, 2 * mm))
    story.append(_section("Issue Frequency Summary"))
    counts = _minor_frequency(violations)
    if not counts:
        story.append(_p("No scored minor findings.", size=9, color=MUTED))
        return
    # Two issue/count pairs per row keep the executive page concise.
    pairs = [(_rule_name(code), count) for code, count in counts]
    rows = [(*pairs[index], *(pairs[index + 1] if index + 1 < len(pairs) else ("", "")))
            for index in range(0, len(pairs), 2)]
    story.append(_report_table(("Minor issue", "Count", "Minor issue", "Count"),
                              rows, (73, 17, 73, 17), size=8))


def _formatting_summary_rows(minor, audit):
    groups = defaultdict(list)
    for v in minor:
        groups[(v.rule_code, v.expected_value or "")].append(v)
    rows = []
    for (rule, expected), members in groups.items():
        pages, unavailable = _pages_summary_for_group(members, audit)
        page_text = pages or "Unavailable"
        if pages and unavailable:
            page_text += " · some unavailable"
        observed = list(dict.fromkeys(_display_values(v)[0] for v in members))
        # The compact comparison is bounded; every full value remains in the register.
        observed_text = "; ".join(observed)
        if len(observed_text) > 200:
            observed_text = observed_text[:197].rstrip() + "... (full values in register)"
        rows.append((_rule_name(rule), len(members), page_text, observed_text, _display_values(members[0])[1]))
    return rows


def _formatting_summary(minor, audit):
    return _report_table(("Issue", "Count", "Pages", "Observed", "Required"),
                         _formatting_summary_rows(minor, audit), (55, 14, 27, 43, 41),
                         size=8, accent=AMBER)


def _append_profile_disclosure(story, profile_snapshot) -> None:
    """One immutable requirement per row; no profile resolution or duplicated inventory."""
    story.append(_section("Appendix: Full Profile Requirements"))
    if not isinstance(profile_snapshot, dict):
        story.append(_p("Formatting Profile: Legacy formatting requirements (not recorded).", size=9))
        story.append(_report_table(("Area", "Requirement", "Status"), [
            ("Profile", "Requirements not recorded", "Unknown"),
            ("Headers", "No saved enabled requirement", "Not checked"),
            ("Footers", "No saved enabled requirement", "Not checked"),
            ("Page numbers", "No saved enabled requirement", "Not checked"),
            ("Citation style", "Not recorded", "Unknown"),
        ], (30, 116, 34)))
        return

    name = str(profile_snapshot.get("profile_name") or "Selected profile")
    version = profile_snapshot.get("profile_version")
    identity = f"Formatting Profile: {name}"
    if version is not None:
        identity += f" (v{version})"
    story.append(_p(identity, size=9))
    source = {"built_in": "Built-in", "custom": "Custom"}.get(profile_snapshot.get("profile_source"), "Not recorded")
    story.append(_p(f"Source: {source}", size=9))
    scored, manual, unchecked, policies = [], [], [], []
    properties = (
        ("font_family", "font", ""),
        ("font_size_pt", "font size", " pt"),
        ("line_spacing", "line spacing", ""),
        ("alignment", "alignment", ""),
        ("space_before_pt", "space before", " pt"),
        ("space_after_pt", "space after", " pt"),
        ("first_line_indent_in", "first-line indent", " in"),
        ("bold", "bold", ""),
        ("italic", "italic", ""),
    )

    def formatting_lines(group, label, stored_only=False):
        if not isinstance(group, dict):
            return
        combos = group.get("allowed_font_combos")
        if combos:
            choices = ", ".join(f"{family} {size:g} pt" for family, size in combos)
            scored.append(f"{label} font choices: {choices}")
        for key, title, unit in properties:
            if key not in group:
                continue
            value = group.get(key)
            if value is None:
                if not (combos and key in ("font_family", "font_size_pt")):
                    unchecked.append(f"{label} {title}: Not checked")
            else:
                shown = ("Yes" if value else "No") if isinstance(value, bool) else str(value)
                if stored_only or key in ("bold", "italic"):
                    unchecked.append(f"{label} {title}: {shown}{unit} (stored setting; not checked)")
                else:
                    scored.append(f"{label} {title}: {shown}{unit}")

    for key, label in (("body", "Body"), ("heading", "Headings"),
                       ("captions", "Captions"), ("lists", "Lists")):
        group = profile_snapshot.get(key)
        formatting_lines(group, label)
        if key == "heading" and isinstance(group, dict):
            for level in (1, 2, 3):
                formatting_lines(group.get(f"level_{level}"), f"Heading {level}", stored_only=True)

    margins = profile_snapshot.get("margins") or {}
    sides = [(side, margins.get(f"{side}_in")) for side in ("left", "right", "top", "bottom")]
    for side, value in sides:
        if value is None:
            unchecked.append(f"{side.capitalize()} margin: Not checked")
        else:
            scored.append(f"{side.capitalize()} margin: {value:g} in")

    refs = profile_snapshot.get("references") or {}
    for toggle, value_key, label in (
        ("check_heading_text", "heading_text", "Reference heading"),
        ("check_heading_bold", "heading_bold", "Reference heading bold"),
        ("check_heading_alignment", "heading_alignment", "Aligned Reference heading"),
        ("check_start_on_new_page", None, "References start on a new page"),
        ("check_hanging_indent", "hanging_indent_in", "Hanging indent"),
        ("check_line_spacing", "line_spacing", "Reference line spacing"),
        ("check_space_before", "space_before_pt", "Space before entries"),
        ("check_space_after", "space_after_pt", "Space after entries"),
        ("check_font_family", "font_family", "Reference font"),
        ("check_font_size", "font_size_pt", "Reference font size"),
        ("check_alignment", "alignment", "Reference entry alignment"),
        ("check_reference_order", None, "Alphabetical order"),
        ("check_doi_format", None, "Reference DOI format"),
    ):
        enabled = refs.get(toggle) is True
        if toggle in ("check_line_spacing", "check_hanging_indent") and toggle not in refs:
            enabled = refs.get(value_key) is not None
        value = refs.get(value_key) if value_key else None
        detail = label
        if value_key and value is not None:
            shown = ("Yes" if value else "No") if isinstance(value, bool) else str(value)
            units = {"hanging_indent_in": " in", "space_before_pt": " pt",
                     "space_after_pt": " pt", "font_size_pt": " pt"}.get(value_key, "")
            detail += f": {shown}{units}"
        if enabled and (value_key is None or value is not None):
            scored.append(detail)
        else:
            unchecked.append(detail + (" (stored setting; not checked)" if value is not None else ": Not checked"))
    if "allow_heading_aliases" in refs:
        detail = "Reference heading aliases: " + ("Common alternatives accepted" if refs["allow_heading_aliases"] else "Exact heading required")
        policies.append(("References", detail, "Scope policy"))

    matching = profile_snapshot.get("citation_matching") or {}
    for key, label in (
        ("check_citations_have_references", "Citations have references"),
        ("check_references_are_cited", "References are cited"),
        ("check_author_year_consistency", "Author and year consistency"),
        ("check_year_suffixes", "Year suffixes"),
        ("check_duplicate_references", "Duplicate references"),
    ):
        if matching.get(key) is True:
            scored.append(label)
        elif key in matching:
            unchecked.append(f"{label}: Not checked")
    if matching.get("flag_ambiguous_matches") is True:
        manual.append("Ambiguous citation matches · Manual review only · Unscored")
    elif "flag_ambiguous_matches" in matching:
        unchecked.append("Ambiguous citation matches: Not checked")
    if "allow_personal_communication" in matching:
        policies.append(("Citations", "Personal communication citations: " +
                         ("Allowed without Reference List entries" if matching["allow_personal_communication"]
                          else "No personal-communication exemption"), "Scope policy"))

    requirement_rows = []
    for group_name, toggle, label in (
        ("headers", "check_header_requirements", "Headers"),
        ("footers", "check_footer_requirements", "Footers"),
        ("page_numbers", "check_page_number_requirements", "Page numbers"),
    ):
        group = profile_snapshot.get(group_name) or {}
        if group.get(toggle) is not True:
            unchecked.append(f"{label}: Not checked")
            if group_name == "page_numbers" and "placement" in group:
                placement = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}
                unchecked.append("Page numbers placement: " + placement.get(group["placement"], "Not recorded") +
                                 " (stored setting; not checked)")
            continue
        detail = f"{label}: Manual review only · Unscored"
        if group_name == "page_numbers":
            placement = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}
            detail += f" · Placement: {placement.get(group.get('placement'), 'Header or Footer')}"
        manual.append(detail)

    for status, lines in (("Scored", scored), ("Manual review", manual), ("Not checked", unchecked)):
        for line in lines:
            if line.startswith("Body"):
                area = "Body text"
            elif line.startswith(("Heading", "Headings")):
                area = "Headings"
            elif line.startswith(("Header", "Footer", "Page number")):
                area = "Page Elements"
            elif line.startswith(("Margin", "Left margin", "Right margin", "Top margin", "Bottom margin")):
                area = "Margins"
            elif line.startswith(("Caption", "List")):
                area = "Captions and lists"
            elif any(word in line.lower() for word in ("citation", "cited", "author and year", "year suffix", "duplicate")):
                area = "Citations"
            else:
                area = "References"
            requirement_rows.append((area, line.removesuffix(": Not checked"), status))
    requirement_rows.append(("Citation style", str(profile_snapshot.get("citation_style") or "Not recorded"), "Style basis"))
    for key, label in (("description", "Description"), ("institution_specific", "Institution-specific basis"),
                       ("role_exemptions", "Excluded paragraph roles"), ("table_eligibility", "Table eligibility")):
        if key not in profile_snapshot:
            continue
        value = profile_snapshot[key]
        if isinstance(value, bool):
            value = "Yes" if value else "No"
        elif isinstance(value, (list, tuple)):
            value = ", ".join(str(item).replace("_", " ").capitalize() for item in value) or "None"
        requirement_rows.append(("Profile policy", f"{label}: {value or 'Not recorded'}", "Scope policy"))
    requirement_rows.extend(policies)
    area_order = {area: index for index, area in enumerate((
        "Body text", "Headings", "References", "Citations", "Page Elements", "Margins",
        "Captions and lists", "Citation style", "Profile policy",
    ))}
    requirement_rows.sort(key=lambda row: area_order.get(row[0], len(area_order)))
    story.append(_report_table(("Area", "Requirement", "Status"), requirement_rows,
                              (30, 116, 34), size=8, padding=3))
    if refs.get("check_doi_format") is True:
        story.append(_p("DOI note: The selected profile requires the visible DOI format https://doi.org/<doi>; "
                        "presentation only, not registration or resolution.", size=8, color=MUTED))




def _score_summary(score, major, minor, manual=0):
    cards = (
        ("Score", f"{score} / 100", "Enabled deterministic checks", BLUE, "score", "#EDF3FD"),
        ("Major", str(major), "Scored findings · address first", RED, "major", "#FDF1EF"),
        ("Minor", str(minor), "Scored formatting findings", AMBER, "minor", "#FBF5E9"),
        ("Manual review", str(manual), "Unscored · human judgement", PURPLE, "review", "#F3F0F9"),
    )
    cells = []
    for title, value, label, accent, kind, tint in cards:
        card = Table([[_symbol(kind, accent), _p(title, size=9, font="Helvetica-Bold", color=accent)],
                      [_p(value, size=23, font="Helvetica-Bold", color=NAVY), ""],
                      [_p(label, size=8, color=INK), ""]],
                     colWidths=[8 * mm, 34 * mm])
        card.setStyle(TableStyle([
            ("SPAN", (0, 1), (-1, 1)), ("SPAN", (0, 2), (-1, 2)),
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(tint)),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        cells.append(card)
    table = Table([cells], colWidths=[45 * mm] * 4)
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


class _TotalPagesCanvas(Canvas):
    """Replay page states once; retain each page's actual portrait/landscape size."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._report_pages = []

    def showPage(self):
        self._report_pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._report_pages)
        for state in self._report_pages:
            self.__dict__.update(state)
            width, _ = self._pagesize
            self.saveState()
            self.setFont("Helvetica", 7.5)
            self.setFillColor(MUTED)
            self.drawRightString(width - _MARGIN, 10 * mm, f"Page {self._pageNumber} of {total}")
            self.restoreState()
            Canvas.showPage(self)
        Canvas.save(self)


def _draw_chrome(canvas, doc, page_w, page_h):
    canvas.setPageSize((page_w, page_h))
    canvas.saveState()
    canvas.setStrokeColor(LIGHT)
    canvas.line(_MARGIN, page_h - 12 * mm, page_w - _MARGIN, page_h - 12 * mm)
    canvas.setFillColor(NAVY)
    canvas.setFont("Helvetica-Bold", 8.5)
    canvas.drawString(_MARGIN, page_h - 8 * mm, "ACA Compliance Report")
    profile = str(getattr(doc, "profile_label", "Stored profile"))
    max_width = page_w - 2 * _MARGIN - 115 * mm
    font = _font_for(profile)
    while profile and pdfmetrics.stringWidth(profile, font, 8) > max_width:
        profile = profile[:-1]
    canvas.setFont(font, 8)
    canvas.drawRightString(page_w - _MARGIN, page_h - 8 * mm, profile)
    canvas.setStrokeColor(LIGHT)
    canvas.line(_MARGIN, 14 * mm, page_w - _MARGIN, 14 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(_MARGIN, 10 * mm, "Generated locally · Original DOCX unchanged")
    canvas.restoreState()


def _on_page(canvas, doc):
    _draw_chrome(canvas, doc, _PAGE_W, _PAGE_H)


def _on_landscape(canvas, doc):
    _draw_chrome(canvas, doc, _LAND_W, _LAND_H)


def generate_audit_pdf(audit, violations, citation_issues, profile_snapshot=None) -> bytes:
    """Build the full A4 report as PDF bytes.

    `profile_snapshot` is the STORED per-Audit snapshot dict (optional): the
    report discloses the Formatting Profile name/version, Citation Style,
    margin checks and manual structural requirements. Historical PDFs keep
    their stored snapshot — never a re-resolution.
    """
    reconstructed = [
        LayoutViolation(
            rule_code=v.rule_code,
            severity=v.severity,
            location=v.location or {},
            message=v.message,
            expected_value=v.expected_value,
            actual_value=v.actual_value,
        )
        for v in violations
    ]
    score_result = calculate_weighted_score_detailed(reconstructed)
    breakdown_items = list(score_result.breakdown)

    # Historical scoring-contract selection (completed audits only): the
    # stored score is immutable and may have been produced under the
    # pre-fix spacing contract, whose deduction hid from the visible
    # breakdown. Match the stored score against BOTH contracts over the
    # persisted findings; a confirmed legacy audit gets the
    # presentation-only "Legacy spacing adjustment" row so the table
    # explains the STORED score, not a fresh recomputation.
    display_score = score_result.total
    consistency_note = None
    if audit.status == "completed" and getattr(audit, "weighted_score", None) is not None:
        display_score = audit.weighted_score
        legacy_result = calculate_weighted_score_detailed(
            reconstructed, legacy_spacing=True
        )
        selection = select_scoring_contract(
            audit.weighted_score, score_result, legacy_result
        )
        if selection.status == "legacy_spacing" and selection.legacy_row:
            breakdown_items.append(selection.legacy_row)
        elif selection.status == "inconsistent":
            # Never mislabel an unexplained mismatch as legacy spacing.
            logger.warning(
                "Score consistency mismatch audit_id=%s stored=%s "
                "current=%s legacy=%s",
                audit.id,
                audit.weighted_score,
                score_result.total,
                legacy_result.total,
            )
        consistency_note = selection.note

    story = []
    story.append(_p("Executive Summary", size=23, font="Helvetica-Bold", color=NAVY, leading=28))
    story.append(_p("Academic Compliance Report", size=10, color=MUTED))
    story.append(Spacer(1, 3 * mm))

    report_date = audit.completed_at or audit.created_at
    story.append(_kv_table([
        ("Document", audit.filename),
        ("Report Date", report_date.strftime("%d %b %Y, %I:%M %p UTC") if report_date else "Unavailable"),
        ("Audit status", {"completed": "Completed", "processing": "Processing", "failed": "Failed"}.get(
            audit.status, "Not recorded")),
        ("Profile", (str(profile_snapshot.get("profile_name") or "Selected profile") +
                     (f" (v{profile_snapshot['profile_version']})" if profile_snapshot.get("profile_version") is not None else ""))
         if isinstance(profile_snapshot, dict) else "Not recorded"),
        ("Profile source", {"built_in": "Built-in", "custom": "Custom"}.get(
            profile_snapshot.get("profile_source"), "Not recorded")
         if isinstance(profile_snapshot, dict) else "Not recorded"),
    ]))
    story.append(Spacer(1, 4 * mm))

    story.append(_score_summary(
        display_score, score_result.major_count, score_result.minor_count,
        sum(v.severity == "REVIEW" for v in violations),
    ))
    story.append(Spacer(1, 2 * mm))
    story.append(_p(
        f"Compliance Score (enabled checks): {display_score}/100. Only enabled deterministic "
        "formatting and citation checks contribute; this is not an assessment of academic quality.",
        size=8.5, color=MUTED,
    ))
    story.append(_p("Manual review findings are unscored and do not affect the score.",
                    size=8.5, color=MUTED))
    if consistency_note:
        # Safe historical-consistency disclosure. Plain reader-facing
        # language: no internal rule codes, bucket names, or version
        # identifiers. The stored score is never rewritten.
        story.append(Spacer(1, 2 * mm))
        story.append(_p(consistency_note, size=8.5, color=MUTED))
    if not violations:
        story.append(_p("All enabled checks passed.", size=9.5, font="Helvetica-Bold", color=GREEN))
        story.append(_p(
            "No issues were detected by the enabled deterministic checks. This does not "
            "certify that the document is academically correct in every respect.",
            size=8.5, color=MUTED,
        ))
        story.append(Spacer(1, 2 * mm))

    _append_priority_actions(story, violations, audit)
    _append_frequency(story, violations)
    story.append(PageBreak())
    _append_profile_coverage(story, profile_snapshot)
    story.append(Spacer(1, 4 * mm))

    # ---- Category Performance (unchanged scoring facts) ----
    story.append(_section("Category Performance"))
    story.append(Spacer(1, 2 * mm))
    break_rows = []
    for item in breakdown_items:
        label = item.label
        if item.category == "citation_apa":
            label = "APA Citations"
        disabled = (_category_disabled(item.category, profile_snapshot)
                    and item.major == 0 and item.minor == 0 and item.deduction == 0)
        break_rows.append((label, f"{item.major} major · {item.minor} minor", item.deduction,
                           f"N/A · Not checked (stored {item.remaining})" if disabled else item.remaining))
    story.append(_report_table(("Category", "Findings", "Deducted", "Result"),
                              break_rows, (64, 46, 24, 46)))
    story.append(Spacer(1, 4 * mm))

    # ---- Major Priority Findings ----
    if any(v.severity == "MAJOR" for v in violations):
        story.append(_section("Major Priority Findings"))
        story.append(Spacer(1, 2 * mm))
    major = [v for v in violations if v.severity == "MAJOR"]
    minor = [v for v in violations if v.severity == "MINOR"]
    review = [v for v in violations if v.severity == "REVIEW"]
    # Violation.severity carries no CheckConstraint, so a historical or
    # malformed token is reachable. Without this partition such a finding would
    # be counted in the total below yet rendered nowhere.
    unclassified = [v for v in violations if v.severity not in _PANEL_SEVERITIES]
    if violations:
        summary = (
            f"{len(violations)} deterministic finding(s): {len(major)} major (shown individually), "
            f"{len(minor)} minor (grouped by rule code and expected value)"
        )
        if review:
            summary += f", {len(review)} for manual review (never scored)"
        if unclassified:
            summary += (
                f", {len(unclassified)} unclassified "
                f"(historical severity, never scored)"
            )
        summary += ". Findings are rule-based; AI guidance below is advisory only."
        story.append(_p(summary, size=8.5, color=MUTED))
        story.append(Spacer(1, 2 * mm))

        for v in major:
            story.append(_priority_table(v, audit))
            story.append(Spacer(1, 3 * mm))

    # ---- Citation Guidance ----
    if citation_issues:
        story.append(Spacer(1, 3 * mm))
        story.append(_section("Citation Guidance"))
        story.append(Spacer(1, 2 * mm))
        shared_checklists = []
        shared_templates = []
        shared_warnings = []
        for issue in citation_issues:
            parts = split_apa_suggestion(issue.suggestion)
            story.append(_p(f"Paragraph {issue.paragraph_index + 1}", size=9.5, font="Helvetica-Bold", color=NAVY))
            if issue.text_snippet:
                story.append(_p(f"'{issue.text_snippet}'", size=9, color=MUTED))
            story.append(_p(_student_clean(issue.message), size=9.5))
            if parts["correction"]:
                story.append(_p("AI-assisted guidance", size=8.5, font="Helvetica-Bold", color=GREEN))
                if issue.confidence is not None:
                    story.append(_p("Human verification required", size=8.5, color=MUTED))
                story.append(_p(parts["correction"], size=9.5))
            if parts["checklist"] and parts["checklist"] not in shared_checklists:
                shared_checklists.append(parts["checklist"])
            if parts["template"] and parts["template"] not in shared_templates:
                shared_templates.append(parts["template"])
            if parts["warning"] and parts["warning"] not in shared_warnings:
                shared_warnings.append(parts["warning"])
            story.append(Spacer(1, 2 * mm))

        story.append(_section("APA 7 Reference Checklist and Templates"))
        story.append(Spacer(1, 2 * mm))
        if shared_checklists:
            story.append(_p("Verify every corrected citation against this checklist:", size=9.5, font="Helvetica-Bold"))
            for checklist in shared_checklists:
                for line in checklist.split("\n"):
                    story.append(_p(line, size=9.5))
        story.append(Spacer(1, 2 * mm))
        if shared_templates:
            story.append(_p("Formatting examples (placeholders — never invented details):", size=9.5, font="Helvetica-Bold"))
            for template in shared_templates:
                for line in template.split("\n"):
                    story.append(_p(line, size=9, color=INK))
        for warning in shared_warnings:
            story.append(Spacer(1, 2 * mm))
            story.append(_p(f"Note: {warning}", size=8.5, color=MUTED))


    # ---- Manual Review Findings ----
    # REVIEW is a manual-review flag: never scored, never counted, but it must
    # still get an individual panel so the reader is not left with a bare
    # register row and no explanation.
    if review:
        story.append(Spacer(1, 3 * mm))
        story.append(KeepTogether([
            _section("Manual Review Findings"),
            _p("These findings require manual review and do not affect the score.", size=9, color=MUTED),
            _priority_table(review[0], audit),
        ]))
        story.append(Spacer(1, 3 * mm))
        for v in review[1:]:
            story.append(KeepTogether([_priority_table(v, audit)]))
            story.append(Spacer(1, 3 * mm))
    if minor:
        story.append(Spacer(1, 3 * mm))
        story.append(_section("Formatting Issue Summary"))
        story.append(_p("Grouped by saved rule and required value; counts are finding rows. "
                        "All observed values and locations appear in the complete register.", size=8, color=MUTED))
        story.append(_formatting_summary(minor, audit))


    # Complete registers precede the single requirements inventory and final scope.
    if violations:
        story.append(NextPageTemplate("appendix"))
        story.append(PageBreak())
        story.append(_section("Appendix — Findings Register"))
        story.append(_p(
            "Order: Major findings in saved order, then Minor findings grouped by saved rule and "
            "required value (first appearance; saved order within each group), then historical "
            "unclassified findings. Manual reviews follow in their own register in saved order. "
            "Counts represent saved findings; consolidated occurrence counts are retained. "
            "Actions are recommended user steps, not automatic fixes. Available guidance is "
            "repeated beside each finding, including findings detailed earlier. If no supported "
            "guidance is available, no Action row is shown. For repeated findings, check each "
            "recorded occurrence.",
            size=8.5, color=MUTED))
        minor_groups = defaultdict(list)
        for v in minor:
            minor_groups[(v.rule_code, v.expected_value or "")].append(v)
        scored = major + [v for group in minor_groups.values() for v in group] + unclassified
        if scored:
            story.append(_appendix_table(scored, audit, title="Scored and Historical Findings Register"))
        if review:
            story.append(Spacer(1, 3 * mm))
            story.append(_appendix_table(review, audit, title="Manual Review Register"))
        story.append(NextPageTemplate("main"))
        story.append(PageBreak())
    else:
        story.append(PageBreak())
    # ---- Document Statistics ----
    story.append(Spacer(1, 3 * mm))
    story.append(_section("Document Statistics"))
    story.append(Spacer(1, 2 * mm))
    stats = [
        ("Paragraphs", audit.paragraph_count),
        ("Headings", audit.heading_count),
        ("Tables", audit.table_count),
        ("Images", audit.image_count),
        ("Sections", audit.section_count),
        ("Words", audit.word_count),
    ]
    story.append(_report_table(("Metric", "Value", "Metric", "Value"), [
        (stats[index][0], stats[index][1] if stats[index][1] is not None else "Unavailable",
         stats[index + 1][0], stats[index + 1][1] if stats[index + 1][1] is not None else "Unavailable")
        for index in range(0, len(stats), 2)
    ], (45, 45, 45, 45)))

    _append_profile_disclosure(story, profile_snapshot)
    scope = [Spacer(1, 5 * mm), _section("Scope, Limitations and Privacy")]
    for label, text in (
        ("Audit scope", "Generated locally from persisted audit data. Enabled deterministic formatting and "
         "citation checks use the immutable saved Profile; this report is not a new audit. "
         f"Saved deployment mode: {getattr(audit, 'deploy_mode', None) or 'Not recorded'}. "
         "Optional cloud-assisted guidance requires explicit opt-in."),
        ("Manual review", "Manual-review findings are unscored. Disabled requirements are not evaluated."),
        ("Structural evidence", "Checks stored Normal-pages definitions in every document section when enabled. "
         "First-page and even-page definitions are not checked. Structural page mapping does not establish "
         "exact geometry or rendered visibility; unsupported evidence remains unresolved."),
        ("Page numbering", "A PAGE field is not a typed number. The rendered sequence, restarts and numbering "
         "continuity are not verified."),
        ("Content limits", "Writing quality, academic merit and factual accuracy are not assessed. Inline run-level font overrides "
         "may not be fully captured. AI-assisted guidance is advisory only; it never changes findings or scores. "
         "Verify suggestions against the official APA 7 manual."),
        ("Local privacy", "The original Word file is not stored or modified. Extracted paragraph text may be stored "
         "in the local audit database for preview and history. This PDF excludes the full document text."),
    ):
        scope.append(_p(label, size=9, font="Helvetica-Bold", color=NAVY, keepWithNext=True))
        scope.append(_p(text, size=8.5))
        scope.append(Spacer(1, 2 * mm))
    story.append(KeepTogether(scope))

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=_MARGIN,
        rightMargin=_MARGIN,
        topMargin=16 * mm,
        bottomMargin=18 * mm,
        title=build_export_filename(audit.filename),
        author="Academic Compliance Auditor",
    )
    doc.profile_label = (
        str(profile_snapshot.get("profile_name") or "Selected profile")
        if isinstance(profile_snapshot, dict) else "Profile not recorded"
    )
    doc.addPageTemplates([
        PageTemplate(id="main", frames=[Frame(
            _MARGIN, 18 * mm, _PAGE_W - 2 * _MARGIN, _PAGE_H - 34 * mm, id="body",
        )], onPage=_on_page),
        PageTemplate(id="appendix", pagesize=(_LAND_W, _LAND_H),
                     frames=[_appendix_frame()], onPage=_on_landscape),
    ])
    doc.build(story, canvasmaker=_TotalPagesCanvas)
    return buf.getvalue()
