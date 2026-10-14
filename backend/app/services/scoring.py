"""Weighted scoring engine — FR-4 implementation with per-category caps.

Each audit category has its own (major_weight, minor_weight, cap) tuple.
The cap prevents a single noisy category from zeroing-out the whole score:
a thesis with 8 margin errors (all Major) loses at most 32 points, not 120.

Returns BOTH the integer total AND a per-category breakdown so the frontend
no longer needs to re-derive scoring client-side (kills adapter.ts residual).
"""
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Tuple

from app.services.layout_violation import LayoutViolation


# ---------------------------------------------------------------------------
# Category metadata — single source of truth for scoring weights + caps
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CategoryMeta:
    """Per-category scoring configuration.

    Attributes:
        label: Human-readable name shown in the dashboard radar/bar charts.
        major_weight: Points deducted per MAJOR violation in this category.
        minor_weight: Points deducted per MINOR violation in this category.
        cap: Maximum total deduction this category can contribute.
             Prevents one noisy area from cratering the whole score.
    """
    label: str
    major_weight: int
    minor_weight: int
    cap: int


# Authoritative category table. Mirrors the frontend CATEGORY_META in
# frontend/src/lib/audit/scoring.ts — keep both in sync.
CATEGORY_META: Dict[str, CategoryMeta] = {
    "page_margins":         CategoryMeta("Page Margins",         major_weight=8, minor_weight=2, cap=32),
    "heading_hierarchy":    CategoryMeta("Heading Hierarchy",    major_weight=8, minor_weight=2, cap=32),
    "media_captions":       CategoryMeta("Media Captions",       major_weight=6, minor_weight=2, cap=28),
    "font_consistency":     CategoryMeta("Font Consistency",     major_weight=4, minor_weight=1, cap=18),
    "font_size":            CategoryMeta("Font Size Alignment",  major_weight=4, minor_weight=1, cap=18),
    "paragraph_typography": CategoryMeta("Paragraph Typography", major_weight=4, minor_weight=1, cap=20),
    "citation_apa":         CategoryMeta("APA Citations and References", major_weight=5, minor_weight=2, cap=25),
}

# Display order — controls how the breakdown renders in the radar chart.
CATEGORY_ORDER: List[str] = [
    "page_margins",
    "heading_hierarchy",
    "media_captions",
    "font_consistency",
    "font_size",
    "paragraph_typography",
    "citation_apa",
]

# Fallback bucket for rule_codes that don't map to any known category.
# Uses the legacy flat weights (15/3, no cap) so existing pytest cases
# that pass rule_code="X" continue to produce 85/97/67/0 exactly.
_DEFAULT_CATEGORY = CategoryMeta("Uncategorised", major_weight=15, minor_weight=3, cap=100)

# Explicit category for rules whose code does NOT follow the generic
# substring conventions below.
#
# Reference List FORMATTING rules are the reason this table exists: the
# generic `"REFERENCE" in code` branch routes every Reference code to
# citation_apa, which would score a hanging-indent problem as if it were a
# citation problem. Formatting codes are therefore classified explicitly
# FIRST, and only the semantic Phase 2 codes fall through to the generic
# branch. No category, cap, or weight is added or changed — the seven
# existing categories cover every new rule.
_RULE_CATEGORY_OVERRIDES: Dict[str, str] = {
    # Reference section structure: heading text, weight, alignment, page start.
    "REFERENCE_HEADING_TEXT": "heading_hierarchy",
    "REFERENCE_HEADING_BOLD": "heading_hierarchy",
    "REFERENCE_HEADING_ALIGNMENT": "heading_hierarchy",
    "REFERENCE_SECTION_NEW_PAGE": "heading_hierarchy",
    # Reference entry paragraph formatting — the closest existing paragraph
    # format category.
    "REFERENCE_HANGING_INDENT": "paragraph_typography",
    "REFERENCE_SPACE_BEFORE": "paragraph_typography",
    "REFERENCE_SPACE_AFTER": "paragraph_typography",
    "REFERENCE_ALIGNMENT": "paragraph_typography",
    # Generic paragraph spacing. The generic substring branch below cannot
    # catch these: "SPACE_BEFORE" contains neither "SPACING" nor "LINE", so
    # without explicit entries they would fall to the uncategorised
    # fallback bucket (legacy flat weights, deduction hidden from the
    # breakdown). Paragraph spacing belongs in paragraph_typography — the
    # same category the frontend adapter assigns by default.
    "SPACE_BEFORE": "paragraph_typography",
    "SPACE_AFTER": "paragraph_typography",
    # Fonts.
    "REFERENCE_FONT_FAMILY": "font_consistency",
    "REFERENCE_FONT_SIZE": "font_size",
    # Reference List alphabetical-order review: an author-identity
    # comparison, not entry formatting, so it scores with the other
    # semantic Reference rules instead of a formatting bucket.
    "REFERENCE_ORDER": "citation_apa",
}

