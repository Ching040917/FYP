"""Weighted scoring engine — FR-4 implementation with per-category caps.

Each audit category has its own (major_weight, minor_weight, cap) tuple.
The cap prevents a single noisy category from zeroing-out the whole score:
a thesis with 8 margin errors (all Major) loses at most 32 points, not 120.

Returns BOTH the integer total AND a per-category breakdown so the frontend
no longer needs to re-derive scoring client-side (kills adapter.ts residual).
"""
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional

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
    "citation_apa":         CategoryMeta("APA Citations (AI)",   major_weight=5, minor_weight=2, cap=25),
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


def rule_code_to_category(rule_code: str) -> str:
    """Map a backend rule_code (e.g. 'MARGIN_LEFT') to a category key.

    Mirrors the frontend categoryForRuleCode() in adapter.ts so both
    sides agree on bucketing. Unknown codes fall through to the default
    bucket, which uses legacy flat weights — preserves test expectations.
    """
    code = (rule_code or "").upper()
    if "CITATION" in code or "APA" in code:
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
) -> ScoreResult:
    """Authoritative scoring — returns total + per-category breakdown.

    Args:
        violations: LayoutViolation list from the rules engine.
        citation_tip_count: Number of AI citation findings (treated as
            MINOR citation_apa violations). Pass 0 when cloud mode is off.

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
        cat = rule_code_to_category(v.rule_code)
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
