"""PDF export report generator (Phase 1).

Deterministic and offline: reads only persisted audit data — no AI calls,
no document bytes, no network. Every dynamic string is escaped before it
enters ReportLab markup. Only built-in PDF fonts are used (Helvetica plus
the STSong-Light CID font as a fallback for non-WinAnsi text), so no
external font files or PDF programs are required.
"""
import io
import re
from collections import defaultdict
from datetime import datetime
from xml.sax.saxutils import escape as _xml_escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
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
from app.services.scoring import calculate_weighted_score_detailed, grade_for

# Built-in CID font — renders any Unicode text (incl. Chinese captions)
# without shipping font files. Latin text keeps the Helvetica look.
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

# Manuscript Review Desk palette (light-first).
NAVY = colors.HexColor("#1E3A5F")
INK = colors.HexColor("#1F2328")
PAPER = colors.HexColor("#F7F7F4")
GREEN = colors.HexColor("#1F7A4D")
RED = colors.HexColor("#B3261E")
MUTED = colors.HexColor("#5B6470")
LIGHT = colors.HexColor("#E7E4DA")
_PANEL_BG = colors.HexColor("#F3F1EA")
_PANEL_ACTION_BG = colors.HexColor("#E9E6DC")
_PANEL_BORDER = colors.HexColor("#BFBBB0")

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
    name = font if font != "Helvetica" else _font_for(safe)
    style = ParagraphStyle(
        f"auto-{name}-{size}",
        fontName=name,
        fontSize=size,
        leading=leading or size * 1.35,
        textColor=color,
        alignment=kw.get("alignment", 0),
    )
    return Paragraph(safe, style)


def _heading(text, size=13):
    return _p(text, size=size, font="Helvetica-Bold", color=NAVY, leading=size * 1.3)


def _section(text, size=11):
    return _p(text, size=size, font="Helvetica-Bold", color=NAVY, leading=size * 1.3)


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
    "CITATION_MISMATCH": "Add the matching APA 7 reference entry or correct the in-text citation.",
}

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
    "CITATION_MISMATCH": "citation entry",
}

_RULE_NAME = {
    "FONT_CONSISTENCY": "Font Consistency",
    "FONT_SIZE": "Font Size",
    "LINE_SPACING": "Line Spacing",
    "SPACE_BEFORE": "Space Before",
    "SPACE_AFTER": "Space After",
    "ALIGNMENT": "Alignment",
    "MARGIN_LEFT": "Left Margin",
    "MARGIN_RIGHT": "Right Margin",
    "MARGIN_TOP": "Top Margin",
    "MARGIN_BOTTOM": "Bottom Margin",
    "HEADING_HIERARCHY": "Heading Hierarchy",
    "TABLE_CAPTION_MISSING": "Table Caption Missing",
    "IMAGE_CAPTION_MISSING": "Image Caption Missing",
    "IMAGE_ALT_TEXT_MISSING": "Image Alt-Text Missing",
    "CITATION_MISMATCH": "Citation Mismatch",
}


def _rule_name(code: str) -> str:
    return _RULE_NAME.get(code, code)


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


def required_action(v) -> str:
    """Action text for a single violation."""
    if v.rule_code == "CITATION_MISMATCH":
        return _citation_action(v)
    loc = location_text(v.location)
    if v.expected_value and v.actual_value and loc != "—":
        prop = _PROP_NAME.get(v.rule_code, "value")
        return f"Change {prop} for {loc} from {v.actual_value} to {v.expected_value}."
    return _REQUIRED_ACTIONS.get(v.rule_code, "Review the finding and apply the required formatting.")


_LOCATION_KEYS = (
    ("paragraph_index", "Paragraph {n}"),
    ("section_index", "Section {n}"),
    ("table_index", "Table {n}"),
    ("image_index", "Image {n}"),
    ("run_index", "Run {n}"),
)


