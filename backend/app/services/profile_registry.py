"""Built-in Document Formatting Profile registry (Phase 1 PoC).

Read-only registry of the two approved built-in profiles. Later Builds
resolve a selected profile_id into an immutable per-Audit snapshot; this
Build only defines the profiles and their validation.

Profiles:
  1. SUC Academic Report — the current institutional deployment's verified
     requirements. Every value is INSTITUTION-SPECIFIC and verified; it is
     the recommended default ONLY for that deployment, never presented as
     universal.
  2. APA 7 Student Paper — verified APA 7 paper-format requirements only.
     APA allows several font/size combinations (not only Times New Roman
     12 pt); headings inherit the body font and are distinguished by
     alignment/bold/italic, NOT fixed descending 16/14/12 pt sizes.
"""
from typing import Any, Dict, List

from app.services.profile_schema import (
    APA_ALLOWED_FONT_COMBOS,
    BodySettings,
    CaptionSettings,
    DocumentFormattingProfile,
    HeadingSettings,
    ListSettings,
    MarginSettings,
    ReferencesSettings,
    RolePolicy,
)

SUC_PROFILE_ID = "suc-academic-report"
APA_PROFILE_ID = "apa7-student-paper"

# Roles exempt from deterministic typography findings (matches the current
# role-aware engine's skip set). Kept explicit so profiles state exemptions.
_BOILERPLATE_EXEMPT_ROLES = frozenset({
    "COVER", "TITLE", "SUBTITLE",
    "TABLE_OF_CONTENTS_HEADING", "TABLE_OF_CONTENTS_ENTRY",
    "DISPLAYED_EQUATION", "FIGURE_HOST",
    "EMPTY", "FIELD_ONLY", "UNKNOWN",
})


def _suc_academic_report() -> DocumentFormattingProfile:
    """SUC Academic Report — institution-specific verified values.

    Mirrors the current PresetConfig so the recommended default for the
    current institutional deployment reproduces today's behavior exactly.
    All values are labelled institution-specific; none are universal.
    """
    return DocumentFormattingProfile(
        profile_id=SUC_PROFILE_ID,
        profile_name="SUC Academic Report",
        profile_version=1,
        profile_source="built_in",
        description=(
            "Institution-specific requirements for the current SUC "
            "deployment (verified). Recommended default for SUC theses and "
            "assignments. Values are institution-specific, not universal."
        ),
        citation_style="APA 7",
        body=BodySettings(
            font_family="Times New Roman",
            font_size_pt=12.0,
            line_spacing=1.5,
            alignment="justify",
            space_before_pt=0.0,
            space_after_pt=6.0,
            first_line_indent_in=None,
        ),
        heading=HeadingSettings(
            inherit_body_font=False,
            font_family="Times New Roman",
            font_size_pt=16.0,  # H1; H2/H3 levels resolved in later Builds
            alignment="left",
            space_before_pt=12.0,
            space_after_pt=6.0,
        ),
        margins=MarginSettings(
            margin_left_in=1.5,
            margin_right_in=1.0,
            margin_top_in=1.0,
            margin_bottom_in=1.0,
        ),
        references=ReferencesSettings(
            line_spacing=2.0,
            hanging_indent_in=None,
        ),
        captions=CaptionSettings(
            space_before_pt=None,
            space_after_pt=None,
        ),
        lists=ListSettings(space_after_pt=None),
        role_policy=RolePolicy(
            exempt_roles=_BOILERPLATE_EXEMPT_ROLES,
            table_eligibility="administrative",
        ),
    )


def _apa7_student_paper() -> DocumentFormattingProfile:
    """APA 7 Student Paper — verified APA paper-format requirements only.

    - 1 in margins on all sides;
    - body and References line spacing 2.0;
    - paragraph Space Before/After 0 pt;
    - paragraph alignment left (not justified);
    - first-line indent 0.5 in where applicable;
    - References hanging indent 0.5 in;
    - allowed font/size combinations (APA-accepted, NOT forced TNR 12);
    - headings inherit the body font combination;
    - heading levels differ through APA alignment/bold/italic rules, not
      fixed 16/14/12 pt sizes.
    No institutional overrides are mixed in.
    """
    return DocumentFormattingProfile(
        profile_id=APA_PROFILE_ID,
        profile_name="APA 7 Student Paper",
        profile_version=1,
        profile_source="built_in",
        description=(
            "APA 7 paper-format requirements (verified). 1 in margins, "
            "2.0 line spacing, left-aligned paragraphs, 0 pt paragraph "
            "spacing, APA-accepted fonts, headings inherit the body font. "
            "Institutional overrides apply only when the selected profile "
            "explicitly states them."
        ),
        citation_style="APA 7",
        body=BodySettings(
            font_family=None,  # allowed set below — not forced to one font
            font_size_pt=None,
            allowed_font_combos=APA_ALLOWED_FONT_COMBOS,
            line_spacing=2.0,
            alignment="left",
            space_before_pt=0.0,
            space_after_pt=0.0,
            first_line_indent_in=0.5,
        ),
        heading=HeadingSettings(
            inherit_body_font=True,  # headings use the approved body font
            font_family=None,
            font_size_pt=None,
            alignment="left",
            space_before_pt=0.0,
            space_after_pt=0.0,
            # APA distinguishes levels by bold/italic/alignment, not size.
            level_1={"bold": True, "italic": False, "alignment": "center"},
            level_2={"bold": True, "italic": False, "alignment": "left"},
            level_3={"bold": True, "italic": True, "alignment": "left"},
        ),
        margins=MarginSettings(
            margin_left_in=1.0,
            margin_right_in=1.0,
            margin_top_in=1.0,
            margin_bottom_in=1.0,
        ),
        references=ReferencesSettings(
            line_spacing=2.0,
            hanging_indent_in=0.5,
        ),
        captions=CaptionSettings(
            space_before_pt=None,
            space_after_pt=None,
        ),
        lists=ListSettings(space_after_pt=None),
        role_policy=RolePolicy(
            exempt_roles=_BOILERPLATE_EXEMPT_ROLES,
            table_eligibility="scholarly",
        ),
    )


