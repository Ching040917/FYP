"""
Pure-Python fallback for APA in-text citation detection.

No LLM dependency. Regex-scans paragraphs for APA citation patterns,
extracts a References/Bibliography block at the end of the document,
and flags in-text citations whose author surname does not appear in
the References block.

Output: LayoutViolation list compatible with the static rules engine.
"""
import re
from typing import List, Dict, Any, Set, Optional

from docx import Document
from app.services.layout_violation import LayoutViolation


# Pattern A: Narrative form  ->  Smith (2020)  or  Taylor & Green (2018)  or  Smith and Jones (2019)
# - One or more capitalized surnames joined by '&' or the word 'and'.
# - Group 1 captures the full chain; primary surname = first token before '&'/'and'.
# - Optional comma + page/locator after year, e.g.  "Smith (2020, p. 12)"
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


def _make_violation(
    author: str,
    year: str,
    paragraph_index: int,
    text_snippet: str,
) -> LayoutViolation:
    """Build a CITATION_MISMATCH LayoutViolation for an orphan citation."""
    return LayoutViolation(
        rule_code="CITATION_MISMATCH",
        severity="MAJOR",
        location={"paragraph_index": paragraph_index},
        message=(
            f"Citation '{author} ({year})' was found in text, "
            f"but no matching entry was found in the References bibliography."
        ),
        expected_value=f"Reference entry for {author}",
        actual_value=text_snippet[:120],
    )


def _find_references_start(paragraphs: List[Dict[str, Any]]) -> Optional[int]:
    """Return the index of the first paragraph that is a References header.

    Returns None when no header exists — the safe default is to treat the
    whole document as body text (every citation is then an orphan).
    """
    for para in paragraphs:
        if _is_references_header(para.get("text")):
            return para["index"]
    return None


def _scan_paragraphs_for_citations(
    paragraphs: List[Dict[str, Any]],
    stop_at: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Walk paragraphs, run both regex patterns, collect (author, year, idx, snippet).

    Multiple matches in one paragraph are allowed (different works in same paragraph).
    Scanning stops at the References section (stop_at): reference entries and any
    appendix/manifest text after the header are bibliography data, not body
    citations — scanning them fabricates duplicate or false findings.
    """
    findings: List[Dict[str, Any]] = []
    seen_in_para: Set[tuple] = set()  # de-dupe (author, year, para_idx)

    for para in paragraphs:
        idx = para.get("index")
        if stop_at is not None and idx >= stop_at:
            continue
        text = para.get("text", "") or ""
        if not text:
            continue

        for match in NARRATIVE_PATTERN.finditer(text):
            author = match.group(1)
            year = match.group(2)
            # Multi-author narrative cites (Taylor & Green, Smith and Jones)
            # match the bibliography on the PRIMARY surname only — APA permits
            # secondary authors not to appear independently in the reference list.
            primary_author = re.split(r"\s+(?:&|and)\s+", author)[0]
            key = (primary_author.lower(), year, idx)
            if key in seen_in_para:
                continue
            seen_in_para.add(key)
            findings.append({
                "author": author,
                "primary_author": primary_author,
                "year": year,
                "paragraph_index": idx,
                "snippet": match.group(0),
            })

        for match in PARENTHETICAL_PATTERN.finditer(text):
            author = match.group(1)
            year = match.group(2)
            # Group 1 of PARENTHETICAL_PATTERN is the first surname only
            # (subsequent authors live in optional non-capturing groups),
            # so `author` is already the primary author — no split needed.
            key = (author.lower(), year, idx)
            if key in seen_in_para:
                continue
            seen_in_para.add(key)
            findings.append({
                "author": author,
                "primary_author": author,
                "year": year,
                "paragraph_index": idx,
                "snippet": match.group(0),
            })

    return findings


def _extract_references_block(
    paragraphs: List[Dict[str, Any]],
    start_idx: Optional[int] = None,
) -> str:
    """Return concatenated text from the References section onward.

    Detection rule: first paragraph whose trimmed text matches a known
    references header marks the start. Everything after that paragraph
    (until end of doc) is treated as the bibliography.

    If no header is found, returns empty string — sensor then treats
    every citation as orphan, which is the safe default.
    """
    if start_idx is None:
        start_idx = _find_references_start(paragraphs)
    if start_idx is None:
        return ""

    parts = []
    for para in paragraphs:
        if para.get("index", -1) >= start_idx:
            text = (para.get("text") or "").strip()
            if not text:
                continue
            # An Appendix heading ends the bibliography: reference entries
            # live between the References header and the first appendix.
            if APPENDIX_HEADER_PATTERN.match(text):
                break
            parts.append(text)
    return "\n".join(parts)


# First alphabetic run of a reference line — the surname. Hyphens and
# apostrophes are kept so hyphenated/O'Brien surnames match their in-text
# forms.
_SURNAME_RUN = re.compile(r"[A-Za-zÀ-ſ][A-Za-zÀ-ſ'\-]*")


def _extract_surname_token(line: str) -> Optional[str]:
    """First alphabetic token of a reference entry, junk-stripped.

    APA entries start with the surname, optionally prefixed by list
    numbering or bullets ("1. Smith, J. (2020)..."). The first alphabetic
    run of the line is the surname: leading numerals, bullets, and
    punctuation are skipped entirely, so numbered reference lists resolve
    to "Smith" instead of being dropped from the index (which would turn a
    valid citation into a false CITATION_MISMATCH).
    """
    match = _SURNAME_RUN.search(line)
    if not match:
        return None
    return match.group(0)


def _build_references_index(references_text: str) -> Set[str]:
    """Build a set of normalized surname tokens present in the References block.

    Strategy: take the first token of each non-empty line, skipping any
    leading numbering/bullets — this works for common APA layouts
    ("Surname, F. M." and "1. Surname, F. M."). Surnames are lowercased
    for case-insensitive matching.
    """
    index: Set[str] = set()
    for line in references_text.splitlines():
        line = line.strip()
        if not line:
            continue
        surname = _extract_surname_token(line)
        if surname:
            index.add(surname.lower())
    return index


def run_citation_sensor(doc: Document, paragraphs: List[Dict[str, Any]]) -> List[LayoutViolation]:
    """Entry point: run regex-based citation scan, return LayoutViolations.

    Detects in-text APA citations and cross-references them against the
    document's References/Bibliography block. Each orphan citation becomes
    a MAJOR Violation with rule_code 'CITATION_MISMATCH'.
    """
    ref_start = _find_references_start(paragraphs)
    findings = _scan_paragraphs_for_citations(paragraphs, stop_at=ref_start)
    if not findings:
        return []

    references_text = _extract_references_block(paragraphs, start_idx=ref_start)
    references_index = _build_references_index(references_text)

    violations: List[LayoutViolation] = []
    for finding in findings:
        # Cross-reference: every in-text citation must trace to a References entry
        # by its primary author surname (case-insensitive). Multi-author cites
        # (Taylor & Green) match on the first surname only — APA permits the
        # secondary author not to appear independently in the reference list.
        if finding["primary_author"].lower() not in references_index:
            violations.append(_make_violation(
                author=finding["author"],
                year=finding["year"],
                paragraph_index=finding["paragraph_index"],
                text_snippet=finding["snippet"],
            ))
    return violations