def location_text(location) -> str:
    """Compact, human-readable location. Indexes are shown one-based."""
    if not location:
        return "—"
    parts = []
    for key, fmt in _LOCATION_KEYS:
        value = location.get(key)
        if value is not None:
            parts.append(fmt.format(n=value + 1))
    return ", ".join(parts) or "—"


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
# ID generators
# ---------------------------------------------------------------------------

def _p_id(n: int) -> str:
    return f"P{n:03d}"


def _g_id(n: int) -> str:
    return f"G{n:03d}"


def _f_id(n: int) -> str:
    return f"F{n:03d}"


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


def _finding_table(index, v) -> Table:
    rows = [
        ("Rule", v.rule_code),
        ("Severity", v.severity),
    ]
    loc = location_text(v.location)
    if loc != "—":
        rows.append(("Location", loc))
    rows.append(("Finding", v.message or ""))
    if v.expected_value:
        rows.append(("Expected", v.expected_value))
    if v.actual_value:
        rows.append(("Actual", v.actual_value))
    rows.append(("Required Action", required_action(v)))

    data = [[_p(f"Finding {index + 1}", size=9, font="Helvetica-Bold", color=colors.white)],
            *[[_p(k, size=8.5, font="Helvetica-Bold", color=MUTED), _p(v, size=9.5)] for k, v in rows]]
    table = Table(data, colWidths=[38 * mm, _PAGE_W - 2 * _MARGIN - 38 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("LINEBELOW", (0, 1), (-1, -2), 0.4, colors.HexColor("#D8D5CB")),
        ("BOX", (0, 0), (-1, -1), 0.6, NAVY),
    ]))
    return table


def _location_summary(violations) -> str:
    """Compact location list: consecutive paragraphs become ranges; run indexes kept."""
    paras = {}
    others = []
    for v in violations:
        loc = v.location or {}
        pi = loc.get("paragraph_index")
        if pi is None:
            text = location_text(loc)
            if text != "—":
                others.append(text)
        else:
            ri = loc.get("run_index")
            if ri is not None:
                if pi not in paras or paras[pi] is None:
                    paras[pi] = set()
                paras[pi].add(ri)
            elif pi not in paras:
                paras[pi] = None
    parts = []
    if paras:
        nums = sorted(paras)
        spans = []
        start = prev = nums[0]
        for n in nums[1:]:
            if n == prev + 1:
                prev = n
            else:
                spans.append((start, prev))
                start = prev = n
        spans.append((start, prev))
        for a, b in spans:
            label = f"Paragraph {a + 1}" if a == b else f"Paragraphs {a + 1}-{b + 1}"
            runs = set()
            for n in range(a, b + 1):
                rs = paras.get(n)
                if rs:
                    runs.update(rs)
            if runs:
                label += " (" + ", ".join(f"Run {r + 1}" for r in sorted(runs)) + ")"
            parts.append(label)
    parts.extend(sorted(set(others)))
    return ", ".join(parts) or "—"


def _group_panel(gid, members, rule_code, exp_val) -> Table:
    """Info panel for a grouped minor finding: header, comparison, locations, action."""
    names = sorted(set(str(v.actual_value) for v in members if v.actual_value))
    action = _REQUIRED_ACTIONS.get(rule_code, "Review the finding and apply the required formatting.")
    body_width = _PAGE_W - 2 * _MARGIN
    data = [
        [_p(f"{gid}  {_rule_name(rule_code)}", size=9.5, font="Helvetica-Bold", color=colors.white),
         _p(f"Minor · {len(members)} finding(s)", size=8.5, font="Helvetica-Bold", color=colors.white,
            alignment=2)],
        [_p("Required", size=8.5, font="Helvetica-Bold", color=MUTED), _p(exp_val or "—", size=9)],
        [_p("Observed", size=8.5, font="Helvetica-Bold", color=MUTED),
         _p(" · ".join(names) or "—", size=9)],
        [_p("Affected Locations", size=8.5, font="Helvetica-Bold", color=MUTED),
         _p(_location_summary(members), size=9)],
        [_p("Required Action", size=8.5, font="Helvetica-Bold", color=GREEN), _p(action, size=9)],
    ]
    table = Table(data, colWidths=[46 * mm, body_width - 46 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("BACKGROUND", (0, 1), (-1, -1), _PANEL_BG),
        ("BACKGROUND", (0, 4), (-1, 4), _PANEL_ACTION_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LINEBELOW", (0, 0), (-1, 3), 0.4, colors.HexColor("#D8D5CB")),
        ("BOX", (0, 0), (-1, -1), 0.6, _PANEL_BORDER),
    ]))
    return table


