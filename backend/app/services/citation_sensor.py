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
    CitationKey,
    CitationMatchingRules,
    CitationRef,
    RULE_CITATION_MISMATCH,
    build_reference_index,
    has_institution_keyword,
    make_key,
    match,
    normalise_institutional_author,
    split_year_token,
)

from app.services.reference_section import (
    is_reference_heading_text,
    reference_entry_pairs,
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

# Personal multi-author chains keep existing behavior exactly and are never
# reinterpreted as institutions: exactly two surnames joined by &/and, or a
# surname with et al.
_PERSONAL_MULTI_RE = re.compile(
    r"[A-Z][A-Za-zÀ-ſ'\-]+(?:\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ſ'\-]+|\s+[Ee]t\s+[Aa][Ll]\.)+"
)

# Bounded author-resolution context ends at these clause boundaries. There
# is no sentence segmenter in this pipeline; the terminator set is local to
# institutional resolution and never reused for detection.
_CLAUSE_END_RE = re.compile(r"[.!?…;\n:]")

# Capitalized token for left extension (same alphabet as the detectors).
_CAP_TOKEN_RE = re.compile(r"[A-Z][A-Za-zÀ-ſ'\-]*$")

# Lowercase connectors allowed inside an institutional run only when
# flanked by capitalized tokens on both sides.
_RUN_CONNECTORS = frozenset({"and", "&", "of", "for", "the"})


def author_resolution_context(paragraph_text: str, chain_start: int) -> str:
    """Bounded paragraph slice immediately before a detected author chain.

    Starts after the last clause terminator before `chain_start` (or at the
    paragraph start) and ends exactly at `chain_start`. Used only for
    institutional candidate resolution — never for spans, locations, or
    evidence.
    """
    before = (paragraph_text or "")[:max(0, chain_start)]
    cuts = [m.end() for m in _CLAUSE_END_RE.finditer(before)]
    start = cuts[-1] if cuts else 0
    return before[start:]


def extend_institutional_run(context: str, chain: str) -> Tuple[str, int]:
    """Extend a detected chain leftwards over institutional author tokens.

    Returns (run_display, run_start): the full run display and its
    character offset inside `context` (== len(context) when unextended).
    Personal multi-author chains ("Smith and Lee", "Smith et al.") always
    return (chain, len(context)). Extension walks whole
    whitespace-separated tokens: capitalized tokens are accepted; lowercase
    tokens only as flanked connectors. The walk stops at the first token
    that qualifies neither, so ordinary preceding prose is never absorbed.
    """
    end = len(context)
    if _PERSONAL_MULTI_RE.fullmatch(chain or ""):
        return chain, end
    # Token offsets within context (whitespace gaps preserved verbatim).
    spans = [(m.group(0), m.start()) for m in re.finditer(r"\S+", context)]
    if not spans:
        return chain, end
    accepted_start = end
    i = len(spans) - 1
    while i >= 0:
        tok, pos = spans[i]
        if _CAP_TOKEN_RE.match(tok):
            accepted_start = pos
            i -= 1
            continue
        if (
            tok in _RUN_CONNECTORS
            and i > 0
            and _CAP_TOKEN_RE.match(spans[i - 1][0])
        ):
            # Connector needs a capitalized left flank too; the right flank
            # is guaranteed by construction (everything accepted so far is
            # capitalized, ending at the chain start).
            accepted_start = pos
            i -= 1
            continue
        break
    if accepted_start >= end:
        return chain, end
    run_display = (context[accepted_start:].strip() + " " + chain).strip()
    # A run that adds nothing meaningful keeps the original chain.
    if len(run_display.split()) < 2:
        return chain, end
    return run_display, accepted_start


def _is_references_header(text: str) -> bool:
    """True when a paragraph is a References/Bibliography section header.

    Delegates to `app.services.reference_section`, the single owner of the
    accepted alias vocabulary. Behaviour is unchanged: case-insensitive,
    whole-paragraph match after stripping one leading numeric section prefix,
    so body text such as "References are listed below" is still rejected.
    """
    return is_reference_heading_text(text)


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

    Delegates to the shared boundary owner in
    `app.services.reference_section`: the block starts after the References
    heading and ends at the first Appendix heading; paragraph identity is
    preserved so findings can point at the exact entry paragraph. Behaviour
    is unchanged — see `tests/test_reference_structure_regression.py`.
    """
    return reference_entry_pairs(paragraphs)





def _primary_surname(chain: str) -> str:
    """First surname of a narrative chain ("Taylor & Green" -> "Taylor")."""
    return _CHAIN_SPLIT.split(chain)[0]

def _personal_communication_names(text: str) -> List[str]:
    """Author names a personal-communication parenthetical attributes."""
    names: List[str] = []
    for chain in _PC_AUTHOR_CHAIN.findall(text):
        names.extend(part.strip() for part in _CHAIN_SPLIT.split(chain) if part.strip())
    return names


@dataclass
class CitationScan:
    """Result of scanning one paragraph."""
    #: Citation occurrences that were detected but must NOT be compared
    #: against the Reference List — a personal communication or a secondary
    #: "as cited in" citation. They are excluded per occurrence; no
    #: author-wide or document-wide exemption is ever derived from them, so
    #: an unrelated work by the same author is never treated as cited.
    unsupported: int = 0
    citations: List[CitationRef] = field(default_factory=list)


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
        # Institutional fallback (additive): a multi-word author phrase the
        # strict item grammar cannot parse, e.g. "Institutional Standards
        # Board, 2021". The container was already detected, so no new span
        # is claimed; the segment resolves only against an exact
        # same-year institutional candidate later, otherwise it stays
        # dropped exactly as before.
        if len(segments) == 1:
            return _institutional_parenthetical_items(
                segments[0], whole_match, paragraph_index,
            )
        return []

    single = len(parsed) == 1 and len(segments) == 1

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


def _institutional_parenthetical_items(
    segment: str,
    whole_match: str,
    paragraph_index: Optional[int],
) -> List[CitationRef]:
    """Candidate institutional citation inside one parenthetical container.

    Strict shape only: `<Phrase>, <year>` with a bare year token, a
    2–6 token author phrase of capitalized words and flanked connectors,
    no digits, no sentence punctuation. The snippet is the whole container
    (verbatim). Resolution against the Reference index happens later; an
    unmatched phrase is dropped exactly as an unparsable segment was.
    """
    item = (segment or "").strip()
    if "," not in item:
        return []
    author_part, year_part = item.rsplit(",", 1)
    author_part = author_part.strip()
    year_part = year_part.strip()
    if not re.fullmatch(r"(\d{4}[a-z]?|n\.d\.)", year_part):
        return []
    tokens = author_part.split()
    if not (2 <= len(tokens) <= 6):
        return []
    if re.search(r"\d", author_part):
        return []
    if re.search(r"[.!?;:]", author_part):
        return []
    if not _CAP_TOKEN_RE.match(tokens[0]):
        return []
    if not _CAP_TOKEN_RE.match(tokens[-1]):
        return []
    for i, tok in enumerate(tokens):
        if _CAP_TOKEN_RE.match(tok):
            continue
        if tok in _RUN_CONNECTORS and i > 0 and _CAP_TOKEN_RE.match(tokens[i - 1]):
            # Final token is capitalized by the check above, so the right
            # flank holds whenever iteration reaches the last position.
            continue
        return []
    return [
        CitationRef(
            author_display=author_part,
            key=make_key(tokens[-1], year_part),
            paragraph_index=paragraph_index,
            snippet=whole_match,
            institutional_phrase=author_part,
        )
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
    """Scan one paragraph for supported in-text citations.

    Guards: parentheticals longer than 300 characters, parentheticals
    carrying a URL/DOI, and document-furniture chains ("Table (2020)") never
    become citations. A personal-communication parenthetical and a secondary
    "as cited in" citation are UNSUPPORTED occurrences: they are counted but
    never become citation keys, so they produce no finding and — crucially —
    never mark any Reference List entry as cited. No author-wide or
    document-wide exemption is derived from them. A personal communication
    becomes a checked citation only when the profile disallows them.
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
            scan.unsupported += 1
            continue
        if "personal communication" in lowered:
            if rules.allow_personal_communication:
                scan.unsupported += 1
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
            scan.unsupported += 1
            continue
        if "personal communication" in lowered and rules.allow_personal_communication:
            scan.unsupported += 1
            continue
        chain, year = m.group(1), m.group(2)
        primary = _primary_surname(chain)
        if primary.casefold() in _STOPWORD_CHAIN_STARTS:
            continue
        context = author_resolution_context(text, m.start(1))
        run_display, run_start = extend_institutional_run(context, chain)
        # Extension takes effect only with a generic organization noun in
        # the run: capitalized ordinary prose ("Later Smith") keeps the
        # existing final-token behavior, while candidate proof later
        # decides matching. Without this gate every capitalized word
        # before a citation would rewrite its identity.
        if run_start < len(context) and has_institution_keyword(run_display):
            phrase = run_display
        else:
            phrase = ""
        scan.citations.append(CitationRef(
            author_display=chain,
            key=make_key(primary, year),
            paragraph_index=paragraph_index,
            snippet=whole_match,
            context=context,
            institutional_phrase=phrase,
        ))

    return scan


def resolve_institutional_citations(
    citations: Sequence[CitationRef],
    paragraph_texts: Optional[Dict[int, str]],
    index: Any,
) -> List[CitationRef]:
    """Resolve candidate institutional authors against the Reference index.

    Pure function (no I/O). For citations carrying an institutional phrase,
    the full normalized phrase becomes the author key — personal surname
    keys can never collide with it because they contain no spaces:
      - exact same-year institutional candidate → full institutional
        identity (display, key, verbatim reconstructed snippet);
      - narrative phrase without a candidate → multi-token fallback key
        (mismatch keeps the full source-faithful text, never a personal
        surname match);
      - parenthetical phrase without a candidate → dropped, exactly as an
        unparsable segment was before (silence preserved).
    Citations without a phrase, and calls without paragraph texts or an
    index, pass through byte-identically.
    """
    if paragraph_texts is None or index is None:
        return list(citations)
    resolved: List[CitationRef] = []
    for cite in citations:
        phrase = cite.institutional_phrase or ""
        if not phrase:
            resolved.append(cite)
            continue
        display = phrase.strip()
        norm = normalise_institutional_author(display)
        year_key = cite.key.year_key
        suffix = cite.key.suffix
        candidates = [
            e for e in getattr(index, "entries", [])
            if e.key.year_key == year_key and " " in e.key.author_key
        ]
        exact = [
            e for e in candidates
            if e.key.author_key == norm and e.key.suffix == suffix
        ]
        if cite.context:
            # Narrative: recompute the run from the stored context so the
            # snippet reconstruction is a verbatim source slice.
            run_display, run_start = extend_institutional_run(cite.context, cite.author_display)
            if run_display.strip() != display:
                resolved.append(cite)
                continue
            snippet = cite.context[run_start:] + cite.snippet
        else:
            # Parenthetical: the whole container is already the verbatim
            # span; without a candidate the prior silence is preserved.
            if not exact:
                continue
            snippet = cite.snippet
        resolved.append(CitationRef(
            author_display=display,
            key=CitationKey(norm, year_key, suffix),
            paragraph_index=cite.paragraph_index,
            snippet=snippet,
        ))
    return resolved


def _first_citation_paragraph(citations: List[CitationRef]) -> Optional[int]:
    """Earliest paragraph index carrying a supported citation, or None.

    Citations arrive in document order, so the first entry with a paragraph
    identity is the primary occurrence. Only returns None when no supported
    citation carries a paragraph index at all.
    """
    for citation in citations:
        if citation.paragraph_index is not None:
            return citation.paragraph_index
    return None


def _missing_section_violation(
    citation_count: int,
    paragraph_index: Optional[int],
) -> LayoutViolation:
    """One root finding for a document with citations and no References.

    The primary location is the FIRST supported citation occurrence, so the
    finding stays navigable: page mapping, evidence highlighting and document
    navigation all key on `paragraph_index`. `missing_references_section`
    marks the document-wide cause; `paragraph_index` is null only when no
    supported citation carries a paragraph identity.
    """
    return LayoutViolation(
        rule_code=RULE_CITATION_MISMATCH,
        severity="MAJOR",
        location={
            "paragraph_index": paragraph_index,
            "citation_count": citation_count,
            "missing_references_section": True,
        },
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
    unsupported = 0
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
        unsupported += scan.unsupported

    if ref_start is None:
        if not rules.check_citations_have_references or not citations:
            return []
        return [_missing_section_violation(len(citations), _first_citation_paragraph(citations))]

    index = build_reference_index(reference_entry_paragraphs(paragraphs))
    paragraph_texts = {para.get("index"): (para.get("text") or "") for para in paragraphs}
    citations = resolve_institutional_citations(citations, paragraph_texts, index)
    return match(citations, index, rules)
