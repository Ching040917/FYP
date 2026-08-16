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

_MARGIN = 15 * mm
_PAGE_W, _PAGE_H = A4


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
    """Safe attachment filename: `<sanitized-document>-compliance-report.pdf`.

    The source extension (.docx) is dropped so the result reads
    `thesis-final-compliance-report.pdf`, not `thesis.docx-compliance-report.pdf`.
    """
    base = (doc_name or "").strip()
    if base.lower().endswith(".docx"):
        base = base[:-5]
    elif base.lower().endswith(".doc"):
        base = base[:-4]
    return f"{sanitise_filename(base)}-compliance-report.pdf"


# ---------------------------------------------------------------------------
# Narrow finding presentation helpers (backend-owned, not copied from UI)
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


def required_action(v) -> str:
    """Action text for a single violation.

    When expected/actual values and a location are both present, return a
    concrete change instruction (e.g. *Change space before Paragraph 19 from
    18 pt to 0 pt.*). Otherwise fall back to the rule-code-specific default.
    """
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
    """Split the persisted APA guidance blob into named sections.

    The stored suggestion is one string with blank-line-separated sections:
    Recommended correction / What to verify / APA 7 formatting example /
    placeholder warning. Returns only those sections; unknown layout is
    preserved under 'correction' so no guidance is ever dropped.
    """
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


