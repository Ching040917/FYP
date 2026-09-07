"""Guided Fixes — safe, verification-bound formatting corrections (Beta).

A future frontend selects violation IDs after an audit; the user re-uploads
the exact original DOCX; the backend verifies SHA-256 identity and applies
only whitelisted formatting fixes to a NEW docx returned for download.

Design contract:
  - Client supplies violation IDs ONLY. All paragraph/run targets come from
    the persisted `Violation.location`; expected values are never guessed.
  - Whitelist is authoritative: FONT_CONSISTENCY / FONT_SIZE (run-level) and
    ALIGNMENT / LINE_SPACING / SPACE_BEFORE / SPACE_AFTER (paragraph-level).
    Everything else is skipped as `unsupported_rule`.
  - Fixers use python-docx direct formatting only: no run merge/split/delete/
    reorder, no shared-style edits, no highlight/shading changes.
  - Every fix is verified after application; any failure raises
    `GuidedFixFailed` (no partial output is ever returned).
  - The corrected DOCX is saved to an in-memory buffer and returned for
    download; it is NEVER persisted, and the audit row/violations/score are
    NEVER modified. The input bytes are never mutated.
  - Output validation reopens the corrected bytes and confirms paragraph/
    table text, counts, and relationships are unchanged; an applied fix is
    only reported when its target property verifiably equals the resolved
    expected value.
"""
import io
import json
import math
import re
import urllib.parse
import zipfile
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

SAFE_RUN_RULES = frozenset({"FONT_CONSISTENCY", "FONT_SIZE"})
SAFE_PARA_RULES = frozenset({"ALIGNMENT", "LINE_SPACING", "SPACE_BEFORE", "SPACE_AFTER"})

MISMATCH_DETAIL = (
    "The selected document does not match the document used for this audit. "
    "Upload the original DOCX file and try again."
)
LEGACY_DETAIL = "Guided Fixes is unavailable for audits created before document matching was introduced."
ZERO_DETAIL = "No selected Guided Fix could be applied safely. Review the skipped findings and correct them manually."
VERIFY_FAIL_DETAIL = "The corrected document could not be verified. No file was produced."

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


def _paragraph_texts_equal(a: List[str], b: List[str]) -> bool:
    return a == b


def _table_texts_equal(a: List[List[List[str]]], b: List[List[List[str]]]) -> bool:
    return a == b


def _rel_counts(doc) -> Tuple[int, int]:
    """(image_count, hyperlink_count) from the document part relationships."""
    images = 0
    hyperlinks = 0
    for rel in doc.part.rels.values():
        if "image" in rel.target_ref:
            images += 1
        if "hyperlink" in rel.reltype:
            hyperlinks += 1
    return images, hyperlinks


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
    if rule_code in SAFE_RUN_RULES:
        if run_dict is None:
            return False
        if rule_code == "FONT_SIZE":
            current = run_dict.get("effective_font_size")
            return current is not None and abs(current - expected) <= 0.5
        # FONT_CONSISTENCY
        current = run_dict.get("effective_font_name")
        return current is not None and current.lower() == expected.lower()
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
    """Corrected-download filename, always .docx, sanitized."""
    stem = (original_name or "").rsplit(".", 1)[0] if "." in (original_name or "") else (original_name or "")
    stem = _FILENAME_UNSAFE_RE.sub("_", stem)
    stem = re.sub(r"_{3,}", "_", stem).strip(" .")
    if not stem:
        stem = "document"
    return f"{stem}_ACA_corrected.docx"


def _content_disposition(filename: str) -> str:
    """ASCII-safe plain form + RFC 5987 filename* only when they differ."""
    ascii_form = filename.encode("ascii", errors="replace").decode("ascii").replace("?", "_")
    header = f'attachment; filename="{ascii_form}"'
    encoded = urllib.parse.quote(filename, safe="")
    if encoded != ascii_form:
        header += f"; filename*=UTF-8''{encoded}"
    return header


