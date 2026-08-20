"""PresetConfig adapter — effective snapshot → rule config (Build 4).

A PURE, immutable adapter that maps the resolved EffectiveProfileSnapshot
into the config shape the deterministic rules already consume. Production
audit execution passes this snapshot-derived config into the engine; the
global PresetConfig is never read during a production audit.

Contract:
  - output comes EXCLUSIVELY from the resolved snapshot;
  - nullable values stay null (no global-default fallback);
  - caption *detection* patterns are profile-independent and delegate to the
    real PresetConfig (caption language patterns are not a profile field);
  - `profile_name` rides along so rules emit profile-aware messages.

Font pair semantics:
  - exact institutional (family, size) → validate both exactly;
  - allowed font-and-size combinations (APA) → validate each pair TOGETHER;
    a valid family with a size belonging to another allowed family is
    rejected. Heading inheritance uses the selected valid body pair and
    never introduces fixed 16/14/12 pt sizes.
"""
from typing import Optional, Tuple

from app.config import PresetConfig
from app.services.profile_snapshot import EffectiveProfileSnapshot


def snapshot_to_preset_view(snapshot: EffectiveProfileSnapshot) -> dict:
    """Backward-compat dict view (Build 2 shape). New code should use
    EffectiveProfileConfig for rule execution."""
    cfg = EffectiveProfileConfig(snapshot)
    return {
        "FONT_FAMILY": cfg.FONT_FAMILY,
        "FONT_SIZE_BODY": cfg.FONT_SIZE_BODY,
        "FONT_SIZE_H1": cfg.FONT_SIZE_H1,
        "FONT_SIZE_H2": cfg.FONT_SIZE_H2,
        "FONT_SIZE_H3": cfg.FONT_SIZE_H3,
        "FONT_WEIGHT_HEADING": cfg.FONT_WEIGHT_HEADING,
        "LINE_SPACING_BODY": cfg.LINE_SPACING_BODY,
        "SPACE_BEFORE_HEADING": cfg.SPACE_BEFORE_HEADING,
        "SPACE_AFTER_HEADING": cfg.SPACE_AFTER_HEADING,
        "SPACE_BEFORE_BODY": cfg.SPACE_BEFORE_BODY,
        "SPACE_AFTER_BODY": cfg.SPACE_AFTER_BODY,
        "LIST_SPACE_AFTER": cfg.LIST_SPACE_AFTER,
        "CAPTION_SPACE_BEFORE": cfg.CAPTION_SPACE_BEFORE,
        "CAPTION_SPACE_AFTER": cfg.CAPTION_SPACE_AFTER,
        "REFERENCES_LINE_SPACING": cfg.REFERENCES_LINE_SPACING,
        "ALIGNMENT_BODY": cfg.ALIGNMENT_BODY,
        "ALIGNMENT_HEADING": cfg.ALIGNMENT_HEADING,
        "MARGIN_LEFT": cfg.MARGIN_LEFT,
        "MARGIN_RIGHT": cfg.MARGIN_RIGHT,
        "MARGIN_TOP": cfg.MARGIN_TOP,
        "MARGIN_BOTTOM": cfg.MARGIN_BOTTOM,
    }


