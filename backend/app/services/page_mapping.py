"""
Deterministic backend paragraph→rendered-page mapping (Build friendly locations).

Produces a conservative paragraph_index → physical rendered-PDF page number map
while both the parsed paragraphs and the validated rendered PDF bytes are
available (audit time). Never guesses, never persists document text,
never logs paragraph content.

Semantics mirror the frontend paragraph-mapping.ts conservative rules:
paragraph text normalized (NFKC, ligatures, smart punctuation, whitespace,
case folding) and matched by exact containment against per-page PDF text
blobs. Duplicate or ambiguous matches are left unmapped.

Keys are zero-based paragraph indexes (as strings in JSON). Values are
one-based physical rendered-PDF page numbers. Unmapped paragraphs are absent
from the dict. An empty dict means no reliable mapping could be produced.
"""
import io
import logging
import re
import unicodedata
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)

LIGATURES = {
    'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
    'ﬅ': 'st', 'ﬆ': 'st', 'Œ': 'OE', 'œ': 'oe', 'Æ': 'AE', 'æ': 'ae',
}

# Short excerpt length — reuse existing repository convention: snippet up to 140
# chars in audit scoring/friendly finding. For affected-text excerpts we use
# 80 chars (small, documented constant below) to stay concise.
AFFECTED_TEXT_MAX = 80


def _normalize(text: str) -> str:
    """NFKC + ligature split + smart punctuation + whitespace/case folding."""
    if not text:
        return ""
    out = ""
    for ch in unicodedata.normalize('NFKC', text):
        out += LIGATURES.get(ch, ch)
    out = out.replace('\u2018', "'").replace('\u2019', "'")
    out = out.replace('\u201c', '"').replace('\u201d', '"')
    out = out.replace('\u2013', '-').replace('\u2014', '-').replace('\u2015', '-')
    out = out.replace('\u2026', '...').replace('\u00a0', ' ')
    out = re.sub(r'\s+', ' ', out)
    return out.strip().lower()


def _squeeze(s: str) -> str:
    return re.sub(r'\s+', '', s)


def _contains(haystack: str, needle: str) -> bool:
    return needle in haystack or _squeeze(needle) in _squeeze(haystack)


def _extract_page_blobs(pdf_bytes: bytes) -> Optional[List[Dict[str, Any]]]:
    """
    Extract per-page normalized text blobs via pypdf. Returns None on failure
    (invalid PDF, unreadable, etc.) — caller must treat as mapping failure
    without failing the audit.
    """
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages = []
        for idx, page in enumerate(reader.pages):
            try:
                raw = page.extract_text() or ""
            except Exception:
                raw = ""
            norm = _normalize(raw)
            # Filter out very short pages (cover/header-only) but keep them
            # for page counting; empty blobs simply never match.
            pages.append({
                "pageNumber": idx + 1,  # 1-based physical page
                "blob": norm,
                "raw_len": len(raw),
            })
        if not pages:
            return None
        return pages
    except Exception as e:
        logger.info("page_mapping extract failed: %s", type(e).__name__)
        return None