# Exact pre-fix override table: the current table minus the two generic
# spacing entries. Used ONLY by the historical scoring contract
# (calculate_weighted_score_detailed(legacy_spacing=True)) so a legacy
# audit reproduces its stored score byte-for-byte. Unknown codes keep
# falling through to the generic branches in BOTH contracts.
_LEGACY_OVERRIDE_TABLE = {
    k: v for k, v in _RULE_CATEGORY_OVERRIDES.items()
    if k not in ("SPACE_BEFORE", "SPACE_AFTER")
}

# Presentation-only category row attached to historical GET/PDF breakdowns
# when a completed audit's stored score is confirmed to come from the
# pre-fix spacing contract. Never produced by rule detection.
LEGACY_SPACING_CATEGORY = "legacy_spacing"
LEGACY_SPACING_LABEL = "Legacy spacing adjustment"


def rule_code_to_category(rule_code: str, legacy_spacing: bool = False) -> str:
    """Map a backend rule_code (e.g. 'MARGIN_LEFT') to a category key.

    Mirrors the frontend categoryForRuleCode() in adapter.ts so both
    sides agree on bucketing. Unknown codes fall through to the default
    bucket, which uses legacy flat weights — preserves test expectations.

    `legacy_spacing=True` reproduces the EXACT pre-fix mapping: the two
    generic spacing codes fall to the uncategorised fallback bucket (flat
    15/3 weights, deduction excluded from the breakdown). Every other
    code maps identically in both contracts, so the difference between
    a legacy and a current total comes ONLY from SPACE_BEFORE/SPACE_AFTER
    rows.
    """
    code = (rule_code or "").upper()
    table = _LEGACY_OVERRIDE_TABLE if legacy_spacing else _RULE_CATEGORY_OVERRIDES
    override = table.get(code)
    if override is not None:
        return override
    if "CITATION" in code or "APA" in code:
        return "citation_apa"
    if "REFERENCE" in code:
        # Reference List SEMANTIC matching rules (uncited entry, duplicate
        # entry). Formatting rules never reach here: they are classified
        # explicitly above.
        return "citation_apa"
    if "MARGIN" in code or code.startswith("PAGE_"):
        return "page_margins"
    if "HEADING" in code or "HIERARCHY" in code:
        return "heading_hierarchy"
    if "CAPTION" in code or "MEDIA" in code or "IMAGE" in code or "ALT_TEXT" in code:
        return "media_captions"
    if "FONT_SIZE" in code or code.startswith("SIZE_"):
        return "font_size"
    if "FONT" in code:
        return "font_consistency"
    if "PARAGRAPH" in code or "LINE" in code or "SPACING" in code or "ALIGN" in code:
        return "paragraph_typography"
    return "uncategorised"  # fallback — uses _DEFAULT_CATEGORY weights


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class ScoreBreakdownItem:
    """One row in the per-category score breakdown."""
    category: str
    label: str
    major: int
    minor: int
    deduction: int
    remaining: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "label": self.label,
            "major": self.major,
            "minor": self.minor,
            "deduction": self.deduction,
            "remaining": self.remaining,
        }


@dataclass
class ScoreResult:
    """Full scoring output — total + counts + per-category breakdown."""
    total: int
    major_count: int
    minor_count: int
    breakdown: List[ScoreBreakdownItem] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total": self.total,
            "major_count": self.major_count,
            "minor_count": self.minor_count,
            "breakdown": [b.to_dict() for b in self.breakdown],
        }

    def __int__(self) -> int:
        """Backward-compat: int(score_result) returns the total.

        Existing code paths that do `score = calculate_weighted_score(v)`
        and then `score + 1` keep working transparently.
        """
        return self.total


