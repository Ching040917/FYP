"""Reference List section detection — single shared owner.

Before this module the same question ("is this paragraph the References
heading, and where does the section end?") was answered twice:

  * `citation_sensor._is_references_header` used a regex over the aliases;
  * `role_classifier._is_references_heading_text` used set membership;
  * both modules each carried their own byte-identical copy of the
    numeric-section-prefix regex.

This module is the only place that answers it. `citation_sensor` and
`role_classifier` now delegate here, so the role assigned to a paragraph and
the span the citation sensor measures can no longer drift apart.

**Accepted aliases are unchanged.** The set below is exactly what
`role_classifier._REFERENCES_HEADERS` and `citation_sensor.
REFERENCES_HEADER_PATTERN` accepted before this module existed. `reference`
(singular) is deliberately NOT a matched alias — see
`REFERENCE_ALIASES_NOT_CURRENTLY_MATCHED` for why.

Matching is unchanged in every respect that was observable:
  * case-insensitive;
  * a whole-paragraph match, never a substring — "References are listed
    below" is still not a heading;
  * exactly one leading numeric section prefix is stripped first, so
    "6 References", "6. References" and "6.1 References" match while
    "6.1.1" inside a sentence does not.
"""

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.services.document_parser import get_heading_level

# Accepted heading aliases. Frozen set — the exact pre-existing vocabulary.
REFERENCE_HEADING_ALIASES = frozenset({
    "references",
    "bibliography",
    "works cited",
    "reference list",
})

# Recognised-but-not-matched aliases.
#
# "reference" (singular) is a plausible university heading but was NOT
# accepted by either consumer before this module, so accepting it now would
# silently change which paragraphs start a Reference List — and therefore
# every Phase 2 citation/reference finding in existing documents. It stays
# unmatched until a Custom Profile setting can enable it explicitly.
REFERENCE_ALIASES_NOT_CURRENTLY_MATCHED = frozenset({"reference"})

# One leading numeric section prefix on a heading: "6 ", "6. ", "6.1 ".
# Byte-identical to the two copies this module replaces.
NUMERIC_SECTION_PREFIX = re.compile(r"^\d+(?:\.\d+)*\.?\s+")

# An Appendix heading terminates the reference block. Identical to the
# sensor's boundary rule, which decides where the bibliography stops.
APPENDIX_HEADER_PATTERN = re.compile(r"^appendix\b", re.IGNORECASE)

# A rubric heading terminates the reference block, exactly as the role
# classifier already treats it (single owner moved here so the sensor and
# Phase 3 bounds agree with roles instead of drifting past rubric content).
_RUBRIC_HEADING_RE = re.compile(r"\brubric", re.IGNORECASE)

# Explicit structural headings terminate the References span. Only Heading
# 1/2/3 count: bold/centred/short Normal paragraphs, list paragraphs, and
# text that merely looks like a heading never terminate the span.
_TERMINATING_HEADING_LEVELS = frozenset({1, 2, 3})


def is_rubric_heading_text(text: Optional[str], style_name: Optional[str]) -> bool:
    """True when a paragraph is a rubric heading (heading style + rubric text).

    Mirrors the role classifier's rubric rule so both consumers share one
    definition. Plain-text "Rubric..." lines and non-rubric headings return
    False.
    """
    if get_heading_level(style_name) is None:
        return False
    return bool(_RUBRIC_HEADING_RE.search(text or ""))


def is_references_span_terminator(text: Optional[str], style_name: Optional[str] = None) -> bool:
    """True when a paragraph after the References heading ends the span.

    Structural evidence only, first match wins in document order:
      1. Appendix heading text (any style — preserved behavior);
      2. rubric heading (heading style + rubric text — role parity);
      3. explicit Heading 1/2/3 paragraph (new section started).
    Empty paragraphs never terminate (they are separators). Punctuation,
    author/year parsing, DOI/URL presence, and citation-key parsing never
    terminate the span.
    """
    stripped = (text or "").strip()
    if not stripped:
        return False
    if APPENDIX_HEADER_PATTERN.match(stripped):
        return True
    if get_heading_level(style_name) is None:
        return False
    if _RUBRIC_HEADING_RE.search(stripped):
        return True
    return get_heading_level(style_name) in _TERMINATING_HEADING_LEVELS

