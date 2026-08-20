"""Document Formatting Profile — Phase 1 PoC (schema + validation only).

Read-only model layer. This Build changes NO rules, scoring, findings,
APIs, database, migrations, or historical audits. It defines the versioned,
validated profile shape that later Builds will resolve into an immutable
per-Audit snapshot.

Design contract (owner-approved):
  - Citation Style is a separate, independent field. APA 7 is the only
    supported value in the current release; no other engines are designed.
  - Requirement kinds are explicit and unambiguous:
      * exact value        → required numeric/string
      * allowed set        → e.g. font/size combinations (APA fonts)
      * inheritance        → e.g. heading font inherits body settings
      * nullable           → None means "skip the deterministic check and
                             create no scored finding" — never 0/""/missing
      * role exemptions    → explicit set of roles exempt from a rule
  - Units are explicit: points (font size, spacing), inches (margins,
    indentation), numeric multipliers (line spacing).
  - Validation errors carry field paths so the UI can show actionable
    messages.
  - Serialization is deterministic (stable key order) so snapshots and
    exports are reproducible.
"""
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import uuid4

# The only supported citation style in the current release.
SUPPORTED_CITATION_STYLES = frozenset({"APA 7"})
DEFAULT_CITATION_STYLE = "APA 7"

# Explicit units are part of the contract — no bare numbers.
_FONT_SIZE_PT_RANGE = (6.0, 72.0)
_LINE_SPACING_RANGE = (1.0, 4.0)
_SPACING_PT_RANGE = (0.0, 240.0)
_MARGIN_IN_RANGE = (0.0, 4.0)
_INDENT_IN_RANGE = (0.0, 4.0)

# Body font/size combinations accepted by APA 7 (verified per the official
# guide — not limited to Times New Roman 12 pt).
APA_ALLOWED_FONT_COMBOS: Tuple[Tuple[str, float], ...] = (
    ("Times New Roman", 12.0),
    ("Calibri", 11.0),
    ("Arial", 11.0),
    ("Georgia", 11.0),
    ("Lucida Sans Unicode", 10.0),
    ("Computer Modern", 10.0),
)


class ProfileValidationError(ValueError):
    """Raised when a profile fails validation.

    `errors` is a list of (field_path, message) tuples so the UI can render
    actionable messages next to the offending field.
    """

    def __init__(self, errors: List[Tuple[str, str]]):
        self.errors = errors
        joined = "; ".join(f"{path}: {msg}" for path, msg in errors)
        super().__init__(f"Profile validation failed: {joined}")


