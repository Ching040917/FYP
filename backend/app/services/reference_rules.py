"""Reference List formatting rules (Phase 3) — deterministic and profile-driven.

Scope boundary
--------------
Phase 2 (`citation_sensor`) keeps every semantic citation ↔ Reference List
rule: missing section, unmatched citation, year/suffix mismatch, ambiguity,
uncited entry and duplicate entry. This module adds FORMATTING only. When no
supported Reference heading exists it emits nothing at all, so the Phase 2
root finding is never duplicated or double-deducted.

Evidence discipline
-------------------
Every rule reads the shared, read-only evidence modules and never invents a
value:

  * `reference_section` — where the section is, which paragraph is the
    heading, which paragraphs are entries, and what can be proven about the
    page the heading starts on;
  * `formatting_evidence` — indentation, paragraph format, effective
    alignment and bold, each with provenance.

`unresolved` is a first-class outcome and never means zero, left or
not-bold. A rule fires only on evidence that is actually resolved, so a
finding is always a statement the document supports. Uncertain, mixed and
numbered cases stay silent: this release has no review contract for them,
and a confusing "Manual review" flag is worse than no flag.

Consolidation
-------------
Entry-formatting findings are grouped by (rule code, normalised Current,
normalised Required), so a document with forty identically wrong entries
produces ONE finding that names the first entry, carries a truthful
occurrence count, and lists up to ten paragraph indexes. Heading and
new-page findings are inherently single and anchor at the heading.

Severity is MINOR for every definite finding. No new severity exists.
"""

from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.services.formatting_evidence import (
    SOURCE_UNRESOLVED,
    resolve_alignment,
    resolve_bold,
    resolve_indentation,
    resolve_paragraph_format,
)
from app.services.layout_violation import LayoutViolation
from app.services.reference_section import (
    PAGE_START_MAPPED_SAME_PAGE,
    REFERENCE_HEADING_ALIASES,
    classify_reference_page_start,
    normalise_reference_heading,
    reference_section_bounds,
)

# At most ten indexes travel with a consolidated finding; the occurrence
# count stays truthful even when the list is capped.
MAX_LOCATION_INDEXES = 10

# Comparison tolerances. Line spacing (0.1), paragraph spacing (1 pt) and
# font size (0.5 pt) reuse the tolerances the existing generic rules already
# use, so a Reference entry is judged exactly as strictly as body text.
# Indentation has no existing counterpart; 0.05 in is a twentieth of an
# inch — well below Word's own rounding when a user types "0.5" in a dialog.
HANGING_INDENT_TOLERANCE_IN = 0.05
LINE_SPACING_TOLERANCE = 0.1
SPACE_TOLERANCE_PT = 1.0
FONT_SIZE_TOLERANCE_PT = 0.5


def _flag(config: Any, name: str) -> bool:
    """Read a profile toggle. A legacy config without the field is off."""
    return bool(getattr(config, name, False))


def _required(config: Any, name: str) -> Optional[Any]:
    """Read a profile requirement; None means "no requirement configured"."""
    return getattr(config, name, None)


def _inches(value: float) -> str:
    return f"{value:g}in"


def _points(value: float) -> str:
    return f"{value:g}pt"


def _profile_label(config: Any) -> str:
    return getattr(config, "profile_label", None) or "the selected profile"


class _Consolidator:
    """One finding per (rule, current, required) group."""

    def __init__(self) -> None:
        self._groups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

    def add(
        self,
        rule_code: str,
        message: str,
        current: str,
        required: str,
        paragraph_index: int,
    ) -> None:
        key = (rule_code, current.strip().lower(), required.strip().lower())
        group = self._groups.get(key)
        if group is None:
            self._groups[key] = {
                "rule_code": rule_code,
                "message": message,
                "current": current,
                "required": required,
                "first": paragraph_index,
                "count": 1,
                "indexes": {paragraph_index},
            }
            return
        group["count"] += 1
        group["indexes"].add(paragraph_index)

    def violations(self) -> List[LayoutViolation]:
        out: List[LayoutViolation] = []
        for group in self._groups.values():
            indexes = sorted(group["indexes"])[:MAX_LOCATION_INDEXES]
            out.append(LayoutViolation(
                rule_code=group["rule_code"],
                severity="MINOR",
                location={
                    "paragraph_index": group["first"],
                    "occurrences": group["count"],
                    "paragraph_indexes": indexes,
                },
                message=group["message"],
                expected_value=group["required"],
                actual_value=group["current"],
            ))
        return out