# Whitespace-tolerant alias match.
#
# This is a strict superset of the previous set-membership test: it accepts
# everything `"works cited" in {...}` accepted, plus multi-whitespace
# variants such as "works  cited". The citation sensor already behaved this
# way; only the role classifier gained the degenerate multi-space case, which
# no existing test, fixture or document depends on. `tests/
# test_reference_section.py::test_alias_parity_with_previous_consumers`
# pins the full corpus against both previous implementations.
_ALIAS_PATTERN = re.compile(
    r"^(?:references|bibliography|works\s+cited|reference\s+list)$",
    re.IGNORECASE,
)


def normalise_reference_heading(text: Optional[str]) -> Optional[str]:
    """Return the canonical lowercase alias for a Reference heading.

    Returns None when the paragraph is not a Reference List heading. One
    numeric section prefix is removed before matching, so callers that need
    the displayed heading text should read the paragraph rather than use
    this normalised form.
    """
    candidate = (text or "").strip()
    candidate = NUMERIC_SECTION_PREFIX.sub("", candidate)
    if not candidate:
        return None
    match = _ALIAS_PATTERN.match(candidate)
    return match.group(0).lower() if match else None


def is_reference_heading_text(text: Optional[str]) -> bool:
    """True when the whole paragraph is a Reference List heading."""
    return normalise_reference_heading(text) is not None


def find_reference_heading_index(paragraphs: Sequence[Dict[str, Any]]) -> Optional[int]:
    """Index of the first Reference List heading paragraph, else None.

    Unchanged from the sensor's `_find_references_start`, which is still
    exported under its original name for existing callers.
    """
    for para in paragraphs:
        idx = para.get("index")
        if idx is None:
            continue
        if is_reference_heading_text(para.get("text")):
            return idx
    return None


def is_appendix_heading_text(text: Optional[str]) -> bool:
    """True when a paragraph terminates the bibliography (an Appendix)."""
    stripped = (text or "").strip()
    return bool(APPENDIX_HEADER_PATTERN.match(stripped))


@dataclass(frozen=True)
class ReferenceSectionBounds:
    """Where the Reference List section sits in a document.

    Attributes:
        heading_index: paragraph index of the References heading.
        heading_alias: canonical alias that matched ("references", ...).
        first_entry_index: first paragraph index after the heading that is
            not an Appendix heading, or None when the section is empty.
        end_index: exclusive upper bound; the Appendix heading index when
            one exists, otherwise the paragraph count.
        entry_indexes: every non-empty paragraph index inside the span, in
            document order.
    """

    heading_index: int
    heading_alias: str
    first_entry_index: Optional[int]
    end_index: int
    entry_indexes: Tuple[int, ...]


def reference_section_bounds(
    paragraphs: Sequence[Dict[str, Any]],
) -> Optional[ReferenceSectionBounds]:
    """Resolve the Reference List span, or None when no heading is found.

    The span starts AT the heading and ends at the first structural
    terminator after it (Appendix heading, rubric heading, or explicit
    Heading 1/2/3 — see is_references_span_terminator), mirroring the
    boundary logic the role classifier uses. No entry is invented and no
    paragraph is reordered.
    """
    start = find_reference_heading_index(paragraphs)
    if start is None:
        return None

    heading_alias = normalise_reference_heading(
        next(
            p.get("text")
            for p in paragraphs
            if p.get("index") == start
        )
    )

    end_index = len(paragraphs)
    entry_indexes: List[int] = []
    for para in paragraphs:
        idx = para.get("index")
        if idx is None or idx <= start:
            continue
        text = (para.get("text") or "").strip()
        if is_references_span_terminator(text, para.get("style_name")):
            end_index = idx
            break
        if not text:
            # Empty paragraphs are skipped, never emitted as entries. They
            # are separators, not references.
            continue
        entry_indexes.append(idx)

    return ReferenceSectionBounds(
        heading_index=start,
        heading_alias=heading_alias or "",
        first_entry_index=entry_indexes[0] if entry_indexes else None,
        end_index=end_index,
        entry_indexes=tuple(entry_indexes),
    )



def reference_entry_indexes(paragraphs: Sequence[Dict[str, Any]]) -> Tuple[int, ...]:
    """Paragraph indexes of every Reference List entry, in document order.

    Returns () when no Reference List heading is present. This is a structure
    view only — it performs no rule evaluation and emits no finding.
    """
    bounds = reference_section_bounds(paragraphs)
    return bounds.entry_indexes if bounds is not None else ()


