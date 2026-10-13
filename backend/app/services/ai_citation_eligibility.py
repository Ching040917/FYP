"""Strict eligibility for Local AI Citation Guidance (paragraph-scoped only).

Local AI provides optional correction guidance for a single supported,
paragraph-scoped in-text citation finding. It never detects findings and
never sees Reference List text, whole-document text, or document-level
findings.

Eligible if and only if the violation is a ``CITATION_MISMATCH`` with a
real non-negative integer ``paragraph_index``, a ``MAJOR``/``MINOR``
severity, a non-empty citation snippet in ``actual_value``, and no
document-level or Reference-entry markers.

Pure helper: no model call, no database call, no side effects.
Consolidated findings (``occurrences > 1``) remain eligible as one
guidance unit keyed by the unique citation key; the bounded first
citation snippet stays the provider input.
"""
from typing import Any


def _field(violation: Any, name: str) -> Any:
    if isinstance(violation, dict):
        return violation.get(name)
    return getattr(violation, name, None)


def is_local_ai_citation_eligible(violation: Any) -> bool:
    """Return True only for paragraph-scoped CITATION_MISMATCH findings."""
    if violation is None:
        return False
    if _field(violation, "rule_code") != "CITATION_MISMATCH":
        return False
    location = _field(violation, "location")
    if not isinstance(location, dict):
        return False
    if location.get("missing_references_section") is True:
        return False
    # Reference-entry findings carry entry markers; citation findings never do.
    if "entry_count" in location:
        return False
    paragraph_index = location.get("paragraph_index")
    # type() is int (not isinstance) so bool True/False cannot pass.
    if type(paragraph_index) is not int or paragraph_index < 0:
        return False
    if _field(violation, "severity") not in ("MAJOR", "MINOR"):
        return False
    actual_value = _field(violation, "actual_value")
    if not isinstance(actual_value, str) or not actual_value.strip():
        return False
    return True
