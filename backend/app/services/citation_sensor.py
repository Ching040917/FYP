"""Deterministic APA in-text citation ↔ Reference List sensor.

No LLM dependency. Scans body paragraphs for APA author–year citations,
parses the References/Bibliography block into normalized entries, and
compares both directions:

  citations → entries : CITATION_MISMATCH (MAJOR),
                        CITATION_REFERENCE_MISMATCH (MAJOR),
                        CITATION_YEAR_SUFFIX_MISMATCH (MINOR),
                        CITATION_REFERENCE_AMBIGUOUS (REVIEW);
  entries → citations : REFERENCE_NOT_CITED (MINOR),
                        REFERENCE_DUPLICATE (MINOR).

Missing References section → exactly one MAJOR CITATION_MISMATCH root
finding (no per-citation duplicates).

Everything here is deterministic and regex/structural: no fuzzy matching, no
similarity thresholds, no AI detection, no source invention. Profile toggles
(`config`, an EffectiveProfileConfig) enable/disable rules; severity is fixed
per rule and never configurable.

Output: LayoutViolation list compatible with the static rules engine.
"""
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from docx import Document

from app.services.citation_matching import (
    CitationMatchingRules,
    CitationRef,
    RULE_CITATION_MISMATCH,
    build_reference_index,
    make_key,
    match,
)
from app.services.layout_violation import LayoutViolation


# Pattern A: Narrative form  ->  Smith (2020)  or  Taylor & Green (2018)  or  Smith and Jones (2019)
# - One or more capitalized surnames joined by '&' or the word 'and'.
# - Group 1 captures the full chain; primary surname = first token before '&'/'and'.
# - Optional comma + page/locator after year, e.g.  "Smith (2020, p. 12)"
# Kept verbatim: the narrative-chain parser below is a superset (it also
# accepts "et al." and "n.d."), and this pattern is the documented baseline.
NARRATIVE_PATTERN = re.compile(
    r"\b([A-Z][a-zA-ZÀ-ſ'\-]+(?:\s*(?:&|and)\s+[A-Z][a-zA-ZÀ-ſ'\-]+)*)\s*"
    r"\((\d{4}[a-z]?)(?:,\s*[^)]*)?\)"
)

# Pattern B: Parenthetical form  ->  (Smith, 2020)  or  (Smith & Jones, 2020)
# Allows: surname [+ "et al."] [+ " & "+ other] + comma + 4-digit year + optional letter suffix
PARENTHETICAL_PATTERN = re.compile(
    r"\(\s*([A-Z][a-zA-ZÀ-ſ'\-]+)"
    r"(?:\s*(?:et\s+al\.|&\s+[A-Z][a-zA-ZÀ-ſ'\-]+))*"
    r"\s*,\s*(\d{4}[a-z]?)"
    r"(?:,\s*[^)]*)?\)"
)

# Section header words that mark the start of a reference list.
# Strict whole-paragraph match (case-insensitive, trimmed) — the paragraph
# text must be exactly one of these after numeric-prefix normalization.
# "References are listed below" is never a header.
REFERENCES_HEADER_PATTERN = re.compile(
    r"^(references|bibliography|works\s+cited|reference\s+list)$",
    re.IGNORECASE,
)

# Leading numbered-section prefix on a heading, e.g. "6 ", "6. ", "6.1 ".
# Removed from a heading candidate before the strict header match.
_NUMERIC_SECTION_PREFIX = re.compile(r"^\d+(?:\.\d+)*\.?\s+")

