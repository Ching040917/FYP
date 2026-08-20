"""Role-based eligibility for Font and Paragraph Typography rules (Phase 2A).

The authoritative paragraph ROLE (produced once by the role classifier and
persisted on document_blocks) decides whether a Font/Typography rule applies
to a paragraph. Rules consume these helpers instead of re-deriving their own
style/text heuristics.

Eligibility policy (one source of truth):

  BODY, APPENDIX_BODY(prose)        → body font/size/alignment/line-spacing/
                                      space-before/space-after.
  HEADING_1/2/3, REFERENCES_HEADING,
  APPENDIX_HEADING                  → configured heading font/size/alignment/
                                      spacing; heading hierarchy is untouched
                                      (separate rule, not role-gated).
  LIST_ITEM                         → visible-text font checks only; list
                                      spacing policy preserved
                                      (LIST_SPACE_AFTER=None ⇒ no finding).
  CAPTION_TABLE, CAPTION_FIGURE     → NO body font/alignment/line-spacing;
                                      only CAPTION_SPACE_BEFORE/_AFTER when
                                      explicitly configured (None ⇒ no finding).
  REFERENCE_ENTRY                   → reference-specific formatting only:
                                      REFERENCES_LINE_SPACING (default 2.0).
                                      No BODY line-spacing/alignment/
                                      paragraph-spacing findings.
  COVER, TITLE, SUBTITLE,           → no BODY font or paragraph-typography
  TABLE_OF_CONTENTS_HEADING/ENTRY,    findings; no invented cover formatting.
  DISPLAYED_EQUATION, FIGURE_HOST,
  EMPTY, FIELD_ONLY, UNKNOWN        → no Font or Paragraph Typography
                                      deductions. UNKNOWN is never silently
                                      converted to BODY (no deduction, but a
                                      manual-review recommendation is kept
                                      without a scored finding).

Historical audits: blocks with role == null are not re-scored; old audits
keep the legacy behavior. New audits use role-aware eligibility.
"""
from typing import Optional

# Roles that receive BODY font/typography requirements.
_BODY_LIKE = frozenset({"BODY", "APPENDIX_BODY"})

# Roles that receive configured heading requirements.
_HEADING_LIKE = frozenset({
    "HEADING_1", "HEADING_2", "HEADING_3",
    "REFERENCES_HEADING", "APPENDIX_HEADING",
})

# Roles that receive visible-text font checks but NOT body typography rules.
_FONT_ONLY = frozenset({"LIST_ITEM"})

# Roles that receive NO Font or Paragraph Typography findings.
_SKIP = frozenset({
    "COVER", "TITLE", "SUBTITLE",
    "TABLE_OF_CONTENTS_HEADING", "TABLE_OF_CONTENTS_ENTRY",
    "DISPLAYED_EQUATION", "FIGURE_HOST",
    "EMPTY", "FIELD_ONLY", "UNKNOWN",
})

# Roles that receive reference-specific formatting only.
_REFERENCE_LIKE = frozenset({"REFERENCE_ENTRY"})

# Roles that receive caption-specific spacing only.
_CAPTION_LIKE = frozenset({"CAPTION_TABLE", "CAPTION_FIGURE"})


def is_body_role(role: Optional[str]) -> bool:
    """True when the role receives BODY typography requirements."""
    return role in _BODY_LIKE


def is_heading_role(role: Optional[str]) -> bool:
    """True when the role receives configured HEADING requirements."""
    return role in _HEADING_LIKE


def is_font_eligible(role: Optional[str]) -> bool:
    """True when visible-text font checks apply (body, headings, list items).

    Cover, TOC, equations, figure hosts, empty/field-only, UNKNOWN, and
    reference entries are NOT font-eligible.
    """
    return role in _BODY_LIKE or role in _HEADING_LIKE or role in _FONT_ONLY


def is_caption_role(role: Optional[str]) -> bool:
    """True when the role uses caption-specific spacing only."""
    return role in _CAPTION_LIKE


def is_reference_role(role: Optional[str]) -> bool:
    """True when the role uses reference-specific formatting only."""
    return role in _REFERENCE_LIKE


def typography_skipped(role: Optional[str]) -> bool:
    """True when the paragraph gets no BODY typography findings at all.

    Skipped roles: COVER, TITLE, SUBTITLE, TOC heading/entry, displayed
    equations, figure hosts, EMPTY, FIELD_ONLY, UNKNOWN. References and
    captions are NOT 'skipped' — they use their own dedicated configuration.
    """
    return role in _SKIP


def body_prose_paragraph(role: Optional[str], text: str) -> bool:
    """APPENDIX_BODY is BODY-eligible only when it contains ordinary academic
    prose — rubric/form content must never become BODY."""
    if role != "APPENDIX_BODY":
        return True
    stripped = (text or "").strip()
    return len(stripped) >= 40 or stripped.endswith((".", "!", "?"))
