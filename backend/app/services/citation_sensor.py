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


# Pattern A: Narrative form  ->  Smith (2020)
# - Single capitalized word as author (surname only, no et al. handling here)
# - Optional comma + page/locator after year, e.g.  "Smith (2020, p. 12)"
NARRATIVE_PATTERN = re.compile(
    r"\b([A-Z][a-zA-ZÀ-ſ'\-]+)\s*\((\d{4}[a-z]?)(?:,\s*[^)]*)?\)"
)

# Pattern B: Parenthetical form  ->  (Smith, 2020)  or  (Smith & Jones, 2020)
# Allows: surname [+ "et al."] [+ " & "+ other] + comma + 4-digit year + optional letter suffix
PARENTHETICAL_PATTERN = re.compile(
    r"\(\s*([A-Z][a-zA-ZÀ-ſ'\-]+)"
    r"(?:\s*(?:et\s+al\.|&\s+[A-Z][a-zA-ZÀ-ſ'\-]+))*"
    r"\s*,\s*(\d{4}[a-z]?)"
    r"(?:,\s*[^)]*)?\)"
)

# Section headers that mark the start of a reference list.
# Match whole paragraph (case-insensitive, trimmed).
REFERENCES_HEADER_PATTERN = re.compile(
    r"^\s*(references|bibliography|works\s+cited|reference\s+list)\s*$",
    re.IGNORECASE,
)


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


def _scan_paragraphs_for_citations(
    paragraphs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Walk paragraphs, run both regex patterns, collect (author, year, idx, snippet).

    Multiple matches in one paragraph are allowed (different works in same paragraph).
    """
    findings: List[Dict[str, Any]] = []
    seen_in_para: Set[tuple] = set()  # de-dupe (author, year, para_idx)

    for para in paragraphs:
        idx = para.get("index")
        text = para.get("text", "") or ""
        if not text:
            continue

        for match in NARRATIVE_PATTERN.finditer(text):
            author = match.group(1)
            year = match.group(2)
            key = (author.lower(), year, idx)
            if key in seen_in_para:
                continue
            seen_in_para.add(key)
            findings.append({
                "author": author,
                "year": year,
                "paragraph_index": idx,
                "snippet": match.group(0),
            })

        for match in PARENTHETICAL_PATTERN.finditer(text):
            author = match.group(1)
            year = match.group(2)
            key = (author.lower(), year, idx)
            if key in seen_in_para:
                continue
            seen_in_para.add(key)
            findings.append({
                "author": author,
                "year": year,
                "paragraph_index": idx,
                "snippet": match.group(0),
            })

    return findings


def _extract_references_block(paragraphs: List[Dict[str, Any]]) -> str:
    """Return concatenated text from the References section onward.

    Detection rule: first paragraph whose trimmed text matches a known
    references header marks the start. Everything after that paragraph
    (until end of doc) is treated as the bibliography.

    If no header is found, returns empty string — sensor then treats
    every citation as orphan, which is the safe default.
    """
    start_idx: Optional[int] = None
    for para in paragraphs:
        text = (para.get("text") or "").strip()
        if REFERENCES_HEADER_PATTERN.match(text):
            start_idx = para["index"]
            break

    if start_idx is None:
        return ""

    parts = []
    for para in paragraphs:
        if para.get("index", -1) >= start_idx:
            text = (para.get("text") or "").strip()
            if text:
                parts.append(text)
    return "\n".join(parts)


def _build_references_index(references_text: str) -> Set[str]:
    """Build a set of normalized surname tokens present in the References block.

    Strategy: take the first whitespace-delimited token of each non-empty
    line. This works for the common APA layout where each entry starts with
    "Surname, F. M."  Surnames are lowercased for case-insensitive matching.
    """
    index: Set[str] = set()
    for line in references_text.splitlines():
        line = line.strip()
        if not line:
            continue
        first_token = line.split(",")[0].split()[0] if line else ""
        # Strip leading non-alphabetic junk
        first_token = re.sub(r"^[^A-Za-zÀ-ſ']+", "", first_token)
        if first_token:
            index.add(first_token.lower())
    return index


def run_citation_sensor(doc: Document, paragraphs: List[Dict[str, Any]]) -> List[LayoutViolation]:
    """Entry point: run regex-based citation scan, return LayoutViolations.

    Detects in-text APA citations and cross-references them against the
    document's References/Bibliography block. Each orphan citation becomes
    a MAJOR Violation with rule_code 'CITATION_MISMATCH'.
    """
    findings = _scan_paragraphs_for_citations(paragraphs)
    if not findings:
        return []

    references_text = _extract_references_block(paragraphs)
    references_index = _build_references_index(references_text)

    violations: List[LayoutViolation] = []
    for finding in findings:
        if finding["author"].lower() not in references_index:
            violations.append(_make_violation(
                author=finding["author"],
                year=finding["year"],
                paragraph_index=finding["paragraph_index"],
                text_snippet=finding["snippet"],
            ))
    return violations