# Appendix headings terminate the reference-entry block: everything from
# an Appendix heading onward is not part of the bibliography.
APPENDIX_HEADER_PATTERN = re.compile(r"^appendix\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Container / item patterns (superset of the two baseline patterns above)
# ---------------------------------------------------------------------------

# Parenthetical container. Bounded at 300 characters: longer parentheticals
# are prose (or data dumps), never citation lists. Nested parentheses are not
# consumed — an inner citation is found by its own container match.
_PAREN_CONTAINER = re.compile(r"\(([^()]{1,300})\)")

# One item inside a parenthetical container, anchored: surname chain + comma +
# year (4 digits with optional suffix, or "n.d.") + optional locator tail.
# The tail may not cross an item separator (';').
_PAREN_ITEM = re.compile(
    r"\s*([A-Z][A-Za-zÀ-ſ'\-]+)"
    r"(?:\s*(?:[Ee]t\s+[Aa][Ll]\.|(?:&|and)\s+[A-Z][A-Za-zÀ-ſ'\-]+))*"
    r"\s*,\s*(\d{4}[a-z]?|n\.d\.)"
    r"(?:\s*,\s*[^;]*)?\s*"
)

# Narrative item: author chain immediately followed by a parenthesized year.
# The chain accepts "A", "A & B", "A and B", "A et al." and combinations.
_NARRATIVE_ITEM = re.compile(
    r"\b([A-Z][A-Za-zÀ-ſ'\-]+"
    r"(?:\s*(?:&|and)\s+[A-Z][A-Za-zÀ-ſ'\-]+|\s+[Ee]t\s+[Aa][Ll]\.)*)"
    r"\s*\((\d{4}[a-z]?|n\.d\.)(?:\s*,\s*[^)]*)?\)"
)

# Any capitalized token — used ONLY to collect exemption names from
# personal-communication / "as cited in" material.
_SURNAME_TOKEN = re.compile(r"[A-Z][A-Za-zÀ-ſ'\-]+")
_EXEMPT_IGNORE_TOKENS = frozenset({"personal", "communication"})

# Parentheticals that carry a URL/DOI are data references, never citations.
_URL_GUARD = re.compile(r"https?://|www\.|\bdoi\b|10\.\d{4}/", re.IGNORECASE)

# Chain starts that are document furniture, not authors: "Table 2 (2020)".
_STOPWORD_CHAIN_STARTS = frozenset({
    "table", "figure", "appendix", "section", "chapter", "equation", "note",
    "page", "step", "phase", "version", "source", "box", "exhibit", "column",
    "row", "item", "part", "annex", "schedule", "act", "regulation",
    "standard",
})

# Roles whose paragraphs are bibliography/furniture data, not body citations.
_CITATION_EXCLUDED_ROLES = frozenset({
    "REFERENCE_ENTRY", "REFERENCES_HEADING", "APPENDIX_HEADING",
    "APPENDIX_BODY", "EMPTY", "FIELD_ONLY",
})

# Any 4-digit year inside a personal-communication parenthetical.
_ANY_YEAR = re.compile(r"\b(\d{4})\b")

# The author chain that a personal-communication parenthetical names:
# "(J. Smith, personal communication, ...)" / "(Smith & Jones, personal …)".
_PC_AUTHOR_CHAIN = re.compile(
    r"([A-Z][A-Za-zÀ-ſ'\-]+(?:\s*(?:&|and)\s+[A-Z][A-Za-zÀ-ſ'\-]+)*)"
    r"\s*,\s*personal\s+communication",
    re.IGNORECASE,
)

_CHAIN_SPLIT = re.compile(r"\s+(?:&|and)\s+|\s+[Ee]t\s+[Aa][Ll]\.")


def _is_references_header(text: str) -> bool:
    """True when a paragraph is a References/Bibliography section header.

    Accepts bare headers ("References", "REFERENCES") and numbered heading
    forms ("6 References", "6. References", "6.1 References"). Only
    leading whitespace and one numeric section prefix are normalized away
    before the exact header match — body text such as "References are
    listed below" is never accepted, and no substring matching is used.
    """
    candidate = (text or "").strip()
    candidate = _NUMERIC_SECTION_PREFIX.sub("", candidate)
    return bool(REFERENCES_HEADER_PATTERN.match(candidate))


def _find_references_start(paragraphs: List[Dict[str, Any]]) -> Optional[int]:
    """Return the index of the first paragraph that is a References header.

    Returns None when no header exists — the sensor then reports a single
    root finding (the citations exist but there is nothing to compare them
    against) instead of one finding per citation.
    """
    for para in paragraphs:
        if _is_references_header(para.get("text")):
            return para["index"]
    return None


def reference_entry_paragraphs(paragraphs: List[Dict[str, Any]]) -> List[Tuple[int, str]]:
    """Return (paragraph_index, text) pairs of the bibliography block.

    The block starts AFTER the References header paragraph and ends at the
    first Appendix heading. Paragraph identity is preserved so findings can
    point at the exact entry paragraph.
    """
    start = _find_references_start(paragraphs)
    if start is None:
        return []

    entries: List[Tuple[int, str]] = []
    for para in paragraphs:
        idx = para.get("index")
        if idx is None or idx <= start:
            continue
        text = (para.get("text") or "").strip()
        if not text:
            continue
        # An Appendix heading ends the bibliography: reference entries live
        # between the References header and the first appendix.
        if APPENDIX_HEADER_PATTERN.match(text):
            break
        entries.append((idx, text))
    return entries


def _exempt_names_in(text: str) -> Set[str]:
    """Author keys named inside exempt material (personal comm / as cited in)."""
    return {
        token for token in _SURNAME_TOKEN.findall(text)
        if token.casefold() not in _EXEMPT_IGNORE_TOKENS
    }


def _personal_communication_names(text: str) -> List[str]:
    """Author names a personal-communication parenthetical attributes."""
    names: List[str] = []
    for chain in _PC_AUTHOR_CHAIN.findall(text):
        names.extend(part.strip() for part in _CHAIN_SPLIT.split(chain) if part.strip())
    return names


def _personal_communication_exemptions(text: str) -> Set[str]:
    """Names exempted by personal-communication material."""
    names = set(_personal_communication_names(text))
    return names or _exempt_names_in(text)


def _primary_surname(chain: str) -> str:
    """First surname of a narrative chain ("Taylor & Green" -> "Taylor")."""
    return _CHAIN_SPLIT.split(chain)[0]


@dataclass
class CitationScan:
    """Result of scanning one paragraph."""
    citations: List[CitationRef] = field(default_factory=list)
    exempt_author_keys: Set[str] = field(default_factory=set)


def _parse_parenthetical_items(
    content: str,
    whole_match: str,
    paragraph_index: Optional[int],
) -> List[CitationRef]:
    """Parse the ';'-separated items of one parenthetical container.

    A single item that spans the whole container keeps the container's exact
    source span as evidence ("(Garcia, 2018)"); grouped items keep their own
    item text (the parentheses belong to the group, not to one citation).
    """
    segments = content.split(";")
    parsed: List[Tuple[str, str, str]] = []
    for segment in segments:
        item = segment.strip()
        if not item:
            continue
        m = _PAREN_ITEM.fullmatch(item)
        if not m:
            continue
        parsed.append((item, m.group(1), m.group(2)))

    if not parsed:
        return []

    single = len(parsed) == 1 and len(segments) == 1
    return [
        CitationRef(
            author_display=surname,
            key=make_key(surname, year),
            paragraph_index=paragraph_index,
            snippet=whole_match if single else item_text,
        )
        for item_text, surname, year in parsed
    ]


def _personal_communication_items(
    content: str,
    whole_match: str,
    paragraph_index: Optional[int],
) -> List[CitationRef]:
    """Citations from a personal-communication parenthetical when the
    profile does NOT allow them: each named author is checked as a normal
    in-text citation against the Reference List."""
    years = _ANY_YEAR.findall(content)
    if not years:
        return []
    year = years[-1]
    return [
        CitationRef(
            author_display=name,
            key=make_key(name, year),
            paragraph_index=paragraph_index,
            snippet=whole_match,
        )
        for name in _personal_communication_names(content)
    ]


def scan_citations(
    text: str,
    paragraph_index: Optional[int] = None,
    rules: Optional[CitationMatchingRules] = None,
) -> CitationScan:
    """Scan one paragraph for in-text citations + exemption names.

    Guards: parentheticals longer than 300 characters, parentheticals
    carrying a URL/DOI, and document-furniture chains ("Table (2020)") never
    become citations. Personal-communication and "as cited in" material is
    exempted (and contributes names to the REFERENCE_NOT_CITED exemption set)
    unless the profile disallows personal communications.
    """
    rules = rules or CitationMatchingRules()
    scan = CitationScan()
    if not text:
        return scan

    consumed: List[Tuple[int, int]] = []

    for container in _PAREN_CONTAINER.finditer(text):
        content = container.group(1)
        if _URL_GUARD.search(content):
            continue
        lowered = content.casefold()
        whole_match = container.group(0)
        if "as cited in" in lowered:
            scan.exempt_author_keys |= _exempt_names_in(content)
            continue
        if "personal communication" in lowered:
            if rules.allow_personal_communication:
                scan.exempt_author_keys |= _personal_communication_exemptions(content)
                continue
            items = _personal_communication_items(content, whole_match, paragraph_index)
        else:
            items = _parse_parenthetical_items(content, whole_match, paragraph_index)
        if items:
            consumed.append(container.span())
            scan.citations.extend(items)

    for m in _NARRATIVE_ITEM.finditer(text):
        start = m.start()
        if any(s <= start < e for s, e in consumed):
            continue
        whole_match = m.group(0)
        lowered = whole_match.casefold()
        if "as cited in" in lowered:
            scan.exempt_author_keys |= _exempt_names_in(whole_match)
            continue
        if "personal communication" in lowered:
            if rules.allow_personal_communication:
                scan.exempt_author_keys |= _personal_communication_exemptions(whole_match)
                continue
        chain, year = m.group(1), m.group(2)
        primary = _primary_surname(chain)
        if primary.casefold() in _STOPWORD_CHAIN_STARTS:
            continue
        scan.citations.append(CitationRef(
            author_display=chain,
            key=make_key(primary, year),
            paragraph_index=paragraph_index,
            snippet=whole_match,
        ))

    return scan


def _missing_section_violation(citation_count: int) -> LayoutViolation:
    """One root finding for a document with citations and no References."""
    return LayoutViolation(
        rule_code=RULE_CITATION_MISMATCH,
        severity="MAJOR",
        location={"paragraph_index": None, "citation_count": citation_count},
        message=(
            f"No References section was found, so {citation_count} in-text "
            f"citation(s) could not be checked."
        ),
        expected_value="References section",
        actual_value=None,
    )


def run_citation_sensor(
    doc: Document,
    paragraphs: List[Dict[str, Any]],
    config: Any = None,
    roles: Optional[Sequence[Optional[str]]] = None,
) -> List[LayoutViolation]:
    """Entry point: detect in-text citations and compare them with the
    Reference List in both directions.

    `config` (optional) supplies the profile toggles (CITATION_* attributes
    on EffectiveProfileConfig); `roles` (optional) excludes bibliography and
    furniture paragraphs from citation scanning. `doc` is accepted for
    signature compatibility with the rules engine; detection is purely
    paragraph-text based.
    """
    rules = CitationMatchingRules.from_config(config)
    ref_start = _find_references_start(paragraphs)

    citations: List[CitationRef] = []
    exemptions: Set[str] = set()
    for position, para in enumerate(paragraphs):
        if roles is not None and position < len(roles) and roles[position] in _CITATION_EXCLUDED_ROLES:
            continue
        idx = para.get("index")
        if ref_start is not None and idx is not None and idx >= ref_start:
            continue
        text = para.get("text") or ""
        if not text:
            continue
        scan = scan_citations(text, idx, rules)
        citations.extend(scan.citations)
        exemptions |= scan.exempt_author_keys

    if ref_start is None:
        if not rules.check_citations_have_references or not citations:
            return []
        return [_missing_section_violation(len(citations))]

    index = build_reference_index(reference_entry_paragraphs(paragraphs))
    violations, _ = match(citations, index, rules, exemptions)
    return violations