class EffectiveProfileConfig:
    """Immutable rule-config view of an EffectiveProfileSnapshot.

    Exposes the same attribute names the deterministic rules read from
    PresetConfig, plus profile identity for messages and font-combo data
    for pair validation. No global fallback: every requirement comes from
    the snapshot.
    """

    def __init__(self, snapshot: EffectiveProfileSnapshot):
        self._snapshot = snapshot
        self.profile_name = snapshot.profile_name or "Selected profile"
        self.profile_id = snapshot.profile_id
        self.profile_source = snapshot.profile_source

        # Font (exact + allowed combos).
        self.FONT_FAMILY = snapshot.body_font_family
        self.FONT_SIZE_BODY = snapshot.body_font_size_pt
        self.BODY_ALLOWED_FONT_COMBOS = snapshot.body_allowed_font_combos

        # Heading per-level (inheritance already resolved in snapshot).
        self.FONT_SIZE_H1 = self._heading_size(1)
        self.FONT_SIZE_H2 = self._heading_size(2)
        self.FONT_SIZE_H3 = self._heading_size(3)
        self.HEADING_FONT_FAMILY = snapshot.heading_font_family
        self.HEADING_ALLOWED_FONT_COMBOS = snapshot.heading_allowed_font_combos
        self.FONT_WEIGHT_HEADING = "bold"

        # Spacing.
        self.LINE_SPACING_BODY = snapshot.body_line_spacing
        # The profile schema has no heading line-spacing field — the current
        # preset hardcodes 1.0. Keep 1.0 (legacy behavior) but never invent
        # a profile requirement for it.
        self.LINE_SPACING_HEADING = 1.0
        self.SPACE_BEFORE_HEADING = snapshot.heading_space_before_pt
        self.SPACE_AFTER_HEADING = snapshot.heading_space_after_pt
        self.SPACE_BEFORE_BODY = snapshot.body_space_before_pt
        self.SPACE_AFTER_BODY = snapshot.body_space_after_pt

        # Role-specific.
        self.LIST_SPACE_AFTER = snapshot.list_space_after_pt
        self.CAPTION_SPACE_BEFORE = snapshot.caption_space_before_pt
        self.CAPTION_SPACE_AFTER = snapshot.caption_space_after_pt
        self.REFERENCES_LINE_SPACING = snapshot.references_line_spacing

        # Alignment.
        self.ALIGNMENT_BODY = snapshot.body_alignment
        self.ALIGNMENT_HEADING = snapshot.heading_alignment

        # Margins (inches).
        self.MARGIN_LEFT = snapshot.margin_left_in
        self.MARGIN_RIGHT = snapshot.margin_right_in
        self.MARGIN_TOP = snapshot.margin_top_in
        self.MARGIN_BOTTOM = snapshot.margin_bottom_in

        # Role exemptions — consumed by role_eligibility, not by preset
        # attributes; exposed for completeness.
        self.ROLE_EXEMPTIONS = snapshot.role_exemptions
        self.TABLE_ELIGIBILITY = snapshot.table_eligibility

    # ------------------------------------------------------------------

    def _heading_size(self, level: int) -> Optional[float]:
        """Heading size for a level.

        Explicit heading size wins. APA inherits the body font — all heading
        levels use the selected body pair (same size, never 16/14/12 pt
        descent). Otherwise None (no deterministic requirement).
        """
        snap = self._snapshot
        if snap.heading_font_size_pt is not None:
            return snap.heading_font_size_pt
        # Inherit body font: heading family is None only when inherited.
        if snap.heading_font_family is None and snap.body_font_size_pt is not None:
            return snap.body_font_size_pt
        return None

    def is_caption_text(self, text: str) -> bool:
        """Caption detection — profile-independent language patterns."""
        return PresetConfig().is_caption_text(text)

    def is_font_pair_allowed(
        self,
        family: Optional[str],
        size: Optional[float],
        *,
        heading: bool = False,
    ) -> bool:
        """Validate a (family, size) run against the profile's allowed set.

        Exact institutional profile: pair matches exactly. Allowed-set
        profile (APA): the pair must be one of the allowed pairs TOGETHER —
        a valid family with a size from another family is rejected.
        Returns True when the profile has no requirement for this side.
        """
        allowed = (
            self.HEADING_ALLOWED_FONT_COMBOS if heading
            else self.BODY_ALLOWED_FONT_COMBOS
        )
        if not allowed:
            return True
        if family is None or size is None:
            return True  # nothing to validate
        norm = (family.strip(), float(size))
        return any(
            abs(norm[1] - float(exp_size)) < 0.01 and norm[0].lower() == exp_family.lower()
            for exp_family, exp_size in allowed
        )

    def heading_expected_size(self, level: int) -> Optional[float]:
        return self._heading_size(level)

    @property
    def profile_label(self) -> str:
        """Message-safe profile label: the quoted profile name."""
        return f'"{self.profile_name}"'
