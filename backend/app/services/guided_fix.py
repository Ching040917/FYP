"""Guided Fixes: deterministic direct-format edits to a verified DOCX copy."""
import io
import math
import re
import unicodedata
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field

from app.models.audit import AuditRecord, Violation
from app.services.document_parser import extract_paragraphs, parse_document
from app.services.profile_schema import (
    _FONT_SIZE_PT_RANGE,
    _LINE_SPACING_RANGE,
    _SPACING_PT_RANGE,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SAFE_RUN_RULES = frozenset({"FONT_CONSISTENCY", "FONT_SIZE", "REFERENCE_HEADING_BOLD"})
SAFE_PARA_RULES = frozenset({"ALIGNMENT", "LINE_SPACING", "SPACE_BEFORE", "SPACE_AFTER", "REFERENCE_HEADING_ALIGNMENT"})

MISMATCH_DETAIL = (
    "The selected document does not match the document used for this audit. "
    "Upload the original DOCX file and try again."
)
LEGACY_DETAIL = "Guided Fixes is unavailable for audits created before document matching was introduced."

# WordprocessingML namespaces (explicit — no qn() needed for the tag set).
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"

# Structural safety gate: paragraphs/runs containing any of these elements
# (as self, descendant, or ancestor) are never modified. Tracked changes,
# fields, hyperlinks, comments, structured content, text boxes, subdocs,
# math, and AlternateContent are all conservative skips.
_UNSAFE_TAGS = frozenset({
    _W + "ins", _W + "del", _W + "fldChar", _W + "instrText",
    _W + "hyperlink", _W + "commentRangeStart", _W + "commentRangeEnd",
    _W + "commentReference", _W + "sdt", _W + "txbxContent", _W + "subDoc",
    _M + "oMath", _MC + "AlternateContent",
})

_ALIGNMENTS = frozenset({"left", "center", "right", "justify"})

_PT_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*pt$", re.IGNORECASE)
_RATIO_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)$")
_COMBO_TOKEN_RE = re.compile(r"^(.+?)\s+\d+(?:\.\d+)?pt$")
_TRAILING_SIZE_RE = re.compile(r"\s+\d+(?:\.\d+)?pt$", re.IGNORECASE)


class GuidedFixFailed(Exception):
    """A fix could not be applied or the corrected output could not be
    verified. No partial output is ever returned."""
    pass


class ReferenceHeadingBoldUnavailable(GuidedFixFailed):
    """Only these candidate-specific reasons may cross the public Review boundary."""

    DETAILS = {
        "ambiguous_heading": (
            "ACA cannot identify one unambiguous Reference List heading. "
            "Correct this finding manually; your original document is unchanged."
        ),
        "unverifiable_bold": (
            "ACA cannot safely confirm bold formatting for every text segment in this heading. "
            "Correct its bold formatting manually; your original document is unchanged."
        ),
        "unsupported_package": (
            "This correction is unavailable for signed, protected or macro-enabled documents. "
            "Correct the heading manually; your original document is unchanged."
        ),
    }

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(self.DETAILS[reason])


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------

class GuidedFixSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    violation_ids: List[str] = Field(min_length=1, max_length=20)


# ---------------------------------------------------------------------------
# Parse / compare helpers
# ---------------------------------------------------------------------------

def _parse_pt(s) -> Optional[float]:
    """Parse a 'Npt' string (case-insensitive) into finite points."""
    if not isinstance(s, str):
        return None
    m = _PT_RE.match(s)
    if m is None:
        return None
    value = float(m.group(1))
    return value if math.isfinite(value) else None


def _parse_ratio(s) -> Optional[float]:
    """Parse a bare finite float (line-spacing multiplier)."""
    if not isinstance(s, str):
        return None
    m = _RATIO_RE.match(s)
    if m is None:
        return None
    value = float(m.group(1))
    return value if math.isfinite(value) else None


def _in_bounds(v: Optional[float], lo: float, hi: float) -> bool:
    return v is not None and math.isfinite(v) and lo <= v <= hi


def _family_from_actual(s) -> Optional[str]:
    """Lowercase family token from a persisted FONT_CONSISTENCY actual_value.

    Exact-family profiles persist a bare family name; allowed-pair profiles
    persist a combo string like "Calibri 11pt". Strip the trailing
    ' <number>pt' and lowercase; anything else yields None (unverifiable).
    """
    if not isinstance(s, str):
        return None
    token = _TRAILING_SIZE_RE.sub("", s).strip().lower()
    return token or None




# ---------------------------------------------------------------------------
# Structural safety gate
# ---------------------------------------------------------------------------

def _unsafe_element(el) -> bool:
    """True when the element, any descendant, or any ancestor carries an
    unsafe tag (tracked changes, fields, hyperlinks, comments, sdt, text
    boxes, subdocs, math, AlternateContent)."""
    for node in el.iter():
        if node.tag in _UNSAFE_TAGS:
            return True
    for node in el.iterancestors():
        if node.tag in _UNSAFE_TAGS:
            return True
    return False


def _unsafe_paragraph(para) -> bool:
    return _unsafe_element(para._p)


def _unsafe_run(run) -> bool:
    return _unsafe_element(run._r)


