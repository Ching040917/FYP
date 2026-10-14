"""Reference-order snapshot compatibility and toggle contracts.

The v4 wire shape remains frozen after v5 adds the independent DOI toggle.
Historical snapshots never acquire newer Reference fields.
"""

from dataclasses import replace
import pytest

from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    get_builtin_profile,
)
from app.services.profile_schema import (
    DocumentFormattingProfile,
    ProfileValidationError,
    ReferencesSettings,
    new_custom_profile,
    profile_from_dict,
)
from app.services.profile_snapshot import (
    SNAPSHOT_SCHEMA_VERSION,
    SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
    EffectiveProfileSnapshot,
    resolve_snapshot,
    snapshot_from_dict,
)


def _custom(order: bool) -> DocumentFormattingProfile:
    profile = new_custom_profile(
        "Snapshot Order", base=get_builtin_profile(SUC_PROFILE_ID),
    )
    profile.references.check_reference_order = order
    return profile


# --- schema -----------------------------------------------------------------


def test_toggle_defaults_off_and_validates_as_bool():
    assert ReferencesSettings().check_reference_order is False
    profile = new_custom_profile("T", base=get_builtin_profile(SUC_PROFILE_ID))
    profile.references.check_reference_order = "yes"  # type: ignore[assignment]
    errors = dict(profile.validate())
    assert "references.check_reference_order" in errors


def test_builtin_profiles_keep_the_toggle_off():
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        assert get_builtin_profile(pid).references.check_reference_order is False


def test_profile_dict_round_trip_carries_the_toggle():
    profile = _custom(True)
    rebuilt = profile_from_dict(profile.to_dict())
    assert rebuilt.references.check_reference_order is True
    assert profile_from_dict(_custom(False).to_dict()).references.check_reference_order is False


# --- versions frozen --------------------------------------------------------


def test_current_version_is_5_and_supported_versions_extend():
    assert SNAPSHOT_SCHEMA_VERSION == 5
    assert tuple(SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS) == (1, 2, 3, 4, 5)


def test_v1_and_v2_groups_stay_two_keys():
    for version in (1, 2):
        snap = EffectiveProfileSnapshot(
            schema_version=version,
            references_line_spacing=2.0,
            references_hanging_indent_in=0.5,
            references_check_hanging_indent=True,
            references_check_reference_order=True,
        )
        assert snap.to_dict()["references"] == {
            "line_spacing": 2.0, "hanging_indent_in": 0.5,
        }, version


def test_v3_group_has_no_order_key():
    snap = resolve_snapshot(_custom(True))
    assert snap.schema_version == 5
    as_v3 = EffectiveProfileSnapshot(
        **{**snap.__dict__, "schema_version": 3, "fingerprint": ""},
    ).with_fingerprint()
    assert "check_reference_order" not in as_v3.to_dict()["references"]


def test_v3_payload_with_order_key_is_rejected():
    snap = EffectiveProfileSnapshot(schema_version=3).with_fingerprint().to_dict()
    snap["references"]["check_reference_order"] = False
    probe = dict(snap)
    # Re-fingerprint as v3 is impossible with the extra key: load must fail.
    with pytest.raises(ProfileValidationError):
        snapshot_from_dict(probe)


# --- v4 behaviour -----------------------------------------------------------


def test_v4_false_and_true_round_trip():
    for order in (False, True):
        snap = replace(resolve_snapshot(_custom(order)), schema_version=4, fingerprint="").with_fingerprint()
        assert snap.schema_version == 4
        assert snap.references_check_reference_order is order
        rebuilt = snapshot_from_dict(snap.to_dict())
        assert rebuilt.references_check_reference_order is order
        assert rebuilt.verify_fingerprint()


def test_v4_fingerprints_deterministic_and_toggle_sensitive():
    profile = _custom(True)
    first = resolve_snapshot(profile)
    second = resolve_snapshot(profile)
    assert first.fingerprint == second.fingerprint
    assert first.fingerprint
    profile.references.check_reference_order = False
    assert resolve_snapshot(profile).fingerprint != first.fingerprint


def test_older_snapshots_treat_the_missing_toggle_as_false():
    snap = resolve_snapshot(_custom(False))
    # Serialize a real v3 shape rather than mutating a current-version payload.
    trimmed = EffectiveProfileSnapshot(
        **{**snap.__dict__, "schema_version": 3, "fingerprint": ""},
    ).with_fingerprint()
    rebuilt = snapshot_from_dict(trimmed.to_dict())
    assert rebuilt.schema_version == 3
    assert rebuilt.references_check_reference_order is False


def test_v4_snapshot_has_order_but_no_later_reference_fields():
    snap = replace(resolve_snapshot(_custom(True)), schema_version=4, fingerprint="").with_fingerprint()
    payload = snap.to_dict()
    assert payload["references"]["check_reference_order"] is True
    assert "check_doi_format" not in payload["references"]
    assert "url" not in repr(payload).lower()