def _summary_header(applied: int, skipped: int, failed: int) -> str:
    """URL-encoded JSON summary — counts only, never IDs/text/filenames."""
    payload = json.dumps(
        {"applied": applied, "skipped": skipped, "failed": failed},
        separators=(",", ":"),
    )
    return urllib.parse.quote(payload)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def apply_guided_fixes(
    audit: AuditRecord,
    source_bytes: bytes,
    violations: List[Violation],
) -> Tuple[bytes, List[Violation], List[Tuple[Violation, str]]]:
    """Apply whitelisted fixes to a parsed copy; return
    (corrected_bytes, applied, skipped). Never mutates source_bytes; never
    persists anything. Raises GuidedFixFailed on any unverifiable state."""
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
            else:  # SPACE_AFTER
                ok = _fix_space_after(para, expected)
        except Exception:
            failed.append(violation.id)
            break
        if not ok:
            failed.append(violation.id)
            break
        applied.append(violation)

    if failed:
        raise GuidedFixFailed(
            f"Guided Fix failed for {len(failed)} finding(s); no output produced"
        )

    # Serialize to memory; the input bytes object is never touched.
    output = io.BytesIO()
    doc.save(output)
    corrected_bytes = output.getvalue()

    _validate_output(corrected_bytes, doc, applied, roles, audit)
    return corrected_bytes, applied, skipped


def _reopened_matches_expected(rule_code: str, expected: Any, para, para_dict: Dict, run_dict: Optional[Dict]) -> bool:
    """Verify the reopened output against the resolved expected value.
    Paragraph rules read the paragraph object's own properties —
    `extract_paragraphs` maps explicit zero lengths to None, so the dict
    view is unreliable for SPACE_* when the expected value is 0pt."""
    return _current_matches_expected(rule_code, expected, para_dict, run_dict, para=para)


def _validate_output(corrected_bytes: bytes, source_doc, applied: List[Violation], roles: List[str], audit) -> None:
    """Output validation: zip structure, text/rel preservation, and per-fix
    property verification. Raises GuidedFixFailed on any failure."""
    if not zipfile.is_zipfile(io.BytesIO(corrected_bytes)):
        raise GuidedFixFailed("output is not a zip archive")
    required = {
        "[Content_Types].xml",
        "word/document.xml",
        "_rels/.rels",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
        "word/settings.xml",
    }
    with zipfile.ZipFile(io.BytesIO(corrected_bytes)) as zf:
        names = set(zf.namelist())
        if not required.issubset(names):
            raise GuidedFixFailed("output zip missing required parts")

    doc2 = parse_document(corrected_bytes)
    paragraphs2 = extract_paragraphs(doc2)
    if len(doc2.paragraphs) != len(source_doc.paragraphs):
        raise GuidedFixFailed("paragraph count changed")
    if len(doc2.tables) != len(source_doc.tables):
        raise GuidedFixFailed("table count changed")
    if not _paragraph_texts_equal(
        [p.text for p in source_doc.paragraphs],
        [p.text for p in doc2.paragraphs],
    ):
        raise GuidedFixFailed("paragraph text changed")
    if not _table_texts_equal(
        [[[cell.text for cell in row.cells] for row in t.rows] for t in source_doc.tables],
        [[[cell.text for cell in row.cells] for row in t.rows] for t in doc2.tables],
    ):
        raise GuidedFixFailed("table text changed")
    if _rel_counts(doc2) != _rel_counts(source_doc):
        raise GuidedFixFailed("relationship counts changed")

    for violation in applied:
        rule_code = violation.rule_code
        location = violation.location if isinstance(violation.location, dict) else {}
        paragraph_index = location.get("paragraph_index")
        if not isinstance(paragraph_index, int):
            raise GuidedFixFailed("applied finding lost its location")
        para_dict2 = paragraphs2[paragraph_index]
        run_dict2 = None
        if rule_code in SAFE_RUN_RULES:
            raw = location.get("run_indexes")
            if isinstance(raw, list) and raw:
                first = raw[0]
            else:
                first = location.get("run_index")
            if isinstance(first, int) and first < len(para_dict2.get("runs", [])):
                run_dict2 = para_dict2["runs"][first]
        expected = _resolve_expected(violation, audit, doc2, roles[paragraph_index] if paragraph_index < len(roles) else None)
        if expected is None:
            raise GuidedFixFailed("applied finding no longer resolvable")
        if not _reopened_matches_expected(
            rule_code, expected, doc2.paragraphs[paragraph_index], para_dict2, run_dict2
        ):
            raise GuidedFixFailed(
                f"applied {rule_code} does not match expected after save"
            )