def reference_entry_pairs(
    paragraphs: Sequence[Dict[str, Any]],
) -> List[Tuple[int, str]]:
    """(paragraph_index, stripped_text) pairs for every Reference entry.

    This is the shared entry-selection loop that `citation_sensor.
    reference_entry_paragraphs` and `layout_engine._references_span`
    previously each carried as a private copy. The block starts after the
    heading and ends at the first Appendix heading; empty paragraphs are
    skipped and their identity is preserved for finding locations.
    """
    bounds = reference_section_bounds(paragraphs)
    if bounds is None:
        return []
    by_index = {p.get("index"): p for p in paragraphs}
    pairs: List[Tuple[int, str]] = []
    for idx in bounds.entry_indexes:
        text = (by_index.get(idx, {}).get("text") or "").strip()
        if text:
            pairs.append((idx, text))
    return pairs

# Page-start evidence --------------------------------------------------------
#
# Read-only classification. This module NEVER reports a violation: it records
# what the document and the rendered preview can prove, so a later rules
# branch can decide policy without re-deriving the evidence.


@dataclass(frozen=True)
class PageStartEvidence:
    """Whether the Reference heading provably starts a new page.

    Attributes:
        state: one of the PageStart* constants below.
        heading_index: the References heading this describes.
        heading_page: 1-based physical page, or None when unmapped.
        previous_body_index: last paragraph before the heading, or None.
        previous_body_page: its 1-based page, or None when unmapped.
        has_explicit_page_break: a `w:br type="page"` run in the heading.
        has_page_break_before: the heading's `w:pageBreakBefore` property.
    """

    state: str
    heading_index: int
    heading_page: Optional[int] = None
    previous_body_index: Optional[int] = None
    previous_body_page: Optional[int] = None
    has_explicit_page_break: bool = False
    has_page_break_before: bool = False


# A page break is proven by OOXML on the heading itself.
PAGE_START_EXPLICIT_NEW_PAGE = "explicit_new_page"
# The rendered preview maps the heading to a later page than the preceding
# body paragraph. This is weaker evidence: pagination can be natural.
PAGE_START_MAPPED_NEW_PAGE = "mapped_new_page"
# The rendered preview places both on the same physical page.
PAGE_START_MAPPED_SAME_PAGE = "mapped_same_page"
# Nothing can be proven either way — no mapping and no explicit break.
PAGE_START_UNAVAILABLE = "unavailable"
# Evidence conflicts or is partial (e.g. mapping without a predecessor).
PAGE_START_UNCERTAIN = "uncertain"


def _explicit_break_in_paragraph(paragraph_obj: Any) -> bool:
    """True when the paragraph carries a `w:br w:type="page"` run."""
    try:
        from docx.oxml.ns import qn

        brs = paragraph_obj._p.findall(".//" + qn("w:br"))
    except Exception:
        return False
    for br in brs:
        if br.get(qn("w:type")) == "page":
            return True
    return False



def _as_index(key: Any) -> Optional[int]:
    """Paragraph index from a mapping key, whatever shape it arrives in."""
    try:
        return int(key)
    except (TypeError, ValueError):
        return None