# ---------------------------------------------------------------------------
# Public scoring entry points
# ---------------------------------------------------------------------------

def calculate_weighted_score_detailed(
    violations: List[LayoutViolation],
    citation_tip_count: int = 0,
    legacy_spacing: bool = False,
) -> ScoreResult:
    """Authoritative scoring — returns total + per-category breakdown.

    Args:
        violations: LayoutViolation list from the rules engine.
        citation_tip_count: Number of AI citation findings (treated as
            MINOR citation_apa violations). Pass 0 when no citation
            findings were confirmed.
        legacy_spacing: When True, score with the EXACT pre-fix category
            mapping (SPACE_BEFORE / SPACE_AFTER fall to the hidden
            uncategorised bucket). Used only to reproduce historical
            completed audits' stored scores; see
            select_scoring_contract(). New audits always use the
            current mapping (False).

    Returns:
        ScoreResult with .total (0-100 int), .major_count, .minor_count,
        and .breakdown (one ScoreBreakdownItem per category in CATEGORY_ORDER).
    """
    major_count = 0
    minor_count = 0

    # Bucket violations by category
    by_category: Dict[str, Dict[str, int]] = {
        cat: {"major": 0, "minor": 0} for cat in CATEGORY_ORDER
    }
    by_category["uncategorised"] = {"major": 0, "minor": 0}

    for v in violations:
        cat = rule_code_to_category(v.rule_code, legacy_spacing=legacy_spacing)
        if cat not in by_category:
            cat = "uncategorised"
        if v.severity == "MAJOR":
            by_category[cat]["major"] += 1
            major_count += 1
        elif v.severity == "MINOR":
            by_category[cat]["minor"] += 1
            minor_count += 1
        # Unknown severities ignored (matches old behavior)

    # AI citation tips count as MINOR citation_apa violations
    if citation_tip_count > 0:
        by_category["citation_apa"]["minor"] += citation_tip_count
        minor_count += citation_tip_count

    # Per-category deduction with cap
    total = 100
    breakdown: List[ScoreBreakdownItem] = []

    for cat in CATEGORY_ORDER:
        meta = CATEGORY_META[cat]
        counts = by_category.get(cat, {"major": 0, "minor": 0})
        raw = counts["major"] * meta.major_weight + counts["minor"] * meta.minor_weight
        deduction = min(raw, meta.cap)
        total -= deduction
        breakdown.append(ScoreBreakdownItem(
            category=cat,
            label=meta.label,
            major=counts["major"],
            minor=counts["minor"],
            deduction=deduction,
            remaining=max(0, 100 - deduction),
        ))

    # Uncategorised bucket — included in total but not in breakdown array
    # (the frontend chart only shows the 7 known categories)
    if by_category["uncategorised"]["major"] or by_category["uncategorised"]["minor"]:
        counts = by_category["uncategorised"]
        raw = counts["major"] * _DEFAULT_CATEGORY.major_weight + counts["minor"] * _DEFAULT_CATEGORY.minor_weight
        deduction = min(raw, _DEFAULT_CATEGORY.cap)
        total -= deduction

    return ScoreResult(
        total=max(0, total),
        major_count=major_count,
        minor_count=minor_count,
        breakdown=breakdown,
    )


def calculate_weighted_score(violations: List[LayoutViolation]) -> int:
    """Backward-compat wrapper — returns just the integer total.

    Existing callers (routes.py, tests) keep working. New callers should
    use calculate_weighted_score_detailed() to get the breakdown too.
    """
    return calculate_weighted_score_detailed(violations).total


# ---------------------------------------------------------------------------
# Historical scoring-contract selection
# ---------------------------------------------------------------------------
#
# Completed historical audits may have been scored under the pre-fix
# spacing contract (SPACE_BEFORE / SPACE_AFTER fell into the hidden
# uncategorised bucket). Their stored `weighted_score` is immutable, so the
# GET / History / PDF surfaces must reconstruct a breakdown that explains
# the STORED score, not a freshly recomputed one.
#
# The selector scores the persisted findings under BOTH contracts and
# compares the two totals with the stored score:
#
#   if   stored == current:                      consistent, no adjustment
#   elif stored == legacy (and legacy != current):
#   -> confirmed legacy_spacing; the presentation-only adjustment row is
#      exactly current_total - legacy_total, verified to reconcile:
#      sum(visible current deductions) + adjustment == 100 - stored
#   else:                                        inconsistent — never labelled
#      legacy; stored score preserved, safe warning exposed.

# Reader-facing notes. Ordinary language only: no internal rule codes, no
# "uncategorised bucket", no implementation-version identifiers.
_CONSISTENT_NOTE = None
_LEGACY_SPACING_NOTE = (
    "This completed audit used an earlier spacing-scoring contract. "
    "Its original score is preserved, and the Legacy spacing adjustment "
    "explains the difference in the category breakdown."
)
_INCONSISTENT_NOTE = (
    "This completed audit's stored score cannot be fully reconstructed "
    "from its saved findings. The original score is preserved."
)


@dataclass(frozen=True)
class ScoringContractSelection:
    """Outcome of matching a completed audit's stored score against both
    scoring contracts.

    Attributes:
        status: "consistent" | "legacy_spacing" | "inconsistent".
        adjustment: presentation-only deduction for the
            "Legacy spacing adjustment" row; 0 unless status is
            legacy_spacing. Derived ONLY as current_total - legacy_total,
            never from per-category residuals.
        note: reader-facing explanation (None when consistent).
    """
    status: str
    adjustment: int = 0
    note: Optional[str] = None

    @property
    def legacy_row(self) -> Optional["ScoreBreakdownItem"]:
        """The presentation-only legacy row, or None."""
        if self.status != "legacy_spacing" or self.adjustment <= 0:
            return None
        return ScoreBreakdownItem(
            category=LEGACY_SPACING_CATEGORY,
            label=LEGACY_SPACING_LABEL,
            major=0,
            minor=0,
            deduction=self.adjustment,
            remaining=max(0, 100 - self.adjustment),
        )


def select_scoring_contract(
    stored_score: int,
    current_result: ScoreResult,
    legacy_result: ScoreResult,
) -> ScoringContractSelection:
    """Pick the scoring contract that produced a completed audit's stored
    score.

    Fixed precedence (the `stored == legacy == current` case resolves to
    `consistent` — no adjustment row is ever needed for it):

        1. stored == current total            -> consistent
        2. stored == legacy total             -> legacy_spacing, with the
           adjustment row derived from current_total - legacy_total
        3. otherwise                          -> inconsistent

    The adjustment is accepted only when it is positive AND the invariant
    `sum(current visible deductions) + adjustment == 100 - stored` holds;
    a broken invariant degrades to `inconsistent` instead of attaching a
    row that would mislabel the difference.

    NOTE: the invariant uses the base-100 deduction identity of the
    current scoring engine (total = 100 - capped visible deductions -
    hidden uncategorised deduction). Do not re-derive the base here — the
    two `ScoreResult` totals are the authoritative inputs and the 100 base
    comes from the same engine that produced both.
    """
    if stored_score == current_result.total:
        return ScoringContractSelection(status="consistent", note=_CONSISTENT_NOTE)

    if stored_score == legacy_result.total:
        adjustment = current_result.total - legacy_result.total
        visible = sum(b.deduction for b in current_result.breakdown)
        invariant_ok = adjustment > 0 and visible + adjustment == 100 - stored_score
        if invariant_ok:
            return ScoringContractSelection(
                status="legacy_spacing",
                adjustment=adjustment,
                note=_LEGACY_SPACING_NOTE,
            )
        # Confirmed legacy total but the presentation invariant broke —
        # never attach a row that would explain only part of the gap.
        return ScoringContractSelection(
            status="inconsistent", note=_INCONSISTENT_NOTE
        )

    return ScoringContractSelection(status="inconsistent", note=_INCONSISTENT_NOTE)


def grade_for(score: int) -> Dict[str, str]:
    """Human-readable grade band — used by both backend logging and frontend hero."""
    if score >= 90:
        return {"grade": "A", "label": "Excellent", "tone": "success"}
    if score >= 80:
        return {"grade": "B", "label": "Good", "tone": "success"}
    if score >= 70:
        return {"grade": "C", "label": "Acceptable", "tone": "warning"}
    if score >= 60:
        return {"grade": "D", "label": "Needs Work", "tone": "warning"}
    return {"grade": "F", "label": "Critical", "tone": "error"}