def _require_unique_reference_heading(doc, paragraphs, index: int) -> None:
    """The same main-story identity gate used by Reference-heading alignment."""
    from app.services.reference_section import reference_section_bounds, normalise_reference_heading

    bounds = reference_section_bounds(paragraphs)
    recognized = [p["index"] for p in paragraphs if normalise_reference_heading(p["text"]) is not None]
    table_heading = any(
        normalise_reference_heading("".join(node.text or "" for node in cell_para.iter(_W + "t"))) is not None
        for table in doc.element.body.iter(_W + "tbl")
        for cell_para in table.iter(_W + "p")
    )
    if bounds is None or recognized != [index] or bounds.heading_index != index or table_heading:
        raise GuidedFixFailed("ambiguous Reference heading")


def _reference_heading_bold_run_indexes(doc, paragraphs, index: int) -> List[int]:
    """Enumerate complete physical text-run addresses, also on corrected output.

    No persisted Actual comparison or noncompliance decision belongs here.
    Direct booleans make local overrides provable; used style/default chains
    are inspected only to exclude numbering and unsupported script formatting.
    """
    from app.services.reference_section import NUMERIC_SECTION_PREFIX

    try:
        _require_unique_reference_heading(doc, paragraphs, index)
    except GuidedFixFailed as exc:
        raise ReferenceHeadingBoldUnavailable("ambiguous_heading") from exc
    para = doc.paragraphs[index]
    if para._p.getparent() is not doc.element.body:
        raise ReferenceHeadingBoldUnavailable("ambiguous_heading")
    pprs = para._p.findall(_W + "pPr")
    if (len(pprs) != 1 or para._p[0] is not pprs[0] or
            any(text.strip() for text in para._p.xpath("text()")) or NUMERIC_SECTION_PREFIX.match(para.text.strip())):
        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
    paragraph_properties = {
        "pStyle", "keepNext", "keepLines", "pageBreakBefore", "widowControl",
        "suppressLineNumbers", "shd", "suppressAutoHyphens",
        "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE",
        "autoSpaceDN", "snapToGrid", "spacing", "ind", "contextualSpacing",
        "mirrorIndents", "suppressOverlap", "jc", "textDirection",
        "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
    }
    run_properties = {
        "rStyle", "rFonts", "b", "i", "iCs", "caps", "smallCaps", "strike",
        "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
        "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
        "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
        "fitText", "vertAlign", "lang", "eastAsianLayout", "specVanish",
    }

    def check_properties(container, allowed):
        if container is None:
            return
        tags = [node.tag for node in container]
        if (container.attrib or len(tags) != len(set(tags)) or
                any(tag not in {_W + name for name in allowed} for tag in tags) or
                any(node.tag in {_W + "bCs", _W + "cs", _W + "rtl", _W + "bidi",
                                 _W + "numPr", _W + "sectPr", _W + "rPrChange",
                                 _W + "pPrChange"} for node in container.iter())):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        # Normal lang/@bidi and rFonts/@csTheme are metadata, not script flags.
        for node in container:
            if node.tag == _W + "rPr":
                check_properties(node, run_properties - {"rStyle"})
            elif len(node) or (node.text or "").strip():
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            if node.tag == _W + "b" and (
                set(node.attrib) - {_W + "val"} or node.text or
                node.get(_W + "val") not in (None, "1", "0", "true", "false", "on", "off")
            ):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")

    check_properties(pprs[0], paragraph_properties)
    styles = doc.styles.element
    style_nodes = {}
    for node in styles.findall(_W + "style"):
        style_nodes.setdefault(node.get(_W + "styleId"), []).append(node)

    def check_style(style_id, kind):
        if not style_id:
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        seen = set()
        while style_id is not None:
            matches = style_nodes.get(style_id, [])
            if style_id in seen or len(matches) != 1 or matches[0].get(_W + "type") != kind:
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            seen.add(style_id)
            style = matches[0]
            for tag, allowed in (("pPr", paragraph_properties), ("rPr", run_properties - {"rStyle"})):
                properties = style.findall(_W + tag)
                if len(properties) > 1:
                    raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
                if properties:
                    check_properties(properties[0], allowed)
            parents = style.findall(_W + "basedOn")
            if len(parents) > 1 or (parents and (
                not parents[0].get(_W + "val") or len(parents[0]) or
                set(parents[0].attrib) != {_W + "val"} or (parents[0].text or "").strip()
            )):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            style_id = parents[0].get(_W + "val") if parents else None

    def used_style(container, tag, kind):
        refs = container.findall(_W + tag) if container is not None else []
        if len(refs) > 1:
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        if refs:
            style_id = refs[0].get(_W + "val")
            if not style_id or len(refs[0]) or set(refs[0].attrib) != {_W + "val"}:
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            check_style(style_id, kind)
        else:
            if any(node.get(_W + "type") == kind and
                   node.get(_W + "default") not in (None, "1", "0", "true", "false", "on", "off")
                   for node in styles.findall(_W + "style")):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            defaults = [node for node in styles.findall(_W + "style")
                        if node.get(_W + "type") == kind and node.get(_W + "default") in ("1", "true", "on")]
            if len(defaults) > 1 or (kind == "paragraph" and not defaults):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            if defaults:
                check_style(defaults[0].get(_W + "styleId"), kind)

    defaults = styles.findall(_W + "docDefaults")
    if len(defaults) > 1:
        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
    if defaults:
        if (defaults[0].attrib or
                any(node.tag not in {_W + "pPrDefault", _W + "rPrDefault"} for node in defaults[0])):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        for outer, inner, allowed in (
            ("pPrDefault", "pPr", paragraph_properties),
            ("rPrDefault", "rPr", run_properties - {"rStyle"}),
        ):
            wrappers = defaults[0].findall(_W + outer)
            if len(wrappers) > 1:
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            if wrappers:
                properties = wrappers[0].findall(_W + inner)
                if (len(properties) != 1 or len(wrappers[0]) != 1 or wrappers[0].attrib or
                        (wrappers[0].text or "").strip()):
                    raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
                if properties:
                    check_properties(properties[0], allowed)
    used_style(pprs[0], "pStyle", "paragraph")
    bookmarks = []
    seen_bookmarks = set()
    indexes = []
    run_index = 0
    for child in para._p:
        if child.tag == _W + "pPr":
            continue
        if child.tag in (_W + "bookmarkStart", _W + "bookmarkEnd"):
            identity = child.get(_W + "id")
            allowed = {_W + "id", _W + "name"} if child.tag == _W + "bookmarkStart" else {_W + "id"}
            if (not identity or not identity.isascii() or not identity.isdecimal() or
                    len(child) or child.text or set(child.attrib) != allowed):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            if child.tag == _W + "bookmarkStart":
                if identity in seen_bookmarks or not child.get(_W + "name"):
                    raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
                seen_bookmarks.add(identity)
                bookmarks.append(identity)
                for tag in ("bookmarkStart", "bookmarkEnd"):
                    if sum(node.get(_W + "id") == identity for node in doc.element.body.iter(_W + tag)) != 1:
                        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            elif not bookmarks or bookmarks.pop() != identity:
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            continue
        if child.tag != _W + "r" or _unsafe_element(child):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        if (any(text.strip() for text in child.xpath("text()")) or
                any(node.tag not in (_W + "rPr", _W + "t") for node in child)):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        rprs = child.findall(_W + "rPr")
        if (len(rprs) > 1 or (rprs and child[0] is not rprs[0]) or
                any(len(node) or set(node.attrib) - {"{http://www.w3.org/XML/1998/namespace}space"}
                    for node in child.findall(_W + "t"))):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        rpr = rprs[0] if rprs else None
        check_properties(rpr, run_properties)
        used_style(rpr, "rStyle", "character")
        run = para.runs[run_index]
        if any(unicodedata.bidirectional(ch) in ("R", "AL", "AN") for ch in run.text):
            raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
        if run.text != "":
            bold = rpr.findall(_W + "b") if rpr is not None else []
            if (len(bold) != 1 or len(bold[0]) or bold[0].text or
                    set(bold[0].attrib) - {_W + "val"} or
                    bold[0].get(_W + "val") not in (None, "1", "0", "true", "false", "on", "off") or
                    type(run.font.bold) is not bool):
                raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
            indexes.append(run_index)
        run_index += 1
    if bookmarks or not indexes:
        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
    return indexes


