from typing import List
from app.services.layout_engine import LayoutViolation


MAJOR_WEIGHT = 15
MINOR_WEIGHT = 3
BASE_SCORE = 100


def calculate_weighted_score(violations: List[LayoutViolation]) -> int:
    """Compute layout compliance score based on weighted error categories.

    Major violations (margins, heading hierarchy): -15 each
    Minor violations (font, spacing, captions): -3 each
    Floor at 0.
    """
    score = BASE_SCORE
    for v in violations:
        if v.severity == "MAJOR":
            score -= MAJOR_WEIGHT
        elif v.severity == "MINOR":
            score -= MINOR_WEIGHT
    return max(score, 0)