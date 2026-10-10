"""Effective Profile Snapshot resolution (Build 2).

Resolve a validated DocumentFormattingProfile (Phase 1) into an immutable
EffectiveProfileSnapshot: a deterministic, self-contained representation of
every effective formatting requirement, ready for future Audit persistence
and rule execution.

Design contract:
  - Snapshots are immutable: no public mutation, defensive copies.
  - Resolution happens ONCE; later edits or deletion of the source profile
    never affect an already-resolved snapshot.
  - No missing value falls back to global PresetConfig — a nullable
    requirement stays null (skip check, no scored finding).
  - APA font resolution preserves allowed (font, size) pairs; a selected
    body combination outside the allowed set is rejected; inherited Heading
    fonts use the selected valid body combination; no fixed descending
    heading sizes are introduced.
  - SUC snapshots are labelled institution-specific, never universal APA.
  - Canonical serialization + SHA-256 fingerprint exclude transient state
    (timestamps) but include every effective requirement.
  - Validation errors carry field paths and never leak stack traces.
"""
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.services.profile_schema import (
    CitationMatchingSettings,
    DocumentFormattingProfile,
    ProfileValidationError,
)

# Bump when the snapshot shape changes incompatibly.
#  v2 appends the citation_matching group (deterministic citation ↔ Reference
#  List matching toggles).
#  v3 extends the NESTED references group with the Reference List formatting
#  rules. The top-level key order is unchanged; the nested references group is
#  version-gated below, so v1 and v2 snapshots keep verifying byte-for-byte.
#  v1 snapshots stay loadable: their canonical key order is frozen below so
#  their stored SHA-256 keeps verifying byte-for-byte.
SNAPSHOT_SCHEMA_VERSION = 3

# Frozen v1 canonical key order — NEVER edit. v1 snapshots are fingerprinted
# over exactly these keys; changing the tuple invalidates stored fingerprints
# and silently breaks historical audits' profile disclosure.
_CANONICAL_ORDER_V1 = (
    "schema_version", "profile_id", "profile_name", "profile_version",
    "profile_source", "description", "citation_style", "institution_specific",
    "body", "heading", "margins", "references", "captions", "lists",
    "role_exemptions", "table_eligibility", "fingerprint",
)

# Canonical key order for deterministic serialization (byte-stable).
# v2 appends citation_matching immediately before the fingerprint; v3 keeps
# the same TOP-LEVEL order and changes only the nested references group, so
# this tuple is intentionally identical for v2 and v3.
_CANONICAL_ORDER = (
    "schema_version", "profile_id", "profile_name", "profile_version",
    "profile_source", "description", "citation_style", "institution_specific",
    "body", "heading", "margins", "references", "captions", "lists",
    "role_exemptions", "table_eligibility", "citation_matching", "fingerprint",
)

# Nested `references` keys of a v3 snapshot. The two pre-existing keys keep
# their position first so a v3 payload is a superset of v2, never a reorder.
_REFERENCES_GROUP_KEYS_V3: Tuple[str, ...] = (
    "line_spacing", "hanging_indent_in",
    "check_heading_text", "heading_text", "allow_heading_aliases",
    "check_heading_bold", "heading_bold",
    "check_heading_alignment", "heading_alignment",
    "check_start_on_new_page",
    "check_hanging_indent", "check_line_spacing",
    "check_space_before", "space_before_pt",
    "check_space_after", "space_after_pt",
    "check_font_family", "font_family",
    "check_font_size", "font_size_pt",
    "check_alignment", "alignment",
)

# Nested `references` keys of a v1/v2 snapshot — frozen. A stored historical
# snapshot must serialize to the exact bytes that produced its fingerprint,
# so it never gains the v3 Reference List keys.
_REFERENCES_GROUP_KEYS_LEGACY: Tuple[str, ...] = ("line_spacing", "hanging_indent_in")

# Snapshot schema versions this build can load (older first).
SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = (1, 2, SNAPSHOT_SCHEMA_VERSION)


def _references_group_keys(version: Any) -> Tuple[str, ...]:
    """Nested references key order for a stored snapshot schema version."""
    try:
        version_int = int(version)
    except (TypeError, ValueError):
        return _REFERENCES_GROUP_KEYS_LEGACY
    return _REFERENCES_GROUP_KEYS_V3 if version_int >= 3 else _REFERENCES_GROUP_KEYS_LEGACY


def _canonical_order_for(version: Any) -> Tuple[str, ...]:
    """Canonical key order for a stored snapshot schema version.

    Unknown/future versions resolve to the v1 order defensively — callers
    reject unsupported versions before serializing.
    """
    try:
        version_int = int(version)
    except (TypeError, ValueError):
        return _CANONICAL_ORDER_V1
    return _CANONICAL_ORDER_V1 if version_int <= 1 else _CANONICAL_ORDER


@dataclass(frozen=True)
class EffectiveProfileSnapshot:
    """Immutable resolved snapshot of every effective formatting requirement.

    Frozen dataclass: no mutation after construction. `fingerprint` is the
    canonical SHA-256 of the effective requirements (excludes timestamps).
    """

    schema_version: int = SNAPSHOT_SCHEMA_VERSION
    profile_id: str = ""
    profile_name: str = ""
    profile_version: int = 1
    profile_source: str = "built_in"
    description: str = ""
    citation_style: str = "APA 7"
    # True for institution-specific profiles (SUC). Never claims universal
    # APA status for institutional values.
    institution_specific: bool = False

    # Effective body requirements (exact or allowed-set resolved).
    body_font_family: Optional[str] = None
    body_font_size_pt: Optional[float] = None
    body_allowed_font_combos: Tuple[Tuple[str, float], ...] = ()
    body_line_spacing: Optional[float] = None
    body_alignment: Optional[str] = None
    body_space_before_pt: Optional[float] = None
    body_space_after_pt: Optional[float] = None
    body_first_line_indent_in: Optional[float] = None

    # Effective heading requirements (inheritance resolved).
    heading_font_family: Optional[str] = None
    heading_font_size_pt: Optional[float] = None
    heading_allowed_font_combos: Tuple[Tuple[str, float], ...] = ()
    heading_alignment: Optional[str] = None
    heading_space_before_pt: Optional[float] = None
    heading_space_after_pt: Optional[float] = None
    heading_level_1: Dict[str, Any] = field(default_factory=dict)
    heading_level_2: Dict[str, Any] = field(default_factory=dict)
    heading_level_3: Dict[str, Any] = field(default_factory=dict)

    margin_left_in: Optional[float] = None
    margin_right_in: Optional[float] = None
    margin_top_in: Optional[float] = None
    margin_bottom_in: Optional[float] = None

    references_line_spacing: Optional[float] = None
    references_hanging_indent_in: Optional[float] = None

    # Reference List formatting rules (v3+). Flat like every other group so
    # rules read them directly. Each `references_check_*` toggle is the
    # RESOLVED effective toggle: a check whose dependent value is absent is
    # still effective but uncomparable, so a rule can never fire without a
    # configured value.
    references_check_heading_text: bool = False
    references_heading_text: Optional[str] = None
    references_allow_heading_aliases: bool = False
    references_check_heading_bold: bool = False
    references_heading_bold: bool = True
    references_check_heading_alignment: bool = False
    references_heading_alignment: Optional[str] = None
    references_check_start_on_new_page: bool = False
    references_check_hanging_indent: bool = False
    references_check_line_spacing: bool = False
    references_check_space_before: bool = False
    references_space_before_pt: Optional[float] = None
    references_check_space_after: bool = False
    references_space_after_pt: Optional[float] = None
    references_check_font_family: bool = False
    references_font_family: Optional[str] = None
    references_check_font_size: bool = False
    references_font_size_pt: Optional[float] = None
    references_check_alignment: bool = False
    references_alignment: Optional[str] = None

    caption_space_before_pt: Optional[float] = None
    caption_space_after_pt: Optional[float] = None

    list_space_after_pt: Optional[float] = None

    # Deterministic sorted role exemptions.
    role_exemptions: Tuple[str, ...] = ()
    table_eligibility: str = "administrative"

    # Citation ↔ Reference List matching toggles (v2+). Flat, so rules read
    # them directly; serialized as the nested `citation_matching` group.
    citation_check_citations_have_references: bool = True
    citation_check_references_are_cited: bool = False
    citation_check_author_year_consistency: bool = True
    citation_check_year_suffixes: bool = True
    citation_check_duplicate_references: bool = True
    citation_flag_ambiguous_matches: bool = True
    citation_allow_personal_communication: bool = True

    fingerprint: str = ""

    # ------------------------------------------------------------------
    # Deterministic canonical serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """Canonical dict — stable key order, sorted tuples, no transient
        state (timestamps never enter the snapshot).

        Version-gated: a v1 snapshot serializes WITHOUT the citation_matching
        group, so its canonical bytes (and stored fingerprint) stay identical
        to the bytes written by the release that produced it.
        """
        d: Dict[str, Any] = {
            "schema_version": self.schema_version,
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "profile_version": self.profile_version,
            "profile_source": self.profile_source,
            "description": self.description,
            "citation_style": self.citation_style,
            "institution_specific": self.institution_specific,
            "body": {
                "font_family": self.body_font_family,
                "font_size_pt": self.body_font_size_pt,
                "allowed_font_combos": [list(c) for c in self.body_allowed_font_combos],
                "line_spacing": self.body_line_spacing,
                "alignment": self.body_alignment,
                "space_before_pt": self.body_space_before_pt,
                "space_after_pt": self.body_space_after_pt,
                "first_line_indent_in": self.body_first_line_indent_in,
            },
            "heading": {
                "font_family": self.heading_font_family,
                "font_size_pt": self.heading_font_size_pt,
                "allowed_font_combos": [list(c) for c in self.heading_allowed_font_combos],
                "alignment": self.heading_alignment,
                "space_before_pt": self.heading_space_before_pt,
                "space_after_pt": self.heading_space_after_pt,
                "level_1": dict(self.heading_level_1),
                "level_2": dict(self.heading_level_2),
                "level_3": dict(self.heading_level_3),
            },
            "margins": {
                "left_in": self.margin_left_in,
                "right_in": self.margin_right_in,
                "top_in": self.margin_top_in,
                "bottom_in": self.margin_bottom_in,
            },
            "references": self._references_group(self.schema_version),
            "captions": {
                "space_before_pt": self.caption_space_before_pt,
                "space_after_pt": self.caption_space_after_pt,
            },
            "lists": {
                "space_after_pt": self.list_space_after_pt,
            },
            "role_exemptions": list(self.role_exemptions),
            "table_eligibility": self.table_eligibility,
            "citation_matching": {
                "check_citations_have_references": self.citation_check_citations_have_references,
                "check_references_are_cited": self.citation_check_references_are_cited,
                "check_author_year_consistency": self.citation_check_author_year_consistency,
                "check_year_suffixes": self.citation_check_year_suffixes,
                "check_duplicate_references": self.citation_check_duplicate_references,
                "flag_ambiguous_matches": self.citation_flag_ambiguous_matches,
                "allow_personal_communication": self.citation_allow_personal_communication,
            },
            "fingerprint": self.fingerprint,
        }
        return {k: d[k] for k in _canonical_order_for(self.schema_version) if k in d}

    def _references_group(self, version: Any) -> Dict[str, Any]:
        """Nested references payload for one stored schema version.

        A v1/v2 snapshot emits exactly the two keys it always had, so its
        canonical bytes — and therefore its stored fingerprint — are
        unchanged. Only a v3 snapshot carries the Reference List rules.
        """
        full: Dict[str, Any] = {
            "line_spacing": self.references_line_spacing,
            "hanging_indent_in": self.references_hanging_indent_in,
            "check_heading_text": self.references_check_heading_text,
            "heading_text": self.references_heading_text,
            "allow_heading_aliases": self.references_allow_heading_aliases,
            "check_heading_bold": self.references_check_heading_bold,
            "heading_bold": self.references_heading_bold,
            "check_heading_alignment": self.references_check_heading_alignment,
            "heading_alignment": self.references_heading_alignment,
            "check_start_on_new_page": self.references_check_start_on_new_page,
            "check_hanging_indent": self.references_check_hanging_indent,
            "check_line_spacing": self.references_check_line_spacing,
            "check_space_before": self.references_check_space_before,
            "space_before_pt": self.references_space_before_pt,
            "check_space_after": self.references_check_space_after,
            "space_after_pt": self.references_space_after_pt,
            "check_font_family": self.references_check_font_family,
            "font_family": self.references_font_family,
            "check_font_size": self.references_check_font_size,
            "font_size_pt": self.references_font_size_pt,
            "check_alignment": self.references_check_alignment,
            "alignment": self.references_alignment,
        }
        return {k: full[k] for k in _references_group_keys(version)}

    def canonical_bytes(self) -> bytes:
        """Byte-stable canonical serialization (JSON with stable key order).

        Excludes the fingerprint field itself — the fingerprint is computed
        over the effective requirements, never over its own value.
        """
        data = self.to_dict()
        data.pop("fingerprint", None)
        return json.dumps(
            data, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")

    def compute_fingerprint(self) -> str:
        """SHA-256 of the canonical effective requirements.

        Excludes transient state (timestamps, runtime) by construction — the
        snapshot carries none. Changes when ANY effective requirement
        changes; identical for equivalent snapshots.
        """
        return hashlib.sha256(self.canonical_bytes()).hexdigest()

    def with_fingerprint(self) -> "EffectiveProfileSnapshot":
        """Return a copy carrying its canonical fingerprint (self if set)."""
        if self.fingerprint:
            return self
        fp = self.compute_fingerprint()
        # Flat kwargs copy — nested groups are immutable tuples/dicts here.
        return EffectiveProfileSnapshot(
            schema_version=self.schema_version,
            profile_id=self.profile_id,
            profile_name=self.profile_name,
            profile_version=self.profile_version,
            profile_source=self.profile_source,
            description=self.description,
            citation_style=self.citation_style,
            institution_specific=self.institution_specific,
            body_font_family=self.body_font_family,
            body_font_size_pt=self.body_font_size_pt,
            body_allowed_font_combos=self.body_allowed_font_combos,
            body_line_spacing=self.body_line_spacing,
            body_alignment=self.body_alignment,
            body_space_before_pt=self.body_space_before_pt,
            body_space_after_pt=self.body_space_after_pt,
            body_first_line_indent_in=self.body_first_line_indent_in,
            heading_font_family=self.heading_font_family,
            heading_font_size_pt=self.heading_font_size_pt,
            heading_allowed_font_combos=self.heading_allowed_font_combos,
            heading_alignment=self.heading_alignment,
            heading_space_before_pt=self.heading_space_before_pt,
            heading_space_after_pt=self.heading_space_after_pt,
            heading_level_1=dict(self.heading_level_1),
            heading_level_2=dict(self.heading_level_2),
            heading_level_3=dict(self.heading_level_3),
            margin_left_in=self.margin_left_in,
            margin_right_in=self.margin_right_in,
            margin_top_in=self.margin_top_in,
            margin_bottom_in=self.margin_bottom_in,
            references_line_spacing=self.references_line_spacing,
            references_hanging_indent_in=self.references_hanging_indent_in,
            references_check_heading_text=self.references_check_heading_text,
            references_heading_text=self.references_heading_text,
            references_allow_heading_aliases=self.references_allow_heading_aliases,
            references_check_heading_bold=self.references_check_heading_bold,
            references_heading_bold=self.references_heading_bold,
            references_check_heading_alignment=self.references_check_heading_alignment,
            references_heading_alignment=self.references_heading_alignment,
            references_check_start_on_new_page=self.references_check_start_on_new_page,
            references_check_hanging_indent=self.references_check_hanging_indent,
            references_check_line_spacing=self.references_check_line_spacing,
            references_check_space_before=self.references_check_space_before,
            references_space_before_pt=self.references_space_before_pt,
            references_check_space_after=self.references_check_space_after,
            references_space_after_pt=self.references_space_after_pt,
            references_check_font_family=self.references_check_font_family,
            references_font_family=self.references_font_family,
            references_check_font_size=self.references_check_font_size,
            references_font_size_pt=self.references_font_size_pt,
            references_check_alignment=self.references_check_alignment,
            references_alignment=self.references_alignment,
            caption_space_before_pt=self.caption_space_before_pt,
            caption_space_after_pt=self.caption_space_after_pt,
            list_space_after_pt=self.list_space_after_pt,
            role_exemptions=self.role_exemptions,
            table_eligibility=self.table_eligibility,
            citation_check_citations_have_references=self.citation_check_citations_have_references,
            citation_check_references_are_cited=self.citation_check_references_are_cited,
            citation_check_author_year_consistency=self.citation_check_author_year_consistency,
            citation_check_year_suffixes=self.citation_check_year_suffixes,
            citation_check_duplicate_references=self.citation_check_duplicate_references,
            citation_flag_ambiguous_matches=self.citation_flag_ambiguous_matches,
            citation_allow_personal_communication=self.citation_allow_personal_communication,
            fingerprint=fp,
        )

    def verify_fingerprint(self) -> bool:
        """True when the carried fingerprint matches the canonical one."""
        if not self.fingerprint:
            return False
        return self.fingerprint == self.compute_fingerprint()


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def _validate_profile(profile: DocumentFormattingProfile) -> None:
    """Raise ProfileValidationError with field paths on any profile issue."""
    errors = profile.validate()
    if errors:
        raise ProfileValidationError(errors)
    if profile.profile_source not in ("built_in", "custom"):
        raise ProfileValidationError([("profile_source", "must be 'built_in' or 'custom'")])
    if profile.profile_source == "built_in" and not profile.profile_id.startswith(("suc-", "apa")):
        raise ProfileValidationError([
            ("profile_source", "custom profile cannot claim built_in source")
        ])


def _resolve_body_effective(profile: DocumentFormattingProfile, errors: List[Tuple[str, str]]):
    """Resolve body font requirements into effective exact + allowed set.

    APA: allowed combos are preserved as pairs (never split font from size).
    A selected exact (font, size) must be inside the allowed set when an
    allowed set exists; otherwise it stays exact.
    """
    b = profile.body
    allowed = tuple(b.allowed_font_combos) if b.allowed_font_combos else ()

    # Validate a selected combination against the allowed set when present.
    if allowed and b.font_family is not None and b.font_size_pt is not None:
        if (b.font_family, b.font_size_pt) not in allowed:
            errors.append((
                "body",
                f"selected font combination ({b.font_family}, {b.font_size_pt}) "
                f"is not in the allowed set",
            ))
    return allowed


def _resolve_heading_effective(
    profile: DocumentFormattingProfile,
    body_allowed: Tuple[Tuple[str, float], ...],
    body_family: Optional[str],
    body_size: Optional[float],
    errors: List[Tuple[str, str]],
):
    """Resolve heading font requirements.

    `inherit_body_font=True` resolves to the selected valid body combination
    (or the full body allowed set when no selection is made) — no fixed
    descending heading sizes are introduced.
    """
    h = profile.heading
    if h.inherit_body_font:
        if h.font_family is not None or h.font_size_pt is not None:
            errors.append((
                "heading",
                "inherit_body_font conflicts with explicit heading font settings",
            ))
            return body_allowed, body_family, body_size
        # Inherit: exact body selection when present, else the allowed set.
        if body_family is not None and body_size is not None:
            return ((), body_family, body_size)
        return (body_allowed, None, None)
    allowed = tuple(h.allowed_font_combos) if h.allowed_font_combos else ()
    if allowed and h.font_family is not None and h.font_size_pt is not None:
        if (h.font_family, h.font_size_pt) not in allowed:
            errors.append((
                "heading",
                f"selected heading combination ({h.font_family}, {h.font_size_pt}) "
                f"is not in the allowed set",
            ))
    return allowed, h.font_family, h.font_size_pt


def resolve_snapshot(
    profile: DocumentFormattingProfile,
) -> EffectiveProfileSnapshot:
    """Resolve a validated profile into an immutable effective snapshot.

    Raises ProfileValidationError (field paths, no stack traces) on any
    invalid, malformed, or unresolved input. The returned snapshot is frozen
    and carries its canonical SHA-256 fingerprint.
    """
    _validate_profile(profile)

    errors: List[Tuple[str, str]] = []
    body_allowed = _resolve_body_effective(profile, errors)
    heading_allowed, heading_family, heading_size = _resolve_heading_effective(
        profile, body_allowed, profile.body.font_family, profile.body.font_size_pt, errors
    )
    if errors:
        raise ProfileValidationError(errors)

    # SUC is institution-specific; APA is not. Custom profiles inherit
    # nothing about universal status — only built-ins carry the label.
    institution_specific = bool(
        profile.profile_source == "built_in"
        and profile.profile_id.startswith("suc-")
    )

    # Citation matching dependency: year/suffix comparisons only run when the
    # citation-without-reference check is on. The resolver normalizes the
    # dependent toggles instead of erroring, so a stale editor payload can
    # never enable a dependent rule behind a disabled parent.
    cm = profile.citation_matching
    parent_on = bool(cm.check_citations_have_references)

    # Reference List rules. The snapshot records the EXACT configured values
    # (never a value silently dropped because its toggle is off — the audit
    # disclosure must show what the profile says), while each
    # `references_check_*` toggle is the resolved effective switch. Rules
    # read a value only when its toggle is on, so a disabled check emits
    # nothing and never compares against a stored value.
    refs = profile.references
    heading_text_on = bool(refs.check_heading_text)
    resolved_heading_text = (
        refs.heading_text.strip().lower()
        if heading_text_on and isinstance(refs.heading_text, str)
        else refs.heading_text.strip().lower()
        if isinstance(refs.heading_text, str)
        else None
    )
    # The one PRESERVED rule: an explicit toggle always wins, and a profile
    # that predates the toggle keeps exactly the enforcement it always had —
    # active if and only if a line-spacing value is stored.
    resolved_line_spacing_check = (
        refs.line_spacing is not None
        if refs.check_line_spacing is None
        else bool(refs.check_line_spacing)
    )

    snapshot = EffectiveProfileSnapshot(
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        profile_id=profile.profile_id,
        profile_name=profile.profile_name,
        profile_version=profile.profile_version,
        profile_source=profile.profile_source,
        description=profile.description,
        citation_style=profile.citation_style,
        institution_specific=institution_specific,

        body_font_family=profile.body.font_family,
        body_font_size_pt=profile.body.font_size_pt,
        body_allowed_font_combos=body_allowed,
        body_line_spacing=profile.body.line_spacing,
        body_alignment=profile.body.alignment,
        body_space_before_pt=profile.body.space_before_pt,
        body_space_after_pt=profile.body.space_after_pt,
        body_first_line_indent_in=profile.body.first_line_indent_in,

        heading_font_family=heading_family,
        heading_font_size_pt=heading_size,
        heading_allowed_font_combos=heading_allowed,
        heading_alignment=profile.heading.alignment,
        heading_space_before_pt=profile.heading.space_before_pt,
        heading_space_after_pt=profile.heading.space_after_pt,
        heading_level_1=dict(profile.heading.level_1 or {}),
        heading_level_2=dict(profile.heading.level_2 or {}),
        heading_level_3=dict(profile.heading.level_3 or {}),

        margin_left_in=profile.margins.margin_left_in,
        margin_right_in=profile.margins.margin_right_in,
        margin_top_in=profile.margins.margin_top_in,
        margin_bottom_in=profile.margins.margin_bottom_in,

        references_line_spacing=refs.line_spacing,
        references_hanging_indent_in=refs.hanging_indent_in,
        references_check_heading_text=heading_text_on,
        references_heading_text=resolved_heading_text,
        references_allow_heading_aliases=bool(refs.allow_heading_aliases),
        references_check_heading_bold=bool(refs.check_heading_bold),
        references_heading_bold=bool(refs.heading_bold),
        references_check_heading_alignment=bool(refs.check_heading_alignment),
        references_heading_alignment=refs.heading_alignment,
        references_check_start_on_new_page=bool(refs.check_start_on_new_page),
        references_check_hanging_indent=bool(refs.check_hanging_indent),
        references_check_line_spacing=resolved_line_spacing_check,
        references_check_space_before=bool(refs.check_space_before),
        references_space_before_pt=refs.space_before_pt,
        references_check_space_after=bool(refs.check_space_after),
        references_space_after_pt=refs.space_after_pt,
        references_check_font_family=bool(refs.check_font_family),
        references_font_family=refs.font_family,
        references_check_font_size=bool(refs.check_font_size),
        references_font_size_pt=refs.font_size_pt,
        references_check_alignment=bool(refs.check_alignment),
        references_alignment=refs.alignment,

        caption_space_before_pt=profile.captions.space_before_pt,
        caption_space_after_pt=profile.captions.space_after_pt,

        list_space_after_pt=profile.lists.space_after_pt,

        role_exemptions=tuple(sorted(profile.role_policy.exempt_roles)),
        table_eligibility=profile.role_policy.table_eligibility,

        citation_check_citations_have_references=parent_on,
        citation_check_references_are_cited=bool(cm.check_references_are_cited),
        citation_check_author_year_consistency=bool(
            cm.check_author_year_consistency and parent_on
        ),
        citation_check_year_suffixes=bool(cm.check_year_suffixes and parent_on),
        citation_check_duplicate_references=bool(cm.check_duplicate_references),
        citation_flag_ambiguous_matches=bool(cm.flag_ambiguous_matches),
        citation_allow_personal_communication=bool(cm.allow_personal_communication),
    )
    return snapshot.with_fingerprint()


def snapshot_from_dict(data: Dict[str, Any]) -> EffectiveProfileSnapshot:
    """Reconstruct an immutable snapshot from a plain dict (persisted form).

    Validates the schema version and rejects malformed/unknown fields with
    field paths. The fingerprint is recomputed and compared — a mismatch
    indicates corruption.
    """
    if not isinstance(data, dict):
        raise ProfileValidationError([("", "snapshot payload must be a JSON object")])

    version = data.get("schema_version")
    if version not in SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS:
        raise ProfileValidationError([
            ("schema_version", f"unsupported schema version {version!r}; "
                               f"expected one of {list(SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS)}")
        ])
    version_int = int(version)

    # Reject unknown top-level fields (deterministic, safe). The allowed set
    # follows the payload's own version: a v1 payload carrying v2 keys is
    # malformed, and a v1 payload without citation_matching is complete.
    allowed = set(_canonical_order_for(version_int))
    unknown = set(data) - allowed
    if unknown:
        raise ProfileValidationError([
            (k, "unknown field") for k in sorted(unknown)
        ])

    body = data.get("body") or {}
    heading = data.get("heading") or {}
    margins = data.get("margins") or {}
    refs = data.get("references") or {}
    caps = data.get("captions") or {}
    lists = data.get("lists") or {}
    if not all(isinstance(x, dict) for x in (body, heading, margins, refs, caps, lists)):
        raise ProfileValidationError([("", "group fields must be JSON objects")])

    # Reject unknown NESTED fields — a snapshot carrying unresolved profile
    # constructs (e.g. inherit_body_font) is malformed and rejected safely.
    _group_fields = {
        "body": {"font_family", "font_size_pt", "allowed_font_combos", "line_spacing",
                 "alignment", "space_before_pt", "space_after_pt", "first_line_indent_in"},
        "heading": {"font_family", "font_size_pt", "allowed_font_combos", "alignment",
                    "space_before_pt", "space_after_pt", "level_1", "level_2", "level_3"},
        "margins": {"left_in", "right_in", "top_in", "bottom_in"},
        # Nested references keys follow the payload's own version: a v1/v2
        # payload carrying v3 Reference List keys is malformed, and a v3
        # payload missing them is completed from the schema defaults.
        "references": set(_references_group_keys(version_int)),
        "captions": {"space_before_pt", "space_after_pt"},
        "lists": {"space_after_pt"},
    }
    for group_name, group in (("body", body), ("heading", heading), ("margins", margins),
                              ("references", refs), ("captions", caps), ("lists", lists)):
        unk = set(group) - _group_fields[group_name]
        if unk:
            raise ProfileValidationError([
                (f"{group_name}.{k}", "unknown field") for k in sorted(unk)
            ])

    def _combos(v):
        if v is None:
            return ()
        return tuple(tuple(c) for c in v)

    citation_group = data.get("citation_matching")
    if citation_group is None:
        citation_group = {}
    if not isinstance(citation_group, dict):
        raise ProfileValidationError([("citation_matching", "must be a JSON object")])
    cm_defaults = CitationMatchingSettings()
    cm_values: Dict[str, bool] = {}
    for name in CitationMatchingSettings.__dataclass_fields__:
        raw = citation_group.get(name, getattr(cm_defaults, name))
        if not isinstance(raw, bool):
            raise ProfileValidationError([
                (f"citation_matching.{name}", "must be true or false")
            ])
        cm_values[f"citation_{name}"] = raw

    # Reference List rule fields (v3+). Defaults come from the snapshot
    # dataclass, so a v3 payload missing a key completes to the documented
    # "off" state; a v1/v2 payload can never carry them at all.
    ref_defaults = EffectiveProfileSnapshot()
    ref_values: Dict[str, Any] = {}
    for key in _REFERENCES_GROUP_KEYS_V3:
        attr = "references_" + key
        raw = refs.get(key, getattr(ref_defaults, attr))
        if isinstance(getattr(ref_defaults, attr), bool):
            if not isinstance(raw, bool):
                raise ProfileValidationError([
                    (f"references.{key}", "must be true or false")
                ])
        ref_values[attr] = raw

    snapshot = EffectiveProfileSnapshot(
        schema_version=int(version),
        profile_id=str(data.get("profile_id") or ""),
        profile_name=str(data.get("profile_name") or ""),
        profile_version=int(data.get("profile_version") or 1),
        profile_source=str(data.get("profile_source") or "built_in"),
        description=str(data.get("description") or ""),
        citation_style=str(data.get("citation_style") or "APA 7"),
        institution_specific=bool(data.get("institution_specific", False)),
        body_font_family=body.get("font_family"),
        body_font_size_pt=body.get("font_size_pt"),
        body_allowed_font_combos=_combos(body.get("allowed_font_combos")),
        body_line_spacing=body.get("line_spacing"),
        body_alignment=body.get("alignment"),
        body_space_before_pt=body.get("space_before_pt"),
        body_space_after_pt=body.get("space_after_pt"),
        body_first_line_indent_in=body.get("first_line_indent_in"),
        heading_font_family=heading.get("font_family"),
        heading_font_size_pt=heading.get("font_size_pt"),
        heading_allowed_font_combos=_combos(heading.get("allowed_font_combos")),
        heading_alignment=heading.get("alignment"),
        heading_space_before_pt=heading.get("space_before_pt"),
        heading_space_after_pt=heading.get("space_after_pt"),
        heading_level_1=dict(heading.get("level_1") or {}),
        heading_level_2=dict(heading.get("level_2") or {}),
        heading_level_3=dict(heading.get("level_3") or {}),
        margin_left_in=margins.get("left_in"),
        margin_right_in=margins.get("right_in"),
        margin_top_in=margins.get("top_in"),
        margin_bottom_in=margins.get("bottom_in"),
        **ref_values,
        caption_space_before_pt=caps.get("space_before_pt"),
        caption_space_after_pt=caps.get("space_after_pt"),
        list_space_after_pt=lists.get("space_after_pt"),
        role_exemptions=tuple(sorted(data.get("role_exemptions") or [])),
        table_eligibility=str(data.get("table_eligibility") or "administrative"),
        fingerprint=str(data.get("fingerprint") or ""),
        **cm_values,
    )

    if not snapshot.verify_fingerprint():
        raise ProfileValidationError([
            ("fingerprint", "fingerprint mismatch — snapshot data corrupted")
        ])
    return snapshot
