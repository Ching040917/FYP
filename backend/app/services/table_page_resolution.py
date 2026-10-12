"""Conservative table-page resolution for TABLE_CAPTION_MISSING.

The page is resolved from matching SAME-PAGE boundary anchors. No table
bounding geometry is available, so this is a *resolved navigation page*, never
an authoritative physical table page.

Contract (mirrored in frontend/src/lib/pdf/table-page-resolution.ts):

  both anchors mapped, SAME page          -> resolved page = that page
  both anchors mapped, adjacent pages      -> unavailable (never a span guess)
  both anchors mapped, any other gap       -> unavailable
  only one anchor mapped                   -> unavailable
  neither anchor mapped                    -> unavailable

The ONLY resolving case is both anchors on the same physical page. A truthful
"unavailable" is always preferable to a guessed page.

This module deliberately has NO legacy/adjacent-block fallback: the backend
does not persist surrounding-block evidence. Historical findings without the
anchor keys are simply unavailable (the caller renders "Unavailable").
"""

from typing import Any, Dict, Optional


def resolve_table_page(
    location: Any,
    page_for_paragraph,
    rendered_pages: Optional[int] = None,
) -> Optional[int]:
    """Resolve a table finding's page from its same-page boundary anchors.

    `location` is the finding's free-form location dict; both
    `previous_anchor_paragraph_index` and `next_anchor_paragraph_index` are
    read (each may be None or absent).

    `page_for_paragraph(paragraph_index) -> Optional[int]` returns the physical
    page for a paragraph index, or None when unmapped/ambiguous. Callers pass
    their own mapping-backed lookup so this stays pure and testable.

    Returns the resolved one-based page, or None when the evidence does not
    prove a single page.
    """
    if not isinstance(location, dict):
        return None

    prev_idx = location.get("previous_anchor_paragraph_index")
    next_idx = location.get("next_anchor_paragraph_index")

    prev_page = _page_of(prev_idx, page_for_paragraph, rendered_pages)
    next_page = _page_of(next_idx, page_for_paragraph, rendered_pages)

    # Both must be mapped AND on the same page. Anything else is unavailable.
    if prev_page is None or next_page is None:
        return None
    if prev_page != next_page:
        return None
    return prev_page


def _page_of(paragraph_index: Any, page_for_paragraph, rendered_pages: Optional[int]) -> Optional[int]:
    if paragraph_index is None or isinstance(paragraph_index, bool) or not isinstance(paragraph_index, int):
        return None
    page = page_for_paragraph(paragraph_index)
    if page is None:
        return None
    try:
        iv = int(page)
    except (TypeError, ValueError):
        return None
    if iv < 1:
        return None
    if rendered_pages is not None and iv > rendered_pages:
        return None
    return iv