def classify_reference_page_start(
    paragraphs: Sequence[Dict[str, Any]],
    heading_index: int,
    page_mapping: Optional[Dict[int, int]] = None,
    paragraph_objs: Optional[Dict[int, Any]] = None,
) -> PageStartEvidence:
    """Classify what can be proven about the References heading's page start.

    Precedence — explicit OOXML always wins, because natural pagination can
    never manufacture an explicit break:

      1. explicit page break run, or pageBreakBefore on the heading
         → PAGE_START_EXPLICIT_NEW_PAGE
      2. otherwise, if the rendered mapping places the heading on a strictly
         later page than the previous body paragraph → PAGE_START_MAPPED_NEW_PAGE
      3. same physical page under the mapping → PAGE_START_MAPPED_SAME_PAGE
      4. no mapping at all → PAGE_START_UNAVAILABLE
      5. a mapping that knows the heading but not its predecessor
         → PAGE_START_UNCERTAIN

    Mapped evidence is read in two ways. The heading's OWN mapping wins when
    the matcher resolved it. When it did not — the word "References" is
    short and generic, so it is dropped as ambiguous whenever the same
    wording also appears on another rendered page — the heading's page is
    taken from the paragraphs that bracket it: when the nearest mapped
    paragraph above and the nearest mapped paragraph below agree on one
    page, the heading between them renders on that page (page order is
    monotonic). Disagreeing brackets stay unresolved. The same rule covers a
    preceding paragraph that is itself unmapped: the comparison falls back to
    the nearest mapped paragraph above the heading instead of giving up.
    Mappings are accepted with string or integer keys.

    A missing mapping never implies a violation, and a later page never
    implies an explicit break: the two states stay distinguishable.

    `paragraph_objs` maps a parser paragraph index (the position within
    `doc.paragraphs`, as used by `extract_paragraphs`) to the python-docx
    object. Passing objects positionally is not supported because a raw XML
    position counts tables and content controls too, and would silently
    mismatch the parser's numbering.
    """
    objs = paragraph_objs or {}
    heading_obj = objs.get(heading_index)

    has_break_before = False
    has_explicit_break = False
    if heading_obj is not None:
        try:
            has_break_before = bool(heading_obj.paragraph_format.page_break_before)
        except Exception:
            has_break_before = False
        has_explicit_break = _explicit_break_in_paragraph(heading_obj)
    previous_body_index: Optional[int] = None
    for para in paragraphs:
        idx = para.get("index")
        if idx is None:
            # An index-less paragraph (e.g. a synthetic/degenerate entry)
            # proves nothing and must not abort the scan: skipping it keeps
            # the selection of the LAST eligible content paragraph before
            # the heading honest, so a proven same-page start is not turned
            # into "uncertain" by an unrelated gap.
            continue
        if idx >= heading_index:
            # `extract_paragraphs` emits strictly ascending indexes, so the
            # heading is the first paragraph at or past it and nothing later
            # can precede it. Selection is therefore the highest index below
            # the heading that carries text.
            break
        if (para.get("text") or "").strip():
            if previous_body_index is None or idx > previous_body_index:
                previous_body_index = idx

    # A persisted mapping is JSON-shaped ({"3": 7}); a mapping built in
    # memory is int-keyed. Both are accepted, because guessing one shape
    # would silently turn a proven same-page start into "unavailable".
    mapping = {
        index: value
        for index, value in (
            (_as_index(key), value) for key, value in (page_mapping or {}).items()
        )
        if index is not None
    }
    heading_page = mapping.get(heading_index)
    previous_body_page = (
        mapping.get(previous_body_index) if previous_body_index is not None else None
    )

    # The heading's own text is short and generic ("References"), so the
    # rendered matcher can leave it UNMAPPED when the same wording also
    # occurs elsewhere in the PDF (a body cross-reference, back matter) —
    # the containing page is then ambiguous and the heading is dropped.
    # A paragraph sitting strictly between two MAPPED paragraphs of one page
    # renders on that page: page order is monotonic, so the heading's page is
    # proven by bracketing rather than guessed at. Brackets on different
    # pages prove nothing (the heading could be on either) and stay unresolved.
    if heading_page is None:
        mapped_below = [index for index in mapping if index < heading_index]
        mapped_above = [index for index in mapping if index > heading_index]
        if mapped_below and mapped_above:
            below_page = mapping[max(mapped_below)]
            above_page = mapping[min(mapped_above)]
            if below_page == above_page:
                heading_page = below_page

    # The selected preceding paragraph can itself be unmapped (short or
    # ambiguous text). Rather than turning the comparison "uncertain", use the
    # nearest mapped paragraph above the heading: page order is monotonic, so
    # everything between that paragraph and the heading shares its page
    # whenever the heading does. Selection and page stay a matched pair.
    if previous_body_page is None:
        mapped_below = [index for index in mapping if index < heading_index]
        if mapped_below:
            nearest = max(mapped_below)
            previous_body_index = nearest
            previous_body_page = mapping[nearest]

    base = dict(
        heading_index=heading_index,
        heading_page=heading_page,
        previous_body_index=previous_body_index,
        previous_body_page=previous_body_page,
        has_explicit_page_break=has_explicit_break,
        has_page_break_before=has_break_before,
    )

    if has_explicit_break or has_break_before:
        return PageStartEvidence(state=PAGE_START_EXPLICIT_NEW_PAGE, **base)
    if heading_page is None:
        return PageStartEvidence(state=PAGE_START_UNAVAILABLE, **base)
    if previous_body_index is None or previous_body_page is None:
        return PageStartEvidence(state=PAGE_START_UNCERTAIN, **base)
    if heading_page > previous_body_page:
        return PageStartEvidence(state=PAGE_START_MAPPED_NEW_PAGE, **base)
    return PageStartEvidence(state=PAGE_START_MAPPED_SAME_PAGE, **base)