def _reference_heading_bold_targets(audit, doc, paragraphs, violation) -> Tuple[List[int], bool]:
    location = violation.location
    if (not isinstance(location, dict) or set(location) != {"paragraph_index"} or
            type(location["paragraph_index"]) is not int or
            not 0 <= location["paragraph_index"] < len(doc.paragraphs)):
        raise ReferenceHeadingBoldUnavailable("ambiguous_heading")
    index = location["paragraph_index"]
    indexes = _reference_heading_bold_run_indexes(doc, paragraphs, index)
    expected = _resolve_expected(violation, audit, doc, None)
    if type(expected) is not bool:
        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
    states = [doc.paragraphs[index].runs[i].font.bold for i in indexes]
    if (any(value is not states[0] for value in states) or
            violation.actual_value != ("Bold" if states[0] else "Not bold") or
            states[0] is expected):
        raise ReferenceHeadingBoldUnavailable("unverifiable_bold")
    return indexes, expected


def _fix_reference_heading_bold(run, required: bool) -> bool:
    run.font.bold = required
    return type(run.font.bold) is bool and run.font.bold is required


# ---------------------------------------------------------------------------
# Expected-value resolution — never guess a font
# ---------------------------------------------------------------------------

def _resolve_font_consistency_expected(
    expected_value, audit, doc, role
) -> Optional[str]:
    """Resolve the FONT_CONSISTENCY expected family, or None (skip).

    1. No ', ' in the expected value → single family token: strip, reject
       empty/control chars/len>64/all-digits.
    2. ', ' present (combo list) → collect distinct families from tokens
       matching '<family> <number>pt'; exactly one distinct family → it.
    3. Otherwise snapshot route: EffectiveProfileConfig from the persisted
       snapshot; role from classify_paragraphs; heading role → heading
       family (or the single distinct family in the heading allowed combos),
       else the body equivalents. Multiple families or none → None.
    NEVER hard-codes "Times New Roman"; no suggestedFamily().
    """
    if not isinstance(expected_value, str):
        return None
    if ", " not in expected_value:
        token = expected_value.strip()
        if (
            not token
            or len(token) > 64
            or token.isdigit()
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in token)
        ):
            return None
        return token

    families = set()
    for token in expected_value.split(", "):
        m = _COMBO_TOKEN_RE.match(token)
        if m is not None:
            family = m.group(1).strip()
            if family and len(family) <= 64:
                families.add(family)
    if len(families) == 1:
        return families.pop()

    # Snapshot route: the persisted immutable profile snapshot decides.
    snapshot_dict = getattr(audit, "profile_snapshot", None)
    if not isinstance(snapshot_dict, dict):
        return None
    try:
        from app.services.profile_snapshot import snapshot_from_dict
        from app.services.profile_preset_adapter import EffectiveProfileConfig
        snapshot = snapshot_from_dict(snapshot_dict)
        cfg = EffectiveProfileConfig(snapshot)
    except Exception:
        return None

    from app.services.role_eligibility import is_heading_role
    if is_heading_role(role):
        family = cfg.HEADING_FONT_FAMILY
        if family:
            return family.strip()
        combos = getattr(cfg, "HEADING_ALLOWED_FONT_COMBOS", ()) or ()
        families = {f for f, _ in combos}
        if len(families) == 1:
            return families.pop()
        return None

    family = cfg.FONT_FAMILY
    if family:
        return family.strip()
    combos = getattr(cfg, "BODY_ALLOWED_FONT_COMBOS", ()) or ()
    families = {f for f, _ in combos}
    if len(families) == 1:
        return families.pop()
    return None


