"""Profile resolution for audit creation (Build 3).

Resolves an optional request profile (built-in id or custom payload) into
the immutable EffectiveProfileSnapshot persisted with the Audit.

Resolution rules:
  1. Missing profile input (transitional compatibility): resolve the
     recommended SUC built-in profile.
  2. Unknown built-in id: ProfileResolveError → API maps to friendly 400.
  3. Malformed custom profile: ProfileResolveError carrying safe field-path
     messages → API maps to friendly 400.
  4. Resolution happens BEFORE deterministic processing begins.
  5. The complete immutable snapshot (identity, version, source, citation
     style, effective requirements, eligibility policies, fingerprint) is
     persisted — never a mutable registry reference.

Immutability: the returned snapshot is frozen; later edits/deletion of the
source custom profile or registry updates never affect it. GET returns
stored data, never a re-resolution.
"""
from typing import Any, Dict, Optional

from app.services.profile_registry import (
    get_builtin_profile,
    RECOMMENDED_PROFILE_ID,
)
from app.services.profile_schema import (
    ProfileValidationError,
    profile_from_dict,
)
from app.services.profile_snapshot import (
    EffectiveProfileSnapshot,
    resolve_snapshot,
    snapshot_from_dict,
)


class ProfileResolveError(ValueError):
    """A profile could not be resolved. `errors` = (field_path, message)
    pairs safe to surface to the user; never stack traces."""

    def __init__(self, errors, message: str = "Invalid formatting profile"):
        self.errors = list(errors)
        super().__init__(message)


def resolve_request_profile(
    profile_id: Optional[str] = None,
    custom_profile: Optional[Dict[str, Any]] = None,
) -> EffectiveProfileSnapshot:
    """Resolve the request profile into an immutable snapshot.

    - `profile_id` only → built-in (unknown id → ProfileResolveError).
    - `custom_profile` only → validated custom profile payload.
    - both → ProfileResolveError (ambiguous).
    - neither → recommended SUC built-in (transitional compatibility).
    """
    if profile_id and custom_profile:
        raise ProfileResolveError(
            [("profile", "provide either profile_id or custom_profile, not both")]
        )
    if custom_profile:
        return _resolve_custom(custom_profile)
    if profile_id:
        return _resolve_builtin(profile_id)
    return _resolve_builtin(RECOMMENDED_PROFILE_ID)


def _resolve_builtin(profile_id: str) -> EffectiveProfileSnapshot:
    try:
        profile = get_builtin_profile(profile_id)
    except KeyError:
        raise ProfileResolveError(
            [("profile_id", f"unknown profile '{profile_id}'")]
        )
    return resolve_snapshot(profile)


def _resolve_custom(payload: Dict[str, Any]) -> EffectiveProfileSnapshot:
    try:
        profile = profile_from_dict(payload)
    except ProfileValidationError as exc:
        raise ProfileResolveError(exc.errors)
    return resolve_snapshot(profile)


def restore_snapshot(stored: Any) -> Optional[EffectiveProfileSnapshot]:
    """Restore a persisted snapshot dict defensively.

    Returns the immutable snapshot when valid; None for historical (null) or
    corrupt data. Never raises — corrupt stored snapshots must not crash
    History or export, and are reported as legacy/corrupt without re-scoring.
    """
    if stored is None:
        return None
    if not isinstance(stored, dict):
        return None
    try:
        return snapshot_from_dict(stored)
    except (ProfileValidationError, ValueError, TypeError):
        return None