def _require_unit(value: float, name: str, lo: float, hi: float) -> Optional[str]:
    """Validate a finite numeric value within [lo, hi]. Returns error or None."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return f"must be a number, got {type(value).__name__}"
    if value < lo or value > hi:
        return f"must be between {lo:g} and {hi:g}"
    return None


# ---------------------------------------------------------------------------
# Settings groups
# ---------------------------------------------------------------------------


@dataclass
class BodySettings:
    """Body text requirements. None = no deterministic requirement."""
    font_family: Optional[str] = None
    font_size_pt: Optional[float] = None          # exact value OR part of allowed set
    allowed_font_combos: Optional[Tuple[Tuple[str, float], ...]] = None
    line_spacing: Optional[float] = None
    alignment: Optional[str] = None               # left | center | right | justify
    space_before_pt: Optional[float] = None
    space_after_pt: Optional[float] = None
    first_line_indent_in: Optional[float] = None


@dataclass
class HeadingSettings:
    """Heading requirements. `inherit_body_font` pulls from body settings."""
    inherit_body_font: bool = False
    font_family: Optional[str] = None
    font_size_pt: Optional[float] = None
    allowed_font_combos: Optional[Tuple[Tuple[str, float], ...]] = None
    alignment: Optional[str] = None
    space_before_pt: Optional[float] = None
    space_after_pt: Optional[float] = None
    # APA distinguishes levels by alignment/bold/italic, not fixed sizes.
    level_1: Optional[Dict[str, Any]] = None
    level_2: Optional[Dict[str, Any]] = None
    level_3: Optional[Dict[str, Any]] = None


@dataclass
class MarginSettings:
    margin_left_in: Optional[float] = None
    margin_right_in: Optional[float] = None
    margin_top_in: Optional[float] = None
    margin_bottom_in: Optional[float] = None


@dataclass
class ReferencesSettings:
    line_spacing: Optional[float] = None
    hanging_indent_in: Optional[float] = None


@dataclass
class CaptionSettings:
    space_before_pt: Optional[float] = None
    space_after_pt: Optional[float] = None


@dataclass
class ListSettings:
    space_after_pt: Optional[float] = None


@dataclass
class RolePolicy:
    """Role-specific eligibility and exemptions.

    `exempt_roles` = roles that receive NO deterministic formatting findings.
    `table_eligibility` = how tables are classified (e.g. administrative
    tables are not caption targets).
    """
    exempt_roles: Set[str] = field(default_factory=set)
    table_eligibility: str = "administrative"  # administrative | scholarly | both


@dataclass
class DocumentFormattingProfile:
    """Versioned, validated document formatting profile.

    `profile_source` distinguishes built-in (registry, immutable) from
    custom (user-created, local-only in MVP).
    """
    profile_id: str
    profile_name: str
    profile_version: int = 1
    profile_source: str = "custom"  # built_in | custom
    description: str = ""
    citation_style: str = DEFAULT_CITATION_STYLE

    body: BodySettings = field(default_factory=BodySettings)
    heading: HeadingSettings = field(default_factory=HeadingSettings)
    margins: MarginSettings = field(default_factory=MarginSettings)
    references: ReferencesSettings = field(default_factory=ReferencesSettings)
    captions: CaptionSettings = field(default_factory=CaptionSettings)
    lists: ListSettings = field(default_factory=ListSettings)
    role_policy: RolePolicy = field(default_factory=RolePolicy)

    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate(self) -> List[Tuple[str, str]]:
        """Return a list of (field_path, message) errors; empty = valid.

        Pure and side-effect free — callers may call it repeatedly.
        """
        errors: List[Tuple[str, str]] = []

        # Identity
        if not self.profile_id or not self.profile_id.strip():
            errors.append(("profile_id", "profile_id is required"))
        if not self.profile_name or not self.profile_name.strip():
            errors.append(("profile_name", "profile_name is required"))
        if self.profile_version < 1:
            errors.append(("profile_version", "must be >= 1"))
        if self.profile_source not in ("built_in", "custom"):
            errors.append(("profile_source", "must be 'built_in' or 'custom'"))

        # Citation style — APA 7 only in this release.
        if self.citation_style not in SUPPORTED_CITATION_STYLES:
            errors.append((
                "citation_style",
                f"unsupported citation style '{self.citation_style}'; "
                f"supported: {sorted(SUPPORTED_CITATION_STYLES)}",
            ))

        # Body
        b = self.body
        if b.font_family is not None and not b.font_family.strip():
            errors.append(("body.font_family", "must not be empty when set"))
        e = _require_unit(b.font_size_pt, "body.font_size_pt", *_FONT_SIZE_PT_RANGE)
        if e:
            errors.append(("body.font_size_pt", e))
        if b.allowed_font_combos is not None:
            for combo in b.allowed_font_combos:
                if not isinstance(combo, (tuple, list)) or len(combo) != 2:
                    errors.append(("body.allowed_font_combos", f"invalid combo {combo!r}"))
                    continue
                fam, size = combo
                if not fam or not str(fam).strip():
                    errors.append(("body.allowed_font_combos", f"empty font in {combo!r}"))
                e = _require_unit(size, "body.allowed_font_combos.size", *_FONT_SIZE_PT_RANGE)
                if e:
                    errors.append(("body.allowed_font_combos", f"{combo!r}: {e}"))
        e = _require_unit(b.line_spacing, "body.line_spacing", *_LINE_SPACING_RANGE)
        if e:
            errors.append(("body.line_spacing", e))
        if b.alignment is not None and b.alignment not in ("left", "center", "right", "justify"):
            errors.append(("body.alignment", f"invalid '{b.alignment}'"))
        e = _require_unit(b.space_before_pt, "body.space_before_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("body.space_before_pt", e))
        e = _require_unit(b.space_after_pt, "body.space_after_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("body.space_after_pt", e))
        e = _require_unit(b.first_line_indent_in, "body.first_line_indent_in", *_INDENT_IN_RANGE)
        if e:
            errors.append(("body.first_line_indent_in", e))

        # Heading
        h = self.heading
        if h.inherit_body_font and (h.font_family is not None or h.font_size_pt is not None):
            errors.append((
                "heading",
                "inherit_body_font conflicts with explicit heading font settings",
            ))
        if h.font_family is not None and not h.font_family.strip():
            errors.append(("heading.font_family", "must not be empty when set"))
        e = _require_unit(h.font_size_pt, "heading.font_size_pt", *_FONT_SIZE_PT_RANGE)
        if e:
            errors.append(("heading.font_size_pt", e))
        if h.alignment is not None and h.alignment not in ("left", "center", "right", "justify"):
            errors.append(("heading.alignment", f"invalid '{h.alignment}'"))
        e = _require_unit(h.space_before_pt, "heading.space_before_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("heading.space_before_pt", e))
        e = _require_unit(h.space_after_pt, "heading.space_after_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("heading.space_after_pt", e))
        for lvl, name in ((h.level_1, "level_1"), (h.level_2, "level_2"), (h.level_3, "level_3")):
            if lvl is None:
                continue
            if not isinstance(lvl, dict):
                errors.append((f"heading.{name}", "must be a mapping"))
                continue
            for key in ("bold", "italic"):
                if key in lvl and not isinstance(lvl[key], bool):
                    errors.append((f"heading.{name}.{key}", "must be a boolean"))

        # Margins
        for key, path in (
            (self.margins.margin_left_in, "margins.margin_left_in"),
            (self.margins.margin_right_in, "margins.margin_right_in"),
            (self.margins.margin_top_in, "margins.margin_top_in"),
            (self.margins.margin_bottom_in, "margins.margin_bottom_in"),
        ):
            e = _require_unit(key, path, *_MARGIN_IN_RANGE)
            if e:
                errors.append((path, e))

        # References
        e = _require_unit(self.references.line_spacing, "references.line_spacing", *_LINE_SPACING_RANGE)
        if e:
            errors.append(("references.line_spacing", e))
        e = _require_unit(self.references.hanging_indent_in, "references.hanging_indent_in", *_INDENT_IN_RANGE)
        if e:
            errors.append(("references.hanging_indent_in", e))

        # Captions / lists
        e = _require_unit(self.captions.space_before_pt, "captions.space_before_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("captions.space_before_pt", e))
        e = _require_unit(self.captions.space_after_pt, "captions.space_after_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("captions.space_after_pt", e))
        e = _require_unit(self.lists.space_after_pt, "lists.space_after_pt", *_SPACING_PT_RANGE)
        if e:
            errors.append(("lists.space_after_pt", e))

        # Role policy
        if self.role_policy.table_eligibility not in ("administrative", "scholarly", "both"):
            errors.append((
                "role_policy.table_eligibility",
                f"invalid '{self.role_policy.table_eligibility}'",
            ))

        return errors

    def validate_or_raise(self) -> "DocumentFormattingProfile":
        errors = self.validate()
        if errors:
            raise ProfileValidationError(errors)
        return self

    # ------------------------------------------------------------------
    # Deterministic serialization
    # ------------------------------------------------------------------

    def to_dict(self, ordered: bool = True) -> Dict[str, Any]:
        """Serialize to a plain dict with STABLE key order.

        `ordered=True` (default) produces a canonical, deterministic layout
        suitable for snapshots/exports and equality checks. Sets are sorted
        for reproducibility.
        """
        d = asdict(self)
        if not ordered:
            return d
        return _ordered_dict(d)


def _ordered_dict(d: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively rebuild a dict with a fixed, documented key order.

    Sets are converted to sorted lists so serialized output is byte-stable.
    """
    order = (
        "profile_id", "profile_name", "profile_version", "profile_source",
        "description", "citation_style",
        "body", "heading", "margins", "references", "captions", "lists",
        "role_policy", "created_at", "updated_at",
    )
    out: Dict[str, Any] = {}
    for key in order:
        if key not in d:
            continue
        val = d[key]
        out[key] = _ordered_value(val)
    # Any future/unknown keys append at the end (never dropped).
    for key in d:
        if key not in out:
            out[key] = _ordered_value(d[key])
    return out