BUILTIN_PROFILES: Dict[str, DocumentFormattingProfile] = {
    SUC_PROFILE_ID: _suc_academic_report(),
    APA_PROFILE_ID: _apa7_student_paper(),
}

# Recommended default for the current institutional deployment only.
RECOMMENDED_PROFILE_ID = SUC_PROFILE_ID


def get_builtin_profile(profile_id: str) -> DocumentFormattingProfile:
    """Return a defensive copy of the built-in profile, or raise KeyError.

    Callers receive a copy — mutating it never corrupts the registry.
    """
    if profile_id not in BUILTIN_PROFILES:
        raise KeyError(f"unknown built-in profile '{profile_id}'")
    return _deep_copy_profile(BUILTIN_PROFILES[profile_id])


def list_builtin_profiles() -> Dict[str, DocumentFormattingProfile]:
    """Return defensive copies of the built-in registry (never the mutable
    originals)."""
    return {pid: _deep_copy_profile(p) for pid, p in BUILTIN_PROFILES.items()}


def _deep_copy_profile(profile: DocumentFormattingProfile) -> DocumentFormattingProfile:
    """Reconstruct an independent copy via canonical serialization."""
    from app.services.profile_schema import profile_from_dict
    return profile_from_dict(profile.to_dict())


# ---------------------------------------------------------------------------
# Presentation-safe summaries (Build 5: GET /api/formatting-profiles)
# ---------------------------------------------------------------------------

def profile_listing(profile: DocumentFormattingProfile) -> Dict[str, Any]:
    """Presentation-safe profile listing for the read-only endpoint.

    Exposes ONLY what the simple-mode selector needs: identity, version,
    source, description, recommended flag, citation style, and a concise
    plain-English key-requirements summary. Never exposes internal Python
    types, validation internals, fingerprints, or mutable registry objects.
    """
    return {
        "profile_id": profile.profile_id,
        "profile_name": profile.profile_name,
        "profile_version": profile.profile_version,
        "description": profile.description,
        "profile_source": profile.profile_source,
        "recommended": profile.profile_id == RECOMMENDED_PROFILE_ID,
        "citation_style": profile.citation_style,
        "key_requirements": _key_requirements_summary(profile),
    }


def list_profile_listings() -> List[Dict[str, Any]]:
    """All built-in profiles as presentation-safe listings (registry order)."""
    return [profile_listing(BUILTIN_PROFILES[pid]) for pid in BUILTIN_PROFILES]


def _key_requirements_summary(profile: DocumentFormattingProfile) -> List[str]:
    """Concise plain-English key requirements. No schema/snapshot/fingerprint
    terminology, no invented requirements."""
    lines: List[str] = []
    b, m, refs = profile.body, profile.margins, profile.references

    # Margins
    if all(v is not None for v in (m.margin_left_in, m.margin_right_in, m.margin_top_in, m.margin_bottom_in)):
        if len({m.margin_left_in, m.margin_right_in, m.margin_top_in, m.margin_bottom_in}) == 1:
            lines.append(f"{m.margin_left_in:g} in margins on all sides")
        else:
            lines.append(
                f"{m.margin_left_in:g} in left, {m.margin_right_in:g} in right, "
                f"{m.margin_top_in:g} in top, {m.margin_bottom_in:g} in bottom margins"
            )
    elif m.margin_left_in is not None:
        lines.append(f"{m.margin_left_in:g} in left margin")

    # Body font
    if b.allowed_font_combos:
        fams = sorted({f for f, _ in b.allowed_font_combos})
        sizes = sorted({s for _, s in b.allowed_font_combos})
        lines.append(f"Allowed fonts: {', '.join(fams)} at {', '.join(f'{s:g} pt' for s in sizes)}")
    elif b.font_family and b.font_size_pt:
        lines.append(f"{b.font_family} {b.font_size_pt:g} pt body text")

    # Body spacing / alignment
    if b.line_spacing is not None:
        ls = "double" if abs(b.line_spacing - 2.0) < 0.01 else f"{b.line_spacing:g}"
        lines.append(f"{ls} line spacing for body text")
    if b.alignment == "left":
        lines.append("Left-aligned body paragraphs")
    if b.space_before_pt == 0 and b.space_after_pt == 0:
        lines.append("No extra paragraph spacing")

    # Heading inheritance (APA)
    if profile.heading.inherit_body_font:
        lines.append("Headings use the body font")

    # References
    if refs.line_spacing is not None:
        ls = "double" if abs(refs.line_spacing - 2.0) < 0.01 else f"{refs.line_spacing:g}"
        lines.append(f"{ls} line spacing for references")
    if refs.hanging_indent_in is not None:
        lines.append(f"{refs.hanging_indent_in:g} in hanging indent for references")

    return lines