def _resolve_expected(
    violation: Violation, audit, doc, role
) -> Optional[Any]:
    """Resolve the persisted expected_value for a whitelisted rule, or None
    (= skip `expected_unresolved`)."""
    rule_code = violation.rule_code
    expected_value = violation.expected_value

    if rule_code == "REFERENCE_HEADING_BOLD":
        from app.services.profile_snapshot import snapshot_from_dict
        from app.services.profile_preset_adapter import EffectiveProfileConfig
        try:
            config = EffectiveProfileConfig(snapshot_from_dict(audit.profile_snapshot))
            required = config.REFERENCES_HEADING_BOLD
            if (config.REFERENCES_CHECK_HEADING_BOLD is True and type(required) is bool and
                    expected_value == ("Bold" if required else "Not bold")):
                return required
        except Exception:
            return None
        return None
    if rule_code == "FONT_SIZE":
        value = _parse_pt(expected_value)
        return value if _in_bounds(value, *_FONT_SIZE_PT_RANGE) else None
    if rule_code == "LINE_SPACING":
        value = _parse_ratio(expected_value)
        return value if _in_bounds(value, *_LINE_SPACING_RANGE) else None
    if rule_code in ("SPACE_BEFORE", "SPACE_AFTER"):
        value = _parse_pt(expected_value)
        return value if _in_bounds(value, *_SPACING_PT_RANGE) else None
    if rule_code == "ALIGNMENT":
        if expected_value in _ALIGNMENTS:
            return expected_value
        return None
    if rule_code == "FONT_CONSISTENCY":
        return _resolve_font_consistency_expected(
            expected_value, audit, doc, role,
        )
    if rule_code == "REFERENCE_HEADING_ALIGNMENT":
        from app.services.profile_snapshot import snapshot_from_dict
        from app.services.profile_preset_adapter import EffectiveProfileConfig
        try:
            config = EffectiveProfileConfig(snapshot_from_dict(audit.profile_snapshot))
            required = config.REFERENCES_HEADING_ALIGNMENT
            if (config.REFERENCES_CHECK_HEADING_ALIGNMENT and
                    isinstance(required, str) and required.lower() in _ALIGNMENTS and
                    isinstance(expected_value, str) and expected_value.strip().lower() == required.lower()):
                return required.lower()
        except Exception:
            return None
        return None
    return None


# ---------------------------------------------------------------------------
# Fixers — python-docx direct formatting only; verify after each
# ---------------------------------------------------------------------------

def _fix_font_size(run, pt: float) -> bool:
    from docx.shared import Pt
    run.font.size = Pt(pt)
    try:
        actual = run.font.size
        if actual is None:
            return False
        return abs(actual.pt - pt) <= 0.01
    except Exception:
        return False


def _fix_font_family(run, family: str) -> bool:
    from docx.oxml.ns import qn
    run.font.name = family  # writes w:ascii + w:hAnsi
    # Required: font.name does NOT write w:eastAsia — without it the fix
    # fails on CJK text (Word applies the eastAsia face there).
    run._element.rPr.rFonts.set(qn("w:eastAsia"), family)
    rfonts = run._element.rPr.rFonts
    return (
        rfonts.get(qn("w:ascii")) == family
        and rfonts.get(qn("w:eastAsia")) == family
    )