def _heading_finding(
    rule_code: str,
    message: str,
    current: str,
    required: str,
    heading_index: int,
) -> LayoutViolation:
    return LayoutViolation(
        rule_code=rule_code,
        severity="MINOR",
        location={"paragraph_index": heading_index},
        message=message,
        expected_value=required,
        actual_value=current,
    )


# ---------------------------------------------------------------------------
# Heading rules
# ---------------------------------------------------------------------------


def _check_heading_text(heading: Dict[str, Any], bounds, config) -> List[LayoutViolation]:
    """REFERENCE_HEADING_TEXT — only when a heading already exists.

    A missing section is Phase 2's root finding; saying "the heading should
    read References" when there is no heading at all would be a second
    finding for one root cause.
    """
    if not _flag(config, "REFERENCES_CHECK_HEADING_TEXT"):
        return []
    required = _required(config, "REFERENCES_HEADING_TEXT")
    if not required:
        return []
    actual_text = (heading.get("text") or "").strip()
    actual_alias = normalise_reference_heading(actual_text)
    if actual_alias is not None:
        if actual_alias == required:
            return []
        if (
            _flag(config, "REFERENCES_ALLOW_HEADING_ALIASES")
            and actual_alias in REFERENCE_HEADING_ALIASES
        ):
            return []
    return [_heading_finding(
        rule_code="REFERENCE_HEADING_TEXT",
        message=(
            f'The Reference List heading reads "{actual_text}". The '
            f'{_profile_label(config)} profile requires "{required}".'
        ),
        current=actual_text,
        required=required,
        heading_index=bounds.heading_index,
    )]


def _check_heading_bold(heading_obj, bounds, config) -> List[LayoutViolation]:
    """REFERENCE_HEADING_BOLD — only on definitive evidence.

    Missing direct bold is not "not bold": a heading that inherits bold from
    its style is correct. Mixed runs stay silent rather than reporting a
    mismatch the document may not have.
    """
    if not _flag(config, "REFERENCES_CHECK_HEADING_BOLD") or heading_obj is None:
        return []
    expected_bold = bool(_required(config, "REFERENCES_HEADING_BOLD"))
    evidence = resolve_bold(heading_obj)
    if evidence.has_mixed or not evidence.is_resolved:
        return []
    if evidence.effective_bold == expected_bold:
        return []
    actual = "Bold" if evidence.effective_bold else "Not bold"
    required = "Bold" if expected_bold else "Not bold"
    return [_heading_finding(
        rule_code="REFERENCE_HEADING_BOLD",
        message=(
            f"The Reference List heading is {actual.lower()}. The "
            f"{_profile_label(config)} profile requires it to be {required.lower()}."
        ),
        current=actual,
        required=required,
        heading_index=bounds.heading_index,
    )]


def _check_heading_alignment(heading_obj, bounds, config) -> List[LayoutViolation]:
    """REFERENCE_HEADING_ALIGNMENT — unresolved alignment emits nothing."""
    if not _flag(config, "REFERENCES_CHECK_HEADING_ALIGNMENT") or heading_obj is None:
        return []
    required = _required(config, "REFERENCES_HEADING_ALIGNMENT")
    if not required:
        return []
    evidence = resolve_alignment(heading_obj)
    if not evidence.is_resolved or evidence.alignment == required:
        return []
    return [_heading_finding(
        rule_code="REFERENCE_HEADING_ALIGNMENT",
        message=(
            f"The Reference List heading is {evidence.alignment}-aligned. The "
            f"{_profile_label(config)} profile requires {required}-aligned."
        ),
        current=evidence.alignment.capitalize(),
        required=required.capitalize(),
        heading_index=bounds.heading_index,
    )]


# ---------------------------------------------------------------------------
# Section rule
# ---------------------------------------------------------------------------


