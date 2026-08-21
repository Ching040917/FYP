"""Presentation-safe custom profile validation (Build 2).

Validates and normalizes ONE custom Document Formatting Profile payload
without creating an Audit, writing a database row, changing the profile
registry, writing files, or retaining the submitted profile. Pure and
deterministic: no global state, no randomness, no timestamps, and no
global PresetConfig fallback.

Authoritative logic comes from the existing backend functions:
`profile_from_dict`, `resolve_snapshot`, and their schema ranges and
compatibility checks. Error fields are stable frontend identifiers (e.g.
`general.name`, `body.font_pairs`, `margins.left`) — never raw Python
paths. Messages are friendly English — never exception names, stack
traces, filesystem paths, fingerprint values, or registry internals.
"""
import copy
from typing import Any, Dict, List

from app.services.profile_registry import BUILTIN_PROFILES
from app.services.profile_schema import (
    ProfileValidationError,
    profile_from_dict,
)
from app.services.profile_snapshot import resolve_snapshot

# A profile payload may carry an explicit schema version; the current
# release supports exactly version 1. Absent is treated as version 1.
CUSTOM_PROFILE_SCHEMA_VERSION = 1

# The editor's enabled-margin product range. Disabled margins are null.
EDITOR_MARGIN_MIN_IN = 0.25
EDITOR_MARGIN_MAX_IN = 4.0

_MARGIN_FIELDS = (
    ("margin_left_in", "margins.left"),
    ("margin_right_in", "margins.right"),
    ("margin_top_in", "margins.top"),
    ("margin_bottom_in", "margins.bottom"),
)

# Bare group paths carry either a malformed-group error or a resolved-font
# compatibility error; the friendly identifier depends on the message.
_FONT_GROUP_FIELDS = {
    "body": "body.font_pairs",
    "heading": "headings.level_1.font",
}

# Raw schema field paths whose messages should use friendly font wording.
_FONT_FIELD_PATHS = {
    "body.font_family",
    "body.font_size_pt",
    "body.allowed_font_combos",
    "heading.font_family",
    "heading.font_size_pt",
    "heading.allowed_font_combos",
}

# Raw schema field path -> stable frontend field identifier.
_FIELD_MAP = {
    "profile_id": "general.id",
    "profile_name": "general.name",
    "profile_version": "general.version",
    "profile_source": "general.source",
    "description": "general.description",
    "citation_style": "general.citation_style",
    "body.font_family": "body.font_pairs",
    "body.font_size_pt": "body.font_pairs",
    "body.allowed_font_combos": "body.font_pairs",
    "body.line_spacing": "body.line_spacing",
    "body.alignment": "body.alignment",
    "body.space_before_pt": "body.space_before",
    "body.space_after_pt": "body.space_after",
    "body.first_line_indent_in": "body.first_line_indent",
    "heading.font_family": "headings.level_1.font",
    "heading.font_size_pt": "headings.level_1.font",
    "heading.allowed_font_combos": "headings.level_1.font",
    "heading.alignment": "headings.level_1.alignment",
    "heading.space_before_pt": "headings.level_1.space_before",
    "heading.space_after_pt": "headings.level_1.space_after",
    "margins.margin_left_in": "margins.left",
    "margins.margin_right_in": "margins.right",
    "margins.margin_top_in": "margins.top",
    "margins.margin_bottom_in": "margins.bottom",
    "references.line_spacing": "references.line_spacing",
    "references.hanging_indent_in": "references.hanging_indent",
    "captions.space_before_pt": "captions.space_before",
    "captions.space_after_pt": "captions.space_after",
    "lists.space_after_pt": "lists.space_after",
    "role_policy.table_eligibility": "role_policy.table_eligibility",
}


def validate_custom_profile(payload: Any) -> Dict[str, Any]:
    """Validate + normalize one custom profile payload.

    Returns `{"valid": true, "profile": <normalized>}` or
    `{"valid": false, "errors": [{"field", "message"}, ...]}`. Never
    raises for a JSON payload and never mutates the caller's object.
    """
    if not isinstance(payload, dict):
        return {
            "valid": False,
            "errors": [{"field": "general", "message": "The profile must be a JSON object."}],
        }

    data = copy.deepcopy(payload)

    if "schema_version" in data:
        if data["schema_version"] != CUSTOM_PROFILE_SCHEMA_VERSION:
            return {
                "valid": False,
                "errors": [{
                    "field": "general.version",
                    "message": "This profile uses an unsupported schema version.",
                }],
            }
        data.pop("schema_version")

    try:
        profile = profile_from_dict(data)
    except ProfileValidationError as exc:
        return {
            "valid": False,
            "errors": [_translate(path, message) for path, message in exc.errors],
        }

    errors = _editor_checks(profile)
    if not errors:
        try:
            resolve_snapshot(profile)
        except ProfileValidationError as exc:
            errors = [_translate(path, message) for path, message in exc.errors]

    if errors:
        return {"valid": False, "errors": errors}

    return {"valid": True, "profile": profile.to_dict()}