def _fix_alignment(para, name: str) -> bool:
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    para.alignment = {
        "left": WD_ALIGN_PARAGRAPH.LEFT,
        "center": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT,
        "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }[name]
    return para.alignment == {
        "left": WD_ALIGN_PARAGRAPH.LEFT,
        "center": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT,
        "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }[name]


def _fix_line_spacing(para, ratio: float) -> bool:
    pf = para.paragraph_format
    pf.line_spacing = ratio
    actual = pf.line_spacing
    if actual is None:
        return False
    try:
        return abs(float(actual) - ratio) <= 0.01
    except (TypeError, ValueError):
        return False


def _fix_space_before(para, pt: float) -> bool:
    from docx.shared import Pt
    pf = para.paragraph_format
    pf.space_before = Pt(pt)
    actual = pf.space_before
    if actual is None:
        return False
    try:
        return abs(actual.pt - pt) <= 0.01
    except Exception:
        return False


def _fix_space_after(para, pt: float) -> bool:
    from docx.shared import Pt
    pf = para.paragraph_format
    pf.space_after = Pt(pt)
    actual = pf.space_after
    if actual is None:
        return False
    try:
        return abs(actual.pt - pt) <= 0.01
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Current-value comparators (same extraction + rule tolerances as the engine)
# ---------------------------------------------------------------------------

def _align_to_name(align) -> str:
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    return {
        WD_ALIGN_PARAGRAPH.LEFT: "left",
        WD_ALIGN_PARAGRAPH.CENTER: "center",
        WD_ALIGN_PARAGRAPH.RIGHT: "right",
        WD_ALIGN_PARAGRAPH.JUSTIFY: "justify",
    }.get(align, "unknown")


def _current_matches_expected(rule_code: str, expected: Any, para_dict: Dict, run_dict: Optional[Dict], para=None) -> bool:
    """True when the recomputed current value already equals the resolved
    expected value, using the rule's own tolerances. Paragraph rules read
    the paragraph object directly when provided — `extract_paragraphs`
    maps explicit zero lengths to None, so the dict view is unreliable for
    SPACE_* when the expected value is 0pt."""
    if rule_code == "REFERENCE_HEADING_BOLD":
        current = run_dict.get("bold") if run_dict else None
        return type(current) is bool and current is expected
    if rule_code in SAFE_RUN_RULES:
        if run_dict is None:
            return False
        if rule_code == "FONT_SIZE":
            current = run_dict.get("effective_font_size")
            return current is not None and abs(current - expected) <= 0.5
        # FONT_CONSISTENCY
        current = run_dict.get("effective_font_name")
        return current is not None and current.lower() == expected.lower()
    if rule_code == "REFERENCE_HEADING_ALIGNMENT":
        from app.services.formatting_evidence import resolve_alignment
        return para is not None and resolve_alignment(para).alignment == expected
    if para is not None:
        pf = para.paragraph_format
        if rule_code == "LINE_SPACING":
            value = pf.line_spacing
            if value is None:
                return False
            try:
                return abs(float(value) - expected) <= 0.1
            except (TypeError, ValueError):
                return False
        if rule_code == "SPACE_BEFORE":
            value = pf.space_before
            return value is not None and abs(value.pt - expected) <= 1
        if rule_code == "SPACE_AFTER":
            value = pf.space_after
            return value is not None and abs(value.pt - expected) <= 1
        if rule_code == "ALIGNMENT":
            return _align_to_name(para.alignment) == expected
    if rule_code == "LINE_SPACING":
        current = para_dict.get("line_spacing")
        if current is None:
            return False
        try:
            return abs(float(current) - expected) <= 0.1
        except (TypeError, ValueError):
            return False
    if rule_code == "SPACE_BEFORE":
        current = para_dict.get("space_before")
        return current is not None and abs(current - expected) <= 1
    if rule_code == "SPACE_AFTER":
        current = para_dict.get("space_after")
        return current is not None and abs(current - expected) <= 1
    if rule_code == "ALIGNMENT":
        return _align_to_name(para_dict.get("alignment")) == expected
    return False


def _current_changed_from_actual(rule_code: str, para_dict: Dict, run_dict: Optional[Dict], actual_value, para=None) -> bool:
    """True when the recomputed current value does NOT match the persisted
    actual_value (same extraction + tolerances). An actual_value that fails
    its own parser is treated as changed — an unverifiable current-vs-actual
    comparison is never applied."""
    if rule_code == "REFERENCE_HEADING_BOLD":
        current = run_dict.get("bold") if run_dict else None
        return type(current) is not bool or actual_value != ("Bold" if current else "Not bold")
    if rule_code == "FONT_SIZE":
        actual_pt = _parse_pt(actual_value)
        if actual_pt is None:
            return True
        current = run_dict.get("effective_font_size") if run_dict else None
        return current is None or abs(current - actual_pt) > 0.5
    if rule_code == "FONT_CONSISTENCY":
        actual_family = _family_from_actual(actual_value)
        if actual_family is None:
            return True
        current = run_dict.get("effective_font_name") if run_dict else None
        return current is None or current.lower() != actual_family
    if rule_code == "LINE_SPACING":
        try:
            actual = float(actual_value)
        except (TypeError, ValueError):
            return True
        current = para.paragraph_format.line_spacing if para is not None else para_dict.get("line_spacing")
        if current is None:
            return True
        try:
            return abs(float(current) - actual) > 0.1
        except (TypeError, ValueError):
            return True
    if rule_code in ("SPACE_BEFORE", "SPACE_AFTER"):
        actual_pt = _parse_pt(actual_value)
        if actual_pt is None:
            return True
        if para is not None:
            current = para.paragraph_format.space_before if rule_code == "SPACE_BEFORE" else para.paragraph_format.space_after
            current = None if current is None else current.pt
        else:
            current = para_dict.get(
                "space_before" if rule_code == "SPACE_BEFORE" else "space_after"
            )
        return current is None or abs(current - actual_pt) > 1
    if rule_code == "REFERENCE_HEADING_ALIGNMENT":
        from app.services.formatting_evidence import resolve_alignment
        return (para is None or not isinstance(actual_value, str) or
                actual_value.strip().lower() not in _ALIGNMENTS or
                resolve_alignment(para).alignment != actual_value.strip().lower())
    if rule_code == "ALIGNMENT":
        if actual_value not in _ALIGNMENTS:
            return True
        return _align_to_name(para_dict.get("alignment")) != actual_value
    return True


# ---------------------------------------------------------------------------
# Filename / header helpers
# ---------------------------------------------------------------------------

_FILENAME_UNSAFE_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def build_corrected_filename(original_name: str) -> str:
    """Sanitized download name, never a path."""
    stem = (original_name or "").rsplit(".", 1)[0] if "." in (original_name or "") else (original_name or "")
    stem = _FILENAME_UNSAFE_RE.sub("_", stem)
    stem = re.sub(r"_{3,}", "_", stem).strip(" .")[:150]
    return f"{stem or 'document'}_ACA-fixed.docx"


def _content_disposition(filename: str) -> str:
    """ASCII-safe plain form + RFC 5987 filename* only when they differ."""
    ascii_form = filename.encode("ascii", errors="replace").decode("ascii").replace("?", "_")
    header = f'attachment; filename="{ascii_form}"'
    encoded = urllib.parse.quote(filename, safe="")
    if encoded != ascii_form:
        header += f"; filename*=UTF-8''{encoded}"
    return header

# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def _unsupported_font_slots(run, code: str) -> bool:
    """Do not certify a visual font change while Word may use another slot."""
    rpr = run._r.find(_W + "rPr")
    if any(unicodedata.bidirectional(ch) in ("R", "AL", "AN") for ch in run.text):
        return True
    if rpr is None:
        return False
    if rpr.find(_W + "cs") is not None or rpr.find(_W + "rtl") is not None:
        return True
    if code == "FONT_SIZE" and rpr.find(_W + "szCs") is not None:
        return True
    if code == "FONT_CONSISTENCY":
        fonts = rpr.find(_W + "rFonts")
        if fonts is not None and any(
            name in fonts.attrib for name in (
                _W + "asciiTheme", _W + "hAnsiTheme", _W + "eastAsiaTheme",
                _W + "csTheme", _W + "cs",
            )
        ):
            return True
    return False


def review_targets(audit: AuditRecord, source_bytes: bytes, violations: List[Violation]):
    """Resolve the complete persisted targets before any mutation.

    A review does not certify the edit: apply repeats these checks against
    the exact source and later verifies the saved package and rule findings.
    """
    from app.services.role_classifier import classify_paragraphs

    if any(v.rule_code == "REFERENCE_HEADING_BOLD" for v in violations):
        from app.services.docx_preservation import (
            validate_reference_heading_bold_package, ReferenceHeadingBoldPackageUnsupported,
        )
        try:
            validate_reference_heading_bold_package(source_bytes)
        except ReferenceHeadingBoldPackageUnsupported as exc:
            raise ReferenceHeadingBoldUnavailable("unsupported_package") from exc
        except ValueError as exc:
            raise GuidedFixFailed("unverifiable DOCX package") from exc
    doc = parse_document(source_bytes)
    paragraphs = extract_paragraphs(doc)
    roles = classify_paragraphs(doc, paragraphs)
    if len(paragraphs) != len(doc.paragraphs):
        raise GuidedFixFailed("paragraph traversal is ambiguous")
    items = []
    targets = set()
    property_targets = set()
    for violation in violations:
        code = violation.rule_code
        if code not in SAFE_RUN_RULES | SAFE_PARA_RULES:
            raise GuidedFixFailed("unsupported rule")
        if code == "REFERENCE_HEADING_BOLD":
            bold_indexes, bold_expected = _reference_heading_bold_targets(audit, doc, paragraphs, violation)
        loc = violation.location
        if not isinstance(loc, dict):
            raise GuidedFixFailed("missing location")
        if code == "REFERENCE_HEADING_ALIGNMENT" and set(loc) != {"paragraph_index"}:
            raise GuidedFixFailed("ambiguous heading location")
        index = loc.get("paragraph_index")
        if type(index) is not int or not 0 <= index < len(paragraphs):
            raise GuidedFixFailed("invalid paragraph")
        if "paragraph_indexes" in loc or "occurrences" in loc:
            indexes = loc.get("paragraph_indexes")
            if (not isinstance(indexes, list) or
                    any(type(i) is not int or not 0 <= i < len(paragraphs) for i in indexes) or
                    loc.get("occurrences") != len(set(indexes)) or index not in indexes or
                    len(indexes) != 1):
                raise GuidedFixFailed("incomplete aggregate")
        para = doc.paragraphs[index]
        if _unsafe_paragraph(para):
            raise GuidedFixFailed("unsafe paragraph")
        if len(para.runs) != len(paragraphs[index]["runs"]):
            raise GuidedFixFailed("run traversal is ambiguous")
        if any(run.text != parsed.get("text") for run, parsed in zip(para.runs, paragraphs[index]["runs"])):
            raise GuidedFixFailed("run traversal changed")
        if code == "REFERENCE_HEADING_ALIGNMENT":
            from app.services.formatting_evidence import resolve_alignment
            _require_unique_reference_heading(doc, paragraphs, index)
            if not resolve_alignment(para).is_resolved:
                raise GuidedFixFailed("ambiguous Reference heading")
        raw = loc.get("run_indexes", loc.get("run_index"))
        run_indexes = raw if isinstance(raw, list) else [raw]
        if code == "REFERENCE_HEADING_BOLD":
            run_indexes = bold_indexes
        elif code in SAFE_RUN_RULES:
            if (not run_indexes or any(type(i) is not int or not 0 <= i < len(para.runs)
                                       for i in run_indexes) or len(set(run_indexes)) != len(run_indexes)):
                raise GuidedFixFailed("invalid run targets")
            if any(_unsafe_run(para.runs[i]) for i in run_indexes):
                raise GuidedFixFailed("unsafe run")
            if any(_unsupported_font_slots(para.runs[i], code) for i in run_indexes):
                raise GuidedFixFailed("unresolved alternate font slot")
        else:
            if raw is not None:
                raise GuidedFixFailed("paragraph target contains run indexes")
            run_indexes = [None]
        expected = bold_expected if code == "REFERENCE_HEADING_BOLD" else _resolve_expected(
            violation, audit, doc, roles[index] if index < len(roles) else None,
        )
        if expected is None:
            raise GuidedFixFailed("unresolved requirement")
        for run_index in run_indexes:
            key = (index, run_index, code)
            if key in targets:
                raise GuidedFixFailed("duplicate target")
            targets.add(key)
            property_key = (index, run_index, "ALIGNMENT" if code == "REFERENCE_HEADING_ALIGNMENT" else code)
            if property_key in property_targets:
                raise GuidedFixFailed("conflicting property targets")
            property_targets.add(property_key)
            parsed = paragraphs[index]["runs"][run_index] if run_index is not None else None
            if _current_changed_from_actual(code, paragraphs[index], parsed, violation.actual_value, para=para):
                raise GuidedFixFailed("source differs from finding")
            if _current_matches_expected(code, expected, paragraphs[index], parsed, para=para):
                raise GuidedFixFailed("already compliant")
        items.append({
            "violation_id": violation.id,
            "before": violation.actual_value,
            "after": violation.expected_value,
            "locations": ([f'Reference List heading "{para.text}" — Paragraph {index + 1}']
                          if code == "REFERENCE_HEADING_BOLD" else [f"Paragraph {index + 1}"]),
            "affected_count": 1 if code == "REFERENCE_HEADING_BOLD" else len(run_indexes),
            "property": ("Reference List heading bold (all heading text)"
                         if code == "REFERENCE_HEADING_BOLD" else code.lower().replace("_", " ")),
        })
    return items, targets


def apply_guided_fixes(
    audit: AuditRecord,
    source_bytes: bytes,
    violations: List[Violation],
) -> Tuple[bytes, List[Violation], List[Tuple[Violation, str]]]:
    """Apply whitelisted fixes to a parsed copy; return
    (corrected_bytes, applied, skipped). Never mutates source_bytes; never
    persists anything. Raises GuidedFixFailed on any unverifiable state."""
    _, reviewed_targets = review_targets(audit, source_bytes, violations)
    from app.services.role_classifier import classify_paragraphs

    doc = parse_document(source_bytes)
    paragraphs = extract_paragraphs(doc)
    roles = classify_paragraphs(doc, paragraphs)

    applied: List[Violation] = []
    skipped: List[Tuple[Violation, str]] = []
    failed: List[str] = []

    for violation in violations:
        rule_code = violation.rule_code
        if rule_code in SAFE_RUN_RULES:
            kind = "run"
        elif rule_code in SAFE_PARA_RULES:
            kind = "para"
        else:
            skipped.append((violation, "unsupported_rule"))
            continue

        location = violation.location if isinstance(violation.location, dict) else {}
        paragraph_index = location.get("paragraph_index")
        if not isinstance(paragraph_index, int) or isinstance(paragraph_index, bool):
            skipped.append((violation, "no_location"))
            continue
        if not (0 <= paragraph_index < len(doc.paragraphs)):
            skipped.append((violation, "target_missing"))
            continue

        para = doc.paragraphs[paragraph_index]
        para_dict = paragraphs[paragraph_index]
        role = roles[paragraph_index] if paragraph_index < len(roles) else None

        if _unsafe_paragraph(para):
            skipped.append((violation, "unsafe_structure"))
            continue

        run_indexes: Optional[List[int]] = None
        run_dict: Optional[Dict] = None
        if kind == "run":
            if rule_code == "REFERENCE_HEADING_BOLD":
                run_indexes, _ = _reference_heading_bold_targets(audit, doc, paragraphs, violation)
            else:
                raw = location.get("run_indexes")
                if isinstance(raw, list):
                    run_indexes = [i for i in raw if isinstance(i, int) and not isinstance(i, bool)]
                else:
                    raw = location.get("run_index")
                    if isinstance(raw, int) and not isinstance(raw, bool):
                        run_indexes = [raw]
            if not run_indexes:
                skipped.append((violation, "no_location"))
                continue
            valid = [i for i in run_indexes if 0 <= i < len(para.runs)]
            if not valid:
                skipped.append((violation, "target_missing"))
                continue
            run_indexes = valid

            runs = [para.runs[i] for i in run_indexes]
            if any(_unsafe_run(r) for r in runs):
                skipped.append((violation, "unsafe_structure"))
                continue
            run_dict = paragraphs[paragraph_index]["runs"][run_indexes[0]]

        # Document-changed gate: recomputed current vs persisted actual.
        if _current_changed_from_actual(rule_code, para_dict, run_dict, violation.actual_value, para=para):
            skipped.append((violation, "document_changed"))
            continue

        # Resolve the expected value (never guessed).
        expected = _resolve_expected(violation, audit, doc, role)
        if expected is None:
            skipped.append((violation, "expected_unresolved"))
            continue

        # Already compliant → no mutation.
        if _current_matches_expected(rule_code, expected, para_dict, run_dict, para=para):
            skipped.append((violation, "already_compliant"))
            continue

        # Apply.
        try:
            if rule_code == "FONT_SIZE":
                ok = all(_fix_font_size(r, expected) for r in runs)
            elif rule_code == "FONT_CONSISTENCY":
                ok = all(_fix_font_family(r, expected) for r in runs)
            elif rule_code == "ALIGNMENT":
                ok = _fix_alignment(para, expected)
            elif rule_code == "LINE_SPACING":
                ok = _fix_line_spacing(para, expected)
            elif rule_code == "SPACE_BEFORE":
                ok = _fix_space_before(para, expected)
            elif rule_code == "REFERENCE_HEADING_ALIGNMENT":
                ok = _fix_alignment(para, expected)
            elif rule_code == "REFERENCE_HEADING_BOLD":
                ok = all(_fix_reference_heading_bold(r, expected) for r in runs)
            else:  # SPACE_AFTER
                ok = _fix_space_after(para, expected)
        except Exception:
            failed.append(violation.id)
            break
        if not ok:
            failed.append(violation.id)
            break
        applied.append(violation)

    if failed or skipped or len(applied) != len(violations):
        raise GuidedFixFailed("not all selected findings could be applied")

    # Serialize to memory; the input bytes object is never touched.
    output = io.BytesIO()
    doc.save(output)
    corrected_bytes = output.getvalue()

    _validate_output(corrected_bytes, doc, applied, roles, audit, reviewed_targets)
    return corrected_bytes, applied, []


def _validate_output(corrected_bytes: bytes, source_doc, applied: List[Violation], roles: List[str], audit, reviewed_targets) -> None:
    """Reopen and verify every target's effective value, including grouped runs."""
    doc = parse_document(corrected_bytes)
    paragraphs = extract_paragraphs(doc)
    if len(doc.paragraphs) != len(source_doc.paragraphs):
        raise GuidedFixFailed("paragraph count changed")
    for violation in applied:
        location = violation.location
        index = location["paragraph_index"]
        expected = _resolve_expected(violation, audit, doc, roles[index] if index < len(roles) else None)
        if expected is None:
            raise GuidedFixFailed("requirement changed")
        if violation.rule_code == "REFERENCE_HEADING_BOLD":
            indexes = _reference_heading_bold_run_indexes(doc, paragraphs, index)
            reviewed = sorted(run for paragraph, run, rule in reviewed_targets
                              if paragraph == index and rule == "REFERENCE_HEADING_BOLD")
            before = source_doc.paragraphs[index]
            after = doc.paragraphs[index]
            if (indexes != reviewed or before.text != after.text or
                    [run.text for run in before.runs] != [run.text for run in after.runs] or
                    any(after.runs[i].font.bold is not expected for i in indexes)):
                raise GuidedFixFailed("incomplete Reference heading bold output")
            continue
        indexes = location.get("run_indexes", [location.get("run_index")]) if violation.rule_code in SAFE_RUN_RULES else [None]
        for run_index in indexes:
            if run_index is not None and (type(run_index) is not int or run_index >= len(paragraphs[index]["runs"])):
                raise GuidedFixFailed("run missing after save")
            run = paragraphs[index]["runs"][run_index] if run_index is not None else None
            if not _current_matches_expected(violation.rule_code, expected, paragraphs[index], run, para=doc.paragraphs[index]):
                raise GuidedFixFailed("target value differs after save")