def _check_new_page(
    paragraphs, bounds, config, paragraph_objs, page_mapping,
) -> List[LayoutViolation]:
    """REFERENCE_SECTION_NEW_PAGE — proven same-page starts only.

    Evidence precedence is the shared one: proven OOXML wins, then the
    rendered page mapping. `unavailable` and `uncertain` say nothing about
    the document, so they emit nothing; natural pagination is never reported
    as a missing explicit page break.
    """
    if not _flag(config, "REFERENCES_CHECK_START_ON_NEW_PAGE"):
        return []
    evidence = classify_reference_page_start(
        paragraphs,
        bounds.heading_index,
        page_mapping=page_mapping,
        paragraph_objs=paragraph_objs,
    )
    if evidence.state != PAGE_START_MAPPED_SAME_PAGE:
        return []
    return [_heading_finding(
        rule_code="REFERENCE_SECTION_NEW_PAGE",
        message=(
            "The Reference List starts on the same page as the text above it. "
            f"The {_profile_label(config)} profile requires the Reference List "
            "to start on a new page."
        ),
        current="Starts on the same page as preceding content",
        required="Start References on a new page",
        heading_index=bounds.heading_index,
    )]


# ---------------------------------------------------------------------------
# Entry rules
# ---------------------------------------------------------------------------


def _check_hanging_indent(entry_objects, config, consolidator: _Consolidator) -> None:
    if not _flag(config, "REFERENCES_CHECK_HANGING_INDENT"):
        return
    required = _required(config, "REFERENCES_HANGING_INDENT_IN")
    if required is None:
        return
    for index, obj in entry_objects:
        evidence = resolve_indentation(obj)
        # Numbered entries take their indent from the list definition, and
        # unresolved means the document never stated one. Neither is a
        # mismatch this release is willing to claim.
        if evidence.is_numbered or evidence.source == SOURCE_UNRESOLVED:
            continue
        actual = evidence.hanging_indent_in
        if actual is not None and abs(actual - required) <= HANGING_INDENT_TOLERANCE_IN:
            continue
        current = _inches(actual) if actual is not None else "No hanging indent"
        required_text = _inches(required)
        consolidator.add(
            "REFERENCE_HANGING_INDENT",
            (
                f"This reference entry uses {current}. The "
                f"{_profile_label(config)} profile requires {required_text}."
            ),
            current=current,
            required=required_text,
            paragraph_index=index,
        )


def _check_entry_spacing(entry_objects, config, consolidator: _Consolidator) -> None:
    before_required = _required(config, "REFERENCES_SPACE_BEFORE_PT")
    after_required = _required(config, "REFERENCES_SPACE_AFTER_PT")
    before_on = _flag(config, "REFERENCES_CHECK_SPACE_BEFORE") and before_required is not None
    after_on = _flag(config, "REFERENCES_CHECK_SPACE_AFTER") and after_required is not None
    if not (before_on or after_on):
        return
    for index, obj in entry_objects:
        evidence = resolve_paragraph_format(obj)
        if before_on:
            actual = evidence.space_before_pt
            if actual is not None and abs(actual - before_required) > SPACE_TOLERANCE_PT:
                current = _points(actual)
                required_text = _points(before_required)
                consolidator.add(
                    "REFERENCE_SPACE_BEFORE",
                    (
                        f"This reference entry uses {current} of space before it. The "
                        f"{_profile_label(config)} profile requires {required_text}."
                    ),
                    current=current,
                    required=required_text,
                    paragraph_index=index,
                )
        if after_on:
            actual = evidence.space_after_pt
            if actual is not None and abs(actual - after_required) > SPACE_TOLERANCE_PT:
                current = _points(actual)
                required_text = _points(after_required)
                consolidator.add(
                    "REFERENCE_SPACE_AFTER",
                    (
                        f"This reference entry uses {current} of space after it. The "
                        f"{_profile_label(config)} profile requires {required_text}."
                    ),
                    current=current,
                    required=required_text,
                    paragraph_index=index,
                )


