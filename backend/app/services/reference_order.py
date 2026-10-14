"""Reference List alphabetical-order review — reliable author identities only.

Deterministic, offline and profile-gated. Compares ADJACENT Reference List
entries in document order using author-level sort identities only:

  * personal entries reuse the existing normalized first-surname key
    (NFC, casefolded, curly apostrophes straightened, `-`/`'` kept);
  * institutional entries reuse the existing full-phrase normalized key
    (never a final-token alias).

Out of scope for this phase (never compared): years, year suffixes, full
coauthor lists, titles, publisher text, DOI/URL values and n.d. ordering.
An n.d. entry still participates in AUTHOR comparison when its author
identity is reliable — its year is ignored. Equal author keys always stay
silent: same-author pairs, same-first-surname pairs with unknown or
different coauthors, and exact duplicate keys (which belong to
REFERENCE_DUPLICATE).

Numbered lists are excluded entirely. Any unreliable entry (parse failure,
lowercase-particle name, title-first text, separator-less phrase,
unsupported anonymous/title-like form, typed or styled numbering) breaks
adjacency — entries are never compared across a gap. Ambiguous and
unsupported cases stay silent; this phase emits no REVIEW findings.

One MINOR finding per proven adjacent inversion, placed on the later
physical entry. No reordering, no rewriting, no source mutation.
"""

import re
from typing import Any, Dict, List, Optional, Sequence

from app.services.citation_matching import MAX_EVIDENCE_CHARS, parse_reference_entry
from app.services.formatting_evidence import style_chain_has_numbering
from app.services.layout_violation import LayoutViolation
from app.services.reference_section import reference_section_bounds

RULE_REFERENCE_ORDER = "REFERENCE_ORDER"

# Manually typed numbering/bullet prefixes ("1. ", "6.1 ", "- ", "[12] ").
# Style-inherited numbering (List Number, direct <w:numPr>) is detected from
# the paragraph objects via `is_list_item` / the style chain below; this
# pattern covers numbering typed as entry text.
_NUMBER_PREFIX_RE = re.compile(r"^(?:\d+(?:\.\d+)*\.?\s+|\[\d+\]\s+|[•\-*]\s+)")

_REQUIRED_TEXT = "Arrange Reference List entries alphabetically by author"


def _profile_label(config: Any) -> str:
    return getattr(config, "profile_label", None) or "the selected profile"


def _excerpt(text: str) -> str:
    """Bounded visible excerpt of one entry (whitespace-collapsed)."""
    collapsed = " ".join((text or "").split())
    return collapsed[:MAX_EVIDENCE_CHARS]


def author_sort_identity(
    text: str,
    paragraph: Optional[Dict[str, Any]] = None,
    paragraph_obj: Any = None,
) -> Optional[str]:
    """Reliable author-level sort identity for one entry, or None.

    Returns the existing normalized author key (first surname or full
    institutional phrase) when — and only when — the entry is keyable AND
    unnumbered. Numbered entries, parse failures and every other
    unsupported shape yield None so the caller breaks adjacency.
    """
    stripped = (text or "").strip()
    if not stripped:
        return None
    # Numbered lists are excluded: direct numbering, style-inherited
    # numbering, or numbering typed as entry text.
    if paragraph is not None and bool(paragraph.get("is_list_item")):
        return None
    if paragraph_obj is not None:
        try:
            if style_chain_has_numbering(paragraph_obj):
                return None
        except Exception:
            pass
    if _NUMBER_PREFIX_RE.match(stripped):
        return None
    entry = parse_reference_entry(stripped, None)
    if entry is None:
        return None
    return entry.key.author_key or None


def run_reference_order(
    doc: Any,
    paragraphs: Sequence[Dict[str, Any]],
    config: Any,
) -> List[LayoutViolation]:
    """Emit one MINOR finding per proven adjacent author-key inversion.

    Runs only when the profile toggle is on. Uses the shared Reference
    section bounds and existing paragraph identities; emits nothing when no
    supported heading exists (Phase 2 owns the missing-section finding).
    """
    if not bool(getattr(config, "REFERENCES_CHECK_REFERENCE_ORDER", False)):
        return []
    bounds = reference_section_bounds(paragraphs)
    if bounds is None:
        return []

    by_index = {p.get("index"): p for p in paragraphs}
    paragraph_objs: Dict[Any, Any] = {}
    try:
        paragraph_objs = {i: p for i, p in enumerate(doc.paragraphs)}
    except Exception:
        paragraph_objs = {}

    violations: List[LayoutViolation] = []
    have_previous = False
    previous_key = ""
    for index in bounds.entry_indexes:
        paragraph = by_index.get(index)
        if paragraph is None:
            have_previous = False
            continue
        key = author_sort_identity(
            paragraph.get("text") or "",
            paragraph,
            paragraph_objs.get(index),
        )
        if key is None:
            # Unreliable entry: break adjacency, never compare across it.
            have_previous = False
            continue
        if have_previous and previous_key != key and previous_key > key:
            violations.append(LayoutViolation(
                rule_code=RULE_REFERENCE_ORDER,
                severity="MINOR",
                location={"paragraph_index": index},
                message=(
                    "This Reference List entry is out of alphabetical order. "
                    f"The {_profile_label(config)} profile requires Reference "
                    "List entries to be arranged alphabetically by author."
                ),
                expected_value=_REQUIRED_TEXT,
                actual_value=_excerpt(paragraph.get("text") or ""),
            ))
        previous_key = key
        have_previous = True
    return violations