def _on_page(canvas, doc):
    canvas.saveState()
    # Navy header band
    canvas.setFillColor(NAVY)
    canvas.rect(0, _PAGE_H - 11 * mm, _PAGE_W, 11 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 8.5)
    canvas.drawString(_MARGIN, _PAGE_H - 7.2 * mm, "Compliance Report")
    canvas.drawRightString(_PAGE_W - _MARGIN, _PAGE_H - 7.2 * mm,
                           _clean(getattr(doc, "title", "Compliance Report"))[:60])
    # Footer rule + page number
    canvas.setStrokeColor(NAVY)
    canvas.setLineWidth(0.6)
    canvas.line(_MARGIN, 14 * mm, _PAGE_W - _MARGIN, 14 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(_MARGIN, 10 * mm, "Academic Compliance Auditor - Manuscript Review Desk")
    canvas.drawRightString(_PAGE_W - _MARGIN, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def generate_audit_pdf(audit, violations, citation_issues) -> bytes:
    """Build the full A4 report as PDF bytes.

    Args:
        audit: AuditRecord (must have .filename, .id, .created_at,
            .completed_at, .deploy_mode, .weighted_score, status and the
            stats columns).
        violations: persisted Violation ORM rows.
        citation_issues: persisted CitationIssue ORM rows.
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
    grade = grade_for(score_result.total)

    story = []
    story.append(_p("Academic Compliance Report", size=18, font="Helvetica-Bold", color=NAVY, leading=22))
    story.append(_p("Manuscript Review Desk", size=10, color=MUTED))
    story.append(Spacer(1, 4 * mm))

    report_date = audit.completed_at or audit.created_at
    story.append(_kv_table([
        ("Document", audit.filename),
        ("Audit ID", audit.id),
        ("Report Date", report_date.strftime("%d %B %Y, %H:%M UTC") if report_date else "Unavailable"),
        ("Deployment Mode", audit.deploy_mode),
        ("AI Citation Review", audit.ai_review_status or "Not recorded"),
    ]))
    story.append(Spacer(1, 5 * mm))

    # ---- Score summary ----
    story.append(_section("Executive Summary"))
    story.append(Spacer(1, 3 * mm))
    story.append(_score_summary(score_result.total, grade, score_result.major_count, score_result.minor_count))
    story.append(Spacer(1, 5 * mm))

    # ---- Category breakdown ----
    story.append(_section("Category Breakdown"))
    story.append(Spacer(1, 3 * mm))
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
    story.append(Spacer(1, 5 * mm))

    # ---- Priority Findings ----
    story.append(_section("Priority Findings"))
    story.append(Spacer(1, 3 * mm))
    major = [v for v in violations if v.severity == "MAJOR"]
    minor = [v for v in violations if v.severity == "MINOR"]
    if not violations:
        story.append(_p("No layout or citation findings were recorded for this document.", size=9.5, color=GREEN))
    else:
        story.append(_p(
            f"{len(violations)} deterministic finding(s): {len(major)} major (shown in full detail below), "
            f"{len(minor)} minor (grouped by rule code and required action). "
            "Findings are rule-based; AI guidance below is advisory only.",
            size=8.5, color=MUTED,
        ))
        story.append(Spacer(1, 2 * mm))

        # Major findings — individual detail tables
        for i, v in enumerate(major):
            story.append(_finding_table(i, v))
            story.append(Spacer(1, 3 * mm))

        # Minor findings — group only when 2+ share the same rule code;
        # singletons render individually so their specific action is visible.
        if minor:
            groups = defaultdict(list)
            for v in minor:
                groups[v.rule_code].append(v)
            singleton_idx = 0
            for rule_code, members in groups.items():
                if len(members) == 1:
                    story.append(_finding_table(singleton_idx, members[0]))
                    story.append(Spacer(1, 3 * mm))
                    singleton_idx += 1
                else:
                    locs = sorted(set(location_text(v.location) for v in members))
                    exp_vals = sorted(set(str(v.expected_value) for v in members if v.expected_value))
                    act_vals = sorted(set(str(v.actual_value) for v in members if v.actual_value))
                    story.append(_p(f"{rule_code} - {len(members)} finding(s)", size=9.5,
                                   font="Helvetica-Bold", color=NAVY))
                    if members[0].message:
                        story.append(_p(members[0].message, size=9))
                    story.append(_p(f"Locations: {', '.join(locs)}", size=9))
                    if exp_vals:
                        story.append(_p(f"Expected: {' · '.join(exp_vals)}", size=9))
                    if act_vals:
                        story.append(_p(f"Actual: {' · '.join(act_vals)}", size=9))
                    generic_action = _REQUIRED_ACTIONS.get(rule_code,
                        "Review the finding and apply the required formatting.")
                    story.append(_p(f"Required Action: {generic_action}", size=9))
                    story.append(Spacer(1, 4 * mm))

    # ---- Detailed Findings Appendix (only when the main body would be long) ----
    if len(minor) >= 8 or len(violations) >= 20:
        story.append(Spacer(1, 5 * mm))
        story.append(_section("Detailed Findings Appendix"))
        story.append(Spacer(1, 3 * mm))
        story.append(_p(
            "Complete detail for every finding. The Priority Findings section above groups minor findings to keep the main report concise.",
            size=8.5, color=MUTED,
        ))
        story.append(Spacer(1, 2 * mm))
        for i, v in enumerate(violations):
            story.append(_finding_table(i, v))
            story.append(Spacer(1, 3 * mm))

    # ---- AI-assisted citation guidance ----
    if citation_issues:
        story.append(Spacer(1, 2 * mm))
        story.append(_section("Citation Guidance"))
        story.append(Spacer(1, 3 * mm))
        shared_checklists = []
        shared_templates = []
        shared_warnings = []
        for issue in citation_issues:
            parts = split_apa_suggestion(issue.suggestion)
            story.append(_p(f"Paragraph {issue.paragraph_index + 1}", size=9.5, font="Helvetica-Bold", color=NAVY))
            if issue.text_snippet:
                story.append(_p(f"“{issue.text_snippet}”", size=9, color=MUTED))
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
            story.append(Spacer(1, 2.5 * mm))

        # Shared APA reference material — printed once, never per finding.
        story.append(_section("APA 7 Reference Checklist and Templates"))
        story.append(Spacer(1, 3 * mm))
        if shared_checklists:
            story.append(_p("Verify every corrected citation against this checklist:", size=9.5, font="Helvetica-Bold"))
            for checklist in shared_checklists:
                for line in checklist.split("\n"):
                    story.append(_p(line, size=9.5))
        story.append(Spacer(1, 2 * mm))
        if shared_templates:
            story.append(_p("Formatting examples (placeholders - never invented details):", size=9.5, font="Helvetica-Bold"))
            for template in shared_templates:
                for line in template.split("\n"):
                    story.append(_p(line, size=9, color=INK))
        for warning in shared_warnings:
            story.append(Spacer(1, 2 * mm))
            story.append(_p(f"Note: {warning}", size=8.5, color=MUTED))

    # ---- Document statistics ----
    story.append(Spacer(1, 3 * mm))
    story.append(_section("Document Statistics"))
    story.append(Spacer(1, 3 * mm))
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

    # ---- Scope, limitations, privacy ----
    story.append(Spacer(1, 5 * mm))
    story.append(_section("Scope, Limitations and Privacy"))
    story.append(Spacer(1, 3 * mm))
    story.append(_p(
        "Scope. This report covers layout and APA citation compliance of the uploaded .docx file: "
        "page margins, heading hierarchy, media captions, font consistency and size, paragraph "
        "typography, and APA citation matching.",
        size=9,
    ))
    story.append(_p(
        "Limitations. Checks are deterministic and rule-based; inline run-level font overrides may "
        "not be fully captured. AI-assisted guidance is advisory only – it never adds, removes, or "
        "re-scores findings. Verify AI-suggested corrections against the official APA 7 manual.",
        size=9,
    ))
    story.append(_p(
        "Privacy. The original Word file is not stored or modified. Extracted paragraph "
        "text may be stored in the local audit database to support document preview and "
        "audit history. This PDF excludes the full document text.",
        size=9,
    ))

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
    doc.addPageTemplates([PageTemplate(id="main", frames=[Frame(
        _MARGIN, 18 * mm, _PAGE_W - 2 * _MARGIN, _PAGE_H - 34 * mm, id="body",
    )], onPage=_on_page)])
    doc.build(story)
    return buf.getvalue()