def _check_fonts(entry_objects, config, consolidator: _Consolidator) -> None:
    family_required = _required(config, "REFERENCES_FONT_FAMILY")
    size_required = _required(config, "REFERENCES_FONT_SIZE_PT")
    family_on = _flag(config, "REFERENCES_CHECK_FONT_FAMILY") and bool(family_required)
    size_on = _flag(config, "REFERENCES_CHECK_FONT_SIZE") and size_required is not None
    if not (family_on or size_on):
        return
    for index, obj in entry_objects:
        evidence = resolve_paragraph_format(obj)
        if family_on:
            actual = evidence.effective_font_family
            if evidence.has_mixed_font_family:
                current = "Mixed font families"
                matches = False
            elif actual and actual.strip().lower() == family_required.strip().lower():
                current = actual
                matches = True
            elif actual:
                current = actual
                matches = False
            else:
                continue
            if not matches:
                consolidator.add(
                    "REFERENCE_FONT_FAMILY",
                    (
                        f"This reference entry uses {current}. The "
                        f"{_profile_label(config)} profile requires {family_required}."
                    ),
                    current=current,
                    required=family_required,
                    paragraph_index=index,
                )
        if size_on:
            actual_size = evidence.effective_font_size_pt
            if evidence.has_mixed_font_size:
                current = "Mixed font sizes"
                matches = False
            elif actual_size is None:
                continue
            elif abs(actual_size - size_required) <= FONT_SIZE_TOLERANCE_PT:
                current = _points(actual_size)
                matches = True
            else:
                current = _points(actual_size)
                matches = False
            if not matches:
                required_text = _points(size_required)
                consolidator.add(
                    "REFERENCE_FONT_SIZE",
                    (
                        f"This reference entry uses {current}. The "
                        f"{_profile_label(config)} profile requires {required_text}."
                    ),
                    current=current,
                    required=required_text,
                    paragraph_index=index,
                )


def _check_entry_alignment(entry_objects, config, consolidator: _Consolidator) -> None:
    if not _flag(config, "REFERENCES_CHECK_ALIGNMENT"):
        return
    required = _required(config, "REFERENCES_ALIGNMENT")
    if not required:
        return
    for index, obj in entry_objects:
        evidence = resolve_alignment(obj)
        if not evidence.is_resolved or evidence.alignment == required:
            continue
        current = evidence.alignment.capitalize()
        required_text = required.capitalize()
        consolidator.add(
            "REFERENCE_ALIGNMENT",
            (
                f"This reference entry is {current.lower()}-aligned. The "
                f"{_profile_label(config)} profile requires {required_text.lower()}."
            ),
            current=current,
            required=required_text,
            paragraph_index=index,
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_reference_rules(
    doc,
    paragraphs: Sequence[Dict[str, Any]],
    config: Any,
    page_mapping: Optional[Dict[int, int]] = None,
) -> List[LayoutViolation]:
    """Run every enabled Reference List formatting rule.

    `config` is the effective profile config. `page_mapping` is the optional
    rendered-page mapping ({paragraph_index: 1-based page}); without it the
    new-page rule has no rendered evidence and stays silent, which is the
    honest answer rather than a guess.
    """
    bounds = reference_section_bounds(paragraphs)
    if bounds is None:
        # No supported heading: Phase 2 owns the missing-section finding and
        # formatting rules have nothing to describe.
        return []

    # `extract_paragraphs` enumerates `doc.paragraphs`, so the parser index
    # IS the position in that list. The evidence helpers need the real
    # python-docx objects; without them the object-dependent evidence is
    # simply unavailable rather than guessed.
    paragraph_objs = {}
    try:
        paragraph_objs = {i: p for i, p in enumerate(doc.paragraphs)}
    except Exception:
        paragraph_objs = {}

    by_index = {p.get("index"): p for p in paragraphs}
    heading = by_index.get(bounds.heading_index)
    heading_obj = paragraph_objs.get(bounds.heading_index)
    entry_objects = [
        (idx, paragraph_objs[idx])
        for idx in bounds.entry_indexes
        if idx in paragraph_objs and by_index.get(idx) is not None
    ]

    violations: List[LayoutViolation] = []
    if heading is not None:
        violations.extend(_check_heading_text(heading, bounds, config))
    violations.extend(_check_heading_bold(heading_obj, bounds, config))
    violations.extend(_check_heading_alignment(heading_obj, bounds, config))
    violations.extend(_check_new_page(
        paragraphs, bounds, config, paragraph_objs, page_mapping,
    ))

    consolidator = _Consolidator()
    _check_hanging_indent(entry_objects, config, consolidator)
    _check_entry_spacing(entry_objects, config, consolidator)
    _check_fonts(entry_objects, config, consolidator)
    _check_entry_alignment(entry_objects, config, consolidator)
    violations.extend(consolidator.violations())
    return violations