def _rule_cell(v) -> Paragraph:
    """Friendly rule name with the technical rule code as secondary text."""
    return Paragraph(
        f"{_clean(_rule_name(v.rule_code))}<br/>"
        f"<font name='Helvetica' size='6.5' color='#5B6470'>{_clean(v.rule_code)}</font>",
        ParagraphStyle("rule-cell", fontName="Helvetica-Bold", fontSize=8,
                       leading=10.8, textColor=INK),
    )


def _appendix_table(entries) -> Table:
    """Register rows: ID, Severity, Friendly Rule, Location, Actual, Expected."""
    rows = [[_p(h, size=8, font="Helvetica-Bold", color=colors.white) for h in
             ("ID", "Severity", "Friendly Rule", "Location", "Actual", "Expected")]]
    for f_idx, v in entries:
        rows.append([
            _p(_f_id(f_idx), size=8),
            _p(v.severity, size=8, font="Helvetica-Bold" if v.severity == "MAJOR" else "Helvetica"),
            _rule_cell(v),
            _p(location_text(v.location), size=8),
            _p(v.actual_value or "", size=8),
            _p(v.expected_value or "", size=8),
        ])
    table = Table(rows, colWidths=[14 * mm, 20 * mm, 55 * mm, 62 * mm, 58 * mm, 58 * mm],
                  repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D8D5CB")),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def _score_summary(score, grade_label, major, minor) -> Table:
    def cell(text, size, font, color, bg=None):
        return Paragraph(_clean(text), ParagraphStyle(
            f"cell-{size}-{font}",
            fontName=_font_for(text) if font == "Helvetica" else font,
            fontSize=size,
            leading=size * 1.3,
            textColor=color,
            alignment=1,
        ))

    data = [
        [cell("Compliance Score", 8.5, "Helvetica-Bold", MUTED),
         cell("Grade", 8.5, "Helvetica-Bold", MUTED),
         cell("Major", 8.5, "Helvetica-Bold", MUTED),
         cell("Minor", 8.5, "Helvetica-Bold", MUTED)],
        [cell(str(score), 20, "Helvetica-Bold", colors.white),
         cell(f"{grade_label['grade']} - {grade_label['label']}", 12, "Helvetica-Bold", NAVY),
         cell(str(major), 16, "Helvetica-Bold", RED),
         cell(str(minor), 16, "Helvetica-Bold", MUTED)],
    ]
    table = Table(data, colWidths=[50 * mm, 55 * mm, 35 * mm, 35 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 1), NAVY),
        ("BACKGROUND", (1, 0), (-1, 0), LIGHT),
        ("BACKGROUND", (1, 1), (-1, 1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.6, NAVY),
        ("LINEBELOW", (1, 0), (-1, 0), 0.4, colors.HexColor("#D8D5CB")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def _draw_chrome(canvas, doc, page_w, page_h):
    canvas.saveState()
    # Navy header band
    canvas.setFillColor(NAVY)
    canvas.rect(0, page_h - 11 * mm, page_w, 11 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 8.5)
    canvas.drawString(_MARGIN, page_h - 7.2 * mm, "Compliance Report")
    canvas.drawRightString(page_w - _MARGIN, page_h - 7.2 * mm,
                           _clean(getattr(doc, "title", "Compliance Report"))[:60])
    # Footer rule + page number
    canvas.setStrokeColor(NAVY)
    canvas.setLineWidth(0.6)
    canvas.line(_MARGIN, 14 * mm, page_w - _MARGIN, 14 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(_MARGIN, 10 * mm, "Academic Compliance Auditor - Manuscript Review Desk")
    canvas.drawRightString(page_w - _MARGIN, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _on_page(canvas, doc):
    _draw_chrome(canvas, doc, _PAGE_W, _PAGE_H)


def _on_landscape(canvas, doc):
    _draw_chrome(canvas, doc, _LAND_W, _LAND_H)


def generate_audit_pdf(audit, violations, citation_issues) -> bytes:
    """Build the full A4 report as PDF bytes."""
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
    grade = grade_for(score_result.total)

    story = []
    story.append(_p("Academic Compliance Report", size=18, font="Helvetica-Bold", color=NAVY, leading=22))
    story.append(_p("Manuscript Review Desk", size=10, color=MUTED))
    story.append(Spacer(1, 3 * mm))

    report_date = audit.completed_at or audit.created_at
    story.append(_kv_table([
        ("Document", audit.filename),
        ("Audit ID", audit.id),
        ("Report Date", report_date.strftime("%d %B %Y, %H:%M UTC") if report_date else "Unavailable"),
        ("Deployment Mode", audit.deploy_mode),
        ("AI Citation Review", audit.ai_review_status or "Not recorded"),
    ]))
    story.append(Spacer(1, 4 * mm))

    # ---- Executive Summary ----
    story.append(_section("Executive Summary"))
    story.append(Spacer(1, 2 * mm))
    story.append(_score_summary(score_result.total, grade, score_result.major_count, score_result.minor_count))
    story.append(Spacer(1, 4 * mm))

    # ---- Category Breakdown ----
    story.append(_section("Category Breakdown"))
    story.append(Spacer(1, 2 * mm))
    break_rows = [[_p(h, size=8.5, font="Helvetica-Bold", color=colors.white) for h in
                   ("Category", "Major", "Minor", "Deducted", "Remaining")]]
    for item in score_result.breakdown:
        label = item.label
        if item.category == "citation_apa":
            label = "APA Citations"
        break_rows.append([_p(label, size=9), _p(item.major, size=9),
                           _p(item.minor, size=9), _p(item.deduction, size=9),
                           _p(item.remaining, size=9)])
    break_table = Table(break_rows, colWidths=[68 * mm, 26 * mm, 26 * mm, 30 * mm, 30 * mm], repeatRows=1)
    break_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, NAVY),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D8D5CB")),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    story.append(break_table)
    story.append(Spacer(1, 4 * mm))

    # ---- Priority Findings ----
    story.append(_section("Priority Findings"))
    story.append(Spacer(1, 2 * mm))
    major = [v for v in violations if v.severity == "MAJOR"]
    minor = [v for v in violations if v.severity == "MINOR"]
    if not violations:
        story.append(_p("No layout or citation findings were recorded for this document.", size=9.5, color=GREEN))
    else:
        story.append(_p(
            f"{len(violations)} deterministic finding(s): {len(major)} major (shown individually), "
            f"{len(minor)} minor (grouped by rule code and expected value). "
            "Findings are rule-based; AI guidance below is advisory only.",
            size=8.5, color=MUTED,
        ))
        story.append(Spacer(1, 2 * mm))

        # Major findings — individual tables with P### IDs
        for i, v in enumerate(major):
            story.append(_p(_p_id(i + 1), size=8.5, font="Helvetica-Bold", color=MUTED))
            story.append(KeepTogether([_finding_table(i, v)]))
            story.append(Spacer(1, 2 * mm))

        # Minor findings — group by (rule_code, expected_value); singletons rendered individually
        if minor:
            groups = defaultdict(list)
            for v in minor:
                key = (v.rule_code, v.expected_value or "")
                groups[key].append(v)

            group_idx = 0
            singleton_idx = 0
            for (rule_code, exp_val), members in groups.items():
                if len(members) == 1:
                    # Singleton: rendered individually with G prefix (treated as priority)
                    story.append(_p(f"{_g_id(group_idx + 1)}", size=8.5, font="Helvetica-Bold", color=MUTED))
                    story.append(KeepTogether([_finding_table(singleton_idx, members[0])]))
                    story.append(Spacer(1, 2 * mm))
                    singleton_idx += 1
                    group_idx += 1
                else:
                    # Grouped: structured info panel with header, comparison, locations, action
                    story.append(KeepTogether([_group_panel(_g_id(group_idx + 1), members, rule_code, exp_val)]))
                    story.append(Spacer(1, 4 * mm))
                    group_idx += 1

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
            story.append(_p(issue.message, size=9.5))
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
    stat_rows = [[_p(h, size=8.5, font="Helvetica-Bold", color=colors.white) for h in ("Metric", "Value")]]
    for label, value in stats:
        stat_rows.append([_p(label, size=9), _p(value if value is not None else "Unavailable", size=9)])
    stat_table = Table(stat_rows, colWidths=[90 * mm, 90 * mm], repeatRows=1)
    stat_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#D8D5CB")),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    story.append(stat_table)

    # ---- Scope, Limitations, Privacy ----
    story.append(Spacer(1, 4 * mm))
    story.append(_section("Scope, Limitations and Privacy"))
    story.append(Spacer(1, 2 * mm))
    story.append(_p(
        "Scope. This report covers layout and APA citation compliance of the uploaded .docx file: "
        "page margins, heading hierarchy, media captions, font consistency and size, paragraph "
        "typography, and APA citation matching.",
        size=9,
    ))
    story.append(_p(
        "Limitations. Checks are deterministic and rule-based; inline run-level font overrides may "
        "not be fully captured. AI-assisted guidance is advisory only — it never adds, removes, or "
        "re-scores findings. Verify AI-suggested corrections against the official APA 7 manual.",
        size=9,
    ))
    story.append(_p(
        "Privacy. The original Word file is not stored or modified. Extracted paragraph "
        "text may be stored in the local audit database to support document preview and "
        "audit history. This PDF excludes the full document text.",
        size=9,
    ))

    # ---- Appendix — Findings Register (new landscape page, severity-split) ----
    if violations:
        story.append(NextPageTemplate("appendix"))
        story.append(PageBreak())
        story.append(_section("Appendix — Findings Register"))
        story.append(Spacer(1, 2 * mm))
        story.append(_p(
            "Every finding from the Priority section appears exactly once below, grouped by "
            "severity. Technical rule codes appear under each friendly rule name.",
            size=8.5, color=MUTED,
        ))
        story.append(Spacer(1, 3 * mm))

        f_idx = 0
        major_entries = []
        for v in major:
            f_idx += 1
            major_entries.append((f_idx, v))
        if major_entries:
            story.append(_p("Major Findings", size=9.5, font="Helvetica-Bold", color=NAVY))
            story.append(Spacer(1, 1.5 * mm))
            story.append(_appendix_table(major_entries))
            story.append(Spacer(1, 5 * mm))

        minor_entries = []
        minor_groups = defaultdict(list)
        for v in minor:
            key = (v.rule_code, v.expected_value or "")
            minor_groups[key].append(v)
        for members in minor_groups.values():
            for v in members:
                f_idx += 1
                minor_entries.append((f_idx, v))
        if minor_entries:
            story.append(_p("Minor Findings", size=9.5, font="Helvetica-Bold", color=NAVY))
            story.append(Spacer(1, 1.5 * mm))
            story.append(_appendix_table(minor_entries))

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
    doc.addPageTemplates([
        PageTemplate(id="main", frames=[Frame(
            _MARGIN, 18 * mm, _PAGE_W - 2 * _MARGIN, _PAGE_H - 34 * mm, id="body",
        )], onPage=_on_page),
        PageTemplate(id="appendix", pagesize=(_LAND_W, _LAND_H), frames=[Frame(
            _MARGIN, 18 * mm, _LAND_W - 2 * _MARGIN, _LAND_H - 34 * mm, id="appendix-body",
        )], onPage=_on_landscape),
    ])
    doc.build(story)
    return buf.getvalue()
