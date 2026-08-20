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
    DocumentFormattingProfile,
    ProfileValidationError,
)

# Bump when the snapshot shape changes incompatibly.
SNAPSHOT_SCHEMA_VERSION = 1

# Canonical key order for deterministic serialization (byte-stable).
_CANONICAL_ORDER = (
    "schema_version", "profile_id", "profile_name", "profile_version",
    "profile_source", "description", "citation_style", "institution_specific",
    "body", "heading", "margins", "references", "captions", "lists",
    "role_exemptions", "table_eligibility", "fingerprint",
)


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

    caption_space_before_pt: Optional[float] = None
    caption_space_after_pt: Optional[float] = None

    list_space_after_pt: Optional[float] = None

    # Deterministic sorted role exemptions.
    role_exemptions: Tuple[str, ...] = ()
    table_eligibility: str = "administrative"

    fingerprint: str = ""

    # ------------------------------------------------------------------
    # Deterministic canonical serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """Canonical dict — stable key order, sorted tuples, no transient
        state (timestamps never enter the snapshot)."""
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
            "references": {
                "line_spacing": self.references_line_spacing,
                "hanging_indent_in": self.references_hanging_indent_in,
            },
            "captions": {
                "space_before_pt": self.caption_space_before_pt,
                "space_after_pt": self.caption_space_after_pt,
            },
            "lists": {
                "space_after_pt": self.list_space_after_pt,
            },
            "role_exemptions": list(self.role_exemptions),
            "table_eligibility": self.table_eligibility,
            "fingerprint": self.fingerprint,
        }
        return {k: d[k] for k in _CANONICAL_ORDER if k in d}

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
            caption_space_before_pt=self.caption_space_before_pt,
            caption_space_after_pt=self.caption_space_after_pt,
            list_space_after_pt=self.list_space_after_pt,
            role_exemptions=self.role_exemptions,
            table_eligibility=self.table_eligibility,
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

        references_line_spacing=profile.references.line_spacing,
        references_hanging_indent_in=profile.references.hanging_indent_in,

        caption_space_before_pt=profile.captions.space_before_pt,
        caption_space_after_pt=profile.captions.space_after_pt,

        list_space_after_pt=profile.lists.space_after_pt,

        role_exemptions=tuple(sorted(profile.role_policy.exempt_roles)),
        table_eligibility=profile.role_policy.table_eligibility,
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
    if version != SNAPSHOT_SCHEMA_VERSION:
        raise ProfileValidationError([
            ("schema_version", f"unsupported schema version {version!r}; "
                               f"expected {SNAPSHOT_SCHEMA_VERSION}")
        ])

    # Reject unknown top-level fields (deterministic, safe).
    allowed = set(_CANONICAL_ORDER)
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
        "references": {"line_spacing", "hanging_indent_in"},
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
        references_line_spacing=refs.get("line_spacing"),
        references_hanging_indent_in=refs.get("hanging_indent_in"),
        caption_space_before_pt=caps.get("space_before_pt"),
        caption_space_after_pt=caps.get("space_after_pt"),
        list_space_after_pt=lists.get("space_after_pt"),
        role_exemptions=tuple(sorted(data.get("role_exemptions") or [])),
        table_eligibility=str(data.get("table_eligibility") or "administrative"),
        fingerprint=str(data.get("fingerprint") or ""),
    )

    if not snapshot.verify_fingerprint():
        raise ProfileValidationError([
            ("fingerprint", "fingerprint mismatch — snapshot data corrupted")
        ])
    return snapshot