# ---------------------------------------------------------------------------
# Editor-level checks (beyond the authoritative schema)
# ---------------------------------------------------------------------------


def _editor_checks(profile: Any) -> List[Dict[str, str]]:
    errors: List[Dict[str, str]] = []

    if profile.profile_source == "built_in":
        errors.append({
            "field": "general.source",
            "message": "Custom profiles must not claim a built-in source.",
        })
    if profile.profile_id in BUILTIN_PROFILES:
        errors.append({
            "field": "general.id",
            "message": "Choose a profile ID that is not a reserved built-in ID.",
        })

    for attr, field in _MARGIN_FIELDS:
        value = getattr(profile.margins, attr)
        if value is not None and (value < EDITOR_MARGIN_MIN_IN or value > EDITOR_MARGIN_MAX_IN):
            errors.append({
                "field": field,
                "message": f"Enter a margin between {EDITOR_MARGIN_MIN_IN:g} and {EDITOR_MARGIN_MAX_IN:g} in.",
            })

    for group in ("body", "heading"):
        combos = tuple(getattr(profile, group).allowed_font_combos or ())
        seen = set()
        for combo in combos:
            if combo in seen:
                errors.append({
                    "field": _FONT_GROUP_FIELDS[group],
                    "message": "Each font and size may be listed only once.",
                })
                break
            seen.add(combo)

    if profile.heading.inherit_body_font:
        body = profile.body
        body_font_enabled = (
            body.font_family is not None
            or body.font_size_pt is not None
            or bool(body.allowed_font_combos)
        )
        if not body_font_enabled:
            errors.append({
                "field": "headings.level_1.font",
                "message": "Heading 1 cannot inherit the body font when no body font is enabled.",
            })

    return errors


# ---------------------------------------------------------------------------
# Friendly field identifiers + messages
# ---------------------------------------------------------------------------


def _translate(path: str, message: str) -> Dict[str, str]:
    if path in _FONT_GROUP_FIELDS:
        if "must be a JSON object" in message:
            return {"field": path, "message": "This section is not well formed."}
        return {"field": _FONT_GROUP_FIELDS[path], "message": _font_message(message)}
    if path in _FONT_FIELD_PATHS:
        return {"field": _FIELD_MAP.get(path, path), "message": _font_message(message)}
    field = _FIELD_MAP.get(path, path)
    return {"field": field, "message": _message_for(path, message)}


def _font_message(message: str) -> str:
    lower = message.lower()
    if "not in the allowed set" in lower:
        return "Choose a font and size from the accepted list."
    if "inherit_body_font" in lower:
        return "Choose either inheritance or an explicit heading font, not both."
    if "empty font" in lower:
        return "Enter a font name for every font and size pair."
    if "invalid combo" in lower:
        return "Enter each font and size as a name and a size."
    if "must be a number" in lower:
        return "Enter a numeric font size in points."
    if "must be between" in lower or "between" in lower:
        return "Enter a font size between 6 and 72 pt."
    if "must not be empty" in lower:
        return "Enter a font name."
    return "Select at least one accepted font and size."


def _message_for(path: str, message: str) -> str:
    lower = message.lower()

    if path.startswith("margins."):
        return f"Enter a margin between {EDITOR_MARGIN_MIN_IN:g} and {EDITOR_MARGIN_MAX_IN:g} in."

    if path == "citation_style":
        return "APA 7 is the only supported citation style."
    if path == "profile_source":
        return "Custom profiles must not claim a built-in source."
    if path == "profile_name":
        return "Enter a profile name."
    if path == "profile_id":
        return "Enter a profile ID."
    if path == "profile_version":
        return "Enter a supported profile version."
    if path == "role_policy.table_eligibility":
        return "Choose a valid table eligibility."
    if path in ("body.alignment", "heading.alignment"):
        return "Choose a valid alignment."

    if "unknown field" in lower:
        return "This field is not recognized."
    if "must be a boolean" in lower:
        return "Choose true or false."
    if "must be a number" in lower:
        return "Enter a numeric value."
    if "must be between" in lower or "between" in lower:
        if "line_spacing" in path:
            return "Enter line spacing between 1 and 4."
        if "hanging_indent" in path or "first_line_indent" in path:
            return "Enter an indent between 0 and 4 in."
        return "Enter a value within the supported range."
    if "must not be empty" in lower:
        return "Enter a value."
    if "invalid" in lower:
        return "Enter a valid value."

    return "Enter a valid value."
