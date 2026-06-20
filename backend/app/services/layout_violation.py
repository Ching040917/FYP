"""
Shared violation type used by both static layout checks and the
regex-based citation sensor. Kept in its own module to break the
layout_engine <-> citation_sensor import cycle.
"""
from typing import Optional, Dict, Any


class LayoutViolation:
    def __init__(
        self,
        rule_code: str,
        severity: str,
        location: Dict[str, Any],
        message: str,
        expected_value: Optional[str] = None,
        actual_value: Optional[str] = None,
    ):
        self.rule_code = rule_code
        self.severity = severity  # "MAJOR" or "MINOR"
        self.location = location
        self.message = message
        self.expected_value = expected_value
        self.actual_value = actual_value

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rule_code": self.rule_code,
            "severity": self.severity,
            "location": self.location,
            "message": self.message,
            "expected_value": self.expected_value,
            "actual_value": self.actual_value,
        }