def _ordered_value(val: Any) -> Any:
    if isinstance(val, dict):
        # Nested group key order is stable by construction (dataclass fields).
        return {k: _ordered_value(v) for k, v in val.items()}
    if isinstance(val, (set, frozenset)):
        return sorted(str(v) for v in val)
    if isinstance(val, (list, tuple)):
        return [_ordered_value(v) for v in val]
    return val


def profile_from_dict(data: Dict[str, Any]) -> DocumentFormattingProfile:
    """Reconstruct a profile from a plain dict (e.g. a persisted snapshot).

    Rejects unknown top-level fields and malformed shapes with a
    ProfileValidationError carrying field paths. None/missing nullable
    settings stay None (no deterministic requirement).
    """
    if not isinstance(data, dict):
        raise ProfileValidationError([("", "profile payload must be a JSON object")])

    # Reject unknown top-level fields — a malformed snapshot is not silently
    # accepted (deterministic, safe).
    allowed = {
        "profile_id", "profile_name", "profile_version", "profile_source",
        "description", "citation_style",
        "body", "heading", "margins", "references", "captions", "lists",
        "role_policy", "created_at", "updated_at",
    }
    unknown = set(data) - allowed
    if unknown:
        raise ProfileValidationError([
            (k, f"unknown field") for k in sorted(unknown)
        ])

    def _group(key: str, cls):
        val = data.get(key) or {}
        if not isinstance(val, dict):
            raise ProfileValidationError([(key, "must be a JSON object")])
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        unk = set(val) - known
        if unk:
            raise ProfileValidationError([
                (f"{key}.{k}", "unknown field") for k in sorted(unk)
            ])
        return val

    body_raw = _group("body", BodySettings)
    heading_raw = _group("heading", HeadingSettings)
    margins_raw = _group("margins", MarginSettings)
    refs_raw = _group("references", ReferencesSettings)
    caps_raw = _group("captions", CaptionSettings)
    lists_raw = _group("lists", ListSettings)
    rp_raw = _group("role_policy", RolePolicy)

    # allowed_font_combos arrives as a list of pairs — restore tuple form.
    if body_raw.get("allowed_font_combos") is not None:
        body_raw["allowed_font_combos"] = tuple(
            tuple(c) for c in body_raw["allowed_font_combos"]
        )
    if heading_raw.get("allowed_font_combos") is not None:
        heading_raw["allowed_font_combos"] = tuple(
            tuple(c) for c in heading_raw["allowed_font_combos"]
        )
    if isinstance(rp_raw.get("exempt_roles"), list):
        rp_raw["exempt_roles"] = set(rp_raw["exempt_roles"])

    try:
        profile = DocumentFormattingProfile(
            profile_id=str(data.get("profile_id") or ""),
            profile_name=str(data.get("profile_name") or ""),
            profile_version=int(data.get("profile_version") or 1),
            profile_source=str(data.get("profile_source") or "custom"),
            description=str(data.get("description") or ""),
            citation_style=str(data.get("citation_style") or DEFAULT_CITATION_STYLE),
            body=BodySettings(**body_raw),
            heading=HeadingSettings(**heading_raw),
            margins=MarginSettings(**margins_raw),
            references=ReferencesSettings(**refs_raw),
            captions=CaptionSettings(**caps_raw),
            lists=ListSettings(**lists_raw),
            role_policy=RolePolicy(**rp_raw),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )
    except TypeError as exc:
        raise ProfileValidationError([("", f"malformed profile: {exc}")])
    except ValueError as exc:
        raise ProfileValidationError([("", f"malformed profile: {exc}")])

    errors = profile.validate()
    if errors:
        raise ProfileValidationError(errors)
    return profile


def new_custom_profile(
    profile_name: str,
    base: Optional[DocumentFormattingProfile] = None,
    description: str = "",
) -> DocumentFormattingProfile:
    """Create a custom profile starting from a built-in (or a blank safe
    template). Custom profiles are local-only in MVP.

    A blank template has every deterministic requirement None — the user
    must supply explicit values before each check is enabled.
    """
    now = datetime.now(timezone.utc).isoformat()
    if base is not None:
        profile = DocumentFormattingProfile(
            profile_id=str(uuid4()),
            profile_name=profile_name,
            profile_version=1,
            profile_source="custom",
            description=description,
            citation_style=base.citation_style,
            body=BodySettings(**asdict(base.body)),
            heading=HeadingSettings(**asdict(base.heading)),
            margins=MarginSettings(**asdict(base.margins)),
            references=ReferencesSettings(**asdict(base.references)),
            captions=CaptionSettings(**asdict(base.captions)),
            lists=ListSettings(**asdict(base.lists)),
            role_policy=RolePolicy(
                exempt_roles=set(base.role_policy.exempt_roles),
                table_eligibility=base.role_policy.table_eligibility,
            ),
            created_at=now,
            updated_at=now,
        )
        return profile
    return DocumentFormattingProfile(
        profile_id=str(uuid4()),
        profile_name=profile_name,
        profile_version=1,
        profile_source="custom",
        description=description,
        created_at=now,
        updated_at=now,
    )