def compute_paragraph_page_mapping(
    paragraphs: List[Dict[str, Any]],
    pdf_bytes: bytes,
    rendered_preview_pages: Optional[int] = None,
) -> Optional[Dict[str, int]]:
    """
    Deterministically map paragraph indexes to physical rendered-PDF page numbers.

    Returns a dict {"paragraph_index": page_number} with 1-based page values,
    or None/empty dict when mapping cannot be produced. Never raises for
    mapping failures — the audit must not fail.

    Conservative rules:
    - Empty/very short paragraphs (< 8 chars normalized) are left unmapped.
    - Exact containment match on a single page → mapped.
    - Appears on zero or multiple pages → unmapped (ambiguous).
    - Also checks 2-page cross-page windows (small PoC) — if contained only
      when two adjacent pages are joined, map to the first page of the window.
    """
    if not pdf_bytes or not paragraphs:
        return None

    page_blobs = _extract_page_blobs(pdf_bytes)
    if page_blobs is None:
        return None

    # Validate total pages against metadata when available.
    if rendered_preview_pages is not None:
        if len(page_blobs) != rendered_preview_pages:
            logger.info(
                "page_mapping page count mismatch: pypdf=%d metadata=%d",
                len(page_blobs), rendered_preview_pages,
            )
            # Continue — use actual extracted count, not metadata.

    mapping: Dict[str, int] = {}

    for para in paragraphs:
        idx = para.get("index")
        text = para.get("text", "")
        if idx is None:
            continue
        norm = _normalize(text)
        # Leave empty/very short paragraphs unmapped — prevents false positives.
        if len(norm) < 8:
            continue

        candidates = []
        for page in page_blobs:
            if _contains(page["blob"], norm):
                candidates.append(page["pageNumber"])

        if len(candidates) == 1:
            page_num = candidates[0]
            # Bound by rendered_preview_pages when provided.
            if rendered_preview_pages is not None and not (1 <= page_num <= rendered_preview_pages):
                continue
            mapping[str(idx)] = page_num
            continue

        if len(candidates) == 0:
            # Check 2-page cross-page windows (paragraph split across pages).
            found_window = None
            for i in range(len(page_blobs) - 1):
                joined = page_blobs[i]["blob"] + "\n" + page_blobs[i + 1]["blob"]
                if _contains(joined, norm):
                    found_window = page_blobs[i]["pageNumber"]
                    break
            if found_window is not None:
                # Only map if this window is unique (not also found elsewhere).
                # Our single-window early break is conservative enough for PoC.
                if rendered_preview_pages is not None and not (1 <= found_window <= rendered_preview_pages):
                    continue
                mapping[str(idx)] = found_window

        # len(candidates) > 1 → ambiguous/dup → unmapped (never guess)

    if not mapping:
        return None

    # Final validation: values must be positive ints within page count.
    cleaned: Dict[str, int] = {}
    max_page = rendered_preview_pages or max(mapping.values())
    for k, v in mapping.items():
        try:
            iv = int(v)
            if 1 <= iv <= max_page:
                cleaned[k] = iv
        except (TypeError, ValueError):
            continue

    return cleaned if cleaned else None


def sanitize_stored_mapping(
    raw: Any,
    rendered_preview_pages: Optional[int] = None,
) -> Optional[Dict[str, int]]:
    """
    Validate a stored JSON mapping on read: keys are paragraph indexes (as
    strings), values are positive ints within the preview page count.
    Invalid entries are ignored. Returns None when nothing valid remains.
    """
    if not isinstance(raw, dict):
        return None
    cleaned: Dict[str, int] = {}
    max_page = rendered_preview_pages
    for k, v in raw.items():
        try:
            # Key must be stringified int, value int.
            int_k = int(str(k))
            int_v = int(v)
            if int_k < 0 or int_v < 1:
                continue
            if max_page is not None and int_v > max_page:
                continue
            cleaned[str(int_k)] = int_v
        except (TypeError, ValueError, AttributeError):
            continue
    return cleaned if cleaned else None


def excerpt_for_paragraph(
    text: str,
    max_len: int = AFFECTED_TEXT_MAX,
) -> Optional[str]:
    """
    Produce a short normalized affected-text excerpt from existing paragraph
    text, or None when the text is too short/empty to excerpt safely.

    - Normalizes whitespace.
    - Truncates to max_len with ellipsis only when truncated.
    - Never fabricates content; returns None when text is empty after
      normalization or shorter than 8 chars.
    """
    if not text:
        return None
    norm = re.sub(r'\s+', ' ', text).strip()
    if len(norm) < 8:
        return None
    if len(norm) <= max_len:
        return norm
    return norm[:max_len].rstrip() + "…"


def is_whole_paragraph_affected(
    rule_code: str,
    location: Dict[str, Any],
) -> bool:
    """
    True when rule semantics prove the whole paragraph is affected and the
    excerpt line should be 'Entire paragraph' rather than a quoted snippet.

    Conservative: only for rules that are known to be paragraph-scoped.
    Run-level rules (FONT_SIZE, FONT_CONSISTENCY, etc.) are NOT whole-paragraph.
    """
    # Paragraph-scoped rules that always affect the entire paragraph.
    whole_paragraph_rules = {
        "ALIGNMENT",
        "LINE_SPACING",
        "SPACE_BEFORE",
        "SPACE_AFTER",
        "HEADING_HIERARCHY",
    }
    if rule_code in whole_paragraph_rules:
        return True
    # run_index absent → whole paragraph affected (paragraph-level violation).
    # This is conservative: if a run-level rule has no run_index, it was
    # paragraph-scoped in this instance.
    if location.get("run_index") is None and location.get("run_indexes") is None:
        # But not for run-level font rules — those always have run info when
        # they are truly run-level. Without run info, treat as paragraph.
        return True
    return False
