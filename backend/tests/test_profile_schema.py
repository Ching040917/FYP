"""Document Formatting Profile — Phase 1 PoC tests (schema + validation).

Owner-approved Phase 1 scope: profile model, validation, deterministic
serialization, built-in registry. NO rules, scoring, findings, APIs,
database, migrations, or historical audits are touched.

Covers:
  - APA does NOT require only Times New Roman 12 pt (allowed combos);
  - APA headings do NOT use fixed descending 16/14/12 pt sizes;
  - 1 in vs 1.5 in profiles remain distinct;
  - invalid units and ranges are rejected with field paths;
  - unknown fields and malformed snapshots are rejected safely;
  - nullable requirements mean "no deterministic requirement";
  - inheritance (heading inherits body font) is supported;
  - schema serialization is deterministic;
  - built-in registry integrity (both profiles valid, distinct).
"""
import json

import pytest

from app.services.profile_schema import (
    APA_ALLOWED_FONT_COMBOS,
    BodySettings,
    DocumentFormattingProfile,
    HeadingSettings,
    MarginSettings,
    ProfileValidationError,
    new_custom_profile,
    profile_from_dict,
)
from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    BUILTIN_PROFILES,
    get_builtin_profile,
    list_builtin_profiles,
    RECOMMENDED_PROFILE_ID,
)


# ---------------------------------------------------------------------------
# APA correctness (owner decisions 5, 10)
# ---------------------------------------------------------------------------

def test_apa_allows_multiple_font_combinations_not_only_tnr_12():
    """APA 7 accepts several font/size combos — the schema must express an
    allowed set, never force Times New Roman 12 pt."""
    apa = get_builtin_profile(APA_PROFILE_ID)
    assert apa.body.allowed_font_combos is not None
    assert len(apa.body.allowed_font_combos) >= 5
    # TNR 12 is allowed but is NOT the only option.
    assert ("Times New Roman", 12.0) in apa.body.allowed_font_combos
    assert any(f != "Times New Roman" for f, _ in apa.body.allowed_font_combos)
    # A profile with only TNR 12 as an exact value is NOT the APA profile.
    assert apa.body.font_family is None
    assert apa.body.font_size_pt is None


def test_apa_headings_inherit_body_font_not_fixed_sizes():
    """APA headings inherit the body font and differ by bold/italic/
    alignment — NOT fixed descending 16/14/12 pt sizes."""
    apa = get_builtin_profile(APA_PROFILE_ID)
    assert apa.heading.inherit_body_font is True
    assert apa.heading.font_size_pt is None  # no fixed heading size
    # Levels carry APA style rules instead of sizes.
    assert apa.heading.level_1 == {"bold": True, "italic": False, "alignment": "center"}
    assert apa.heading.level_2 == {"bold": True, "italic": False, "alignment": "left"}
    assert apa.heading.level_3 == {"bold": True, "italic": True, "alignment": "left"}
    # And the SUC profile's fixed sizes are NOT used by APA.
    assert apa.heading.font_size_pt != 16.0


def test_suc_keeps_institution_specific_values_but_labels_them():
    """SUC values are institution-specific and labelled as such — never
    presented as universal. Margins are NOT enforced (null) unless a course
    or document template specifies them."""
    suc = get_builtin_profile(SUC_PROFILE_ID)
    assert suc.margins.margin_left_in is None
    assert suc.margins.margin_right_in is None
    assert suc.margins.margin_top_in is None
    assert suc.margins.margin_bottom_in is None
    assert suc.profile_version == 2
    assert suc.body.font_size_pt == 12.0
    assert suc.body.line_spacing == 1.5
    assert "institution" in suc.description.lower()
    assert "Margins" in suc.description
    assert suc.profile_source == "built_in"
    assert RECOMMENDED_PROFILE_ID == SUC_PROFILE_ID


def test_one_inch_and_one_point_five_inch_profiles_distinct():
    """APA has explicit 1 in margins; SUC has none (not checked). Distinct
    profiles."""
    apa = get_builtin_profile(APA_PROFILE_ID)
    suc = get_builtin_profile(SUC_PROFILE_ID)
    assert apa.margins.margin_left_in == 1.0
    assert suc.margins.margin_left_in is None
    assert apa.profile_id != suc.profile_id


# ---------------------------------------------------------------------------
# Validation — units, ranges, field paths
# ---------------------------------------------------------------------------

def test_invalid_font_size_rejected_with_field_path():
    p = get_builtin_profile(APA_PROFILE_ID)
    # Rebuild via profile_from_dict to get a fresh object, then break a field.
    d = p.to_dict()
    d["body"]["font_size_pt"] = 999.0
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "body.font_size_pt" in paths


def test_invalid_margin_rejected_with_field_path():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["margins"]["margin_left_in"] = -1
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "margins.margin_left_in" in paths


def test_invalid_line_spacing_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["references"]["line_spacing"] = 9.0
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "references.line_spacing" in paths


def test_invalid_alignment_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["body"]["alignment"] = "diagonal"
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "body.alignment" in paths


def test_invalid_units_string_rejected():
    """A bare string where a numeric pt/in value is required is rejected."""
    d = get_builtin_profile(SUC_PROFILE_ID).to_dict()
    d["body"]["space_after_pt"] = "6pt"  # must be numeric with explicit unit
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "body.space_after_pt" in paths


def test_bool_not_accepted_as_number():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["body"]["line_spacing"] = True
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    assert any(path == "body.line_spacing" for path, _ in exc.value.errors)


def test_unknown_field_rejected_safely():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["mystery_field"] = "x"
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    paths = {path for path, _ in exc.value.errors}
    assert "mystery_field" in paths


def test_malformed_snapshot_rejected_safely():
    """Non-dict payloads and malformed groups are rejected, not silently
    accepted."""
    with pytest.raises(ProfileValidationError):
        profile_from_dict("not-a-dict")
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["body"] = "garbage"
    with pytest.raises(ProfileValidationError):
        profile_from_dict(d)
    d2 = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d2["body"]["unknown_body_field"] = 1
    with pytest.raises(ProfileValidationError):
        profile_from_dict(d2)


def test_unsupported_citation_style_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["citation_style"] = "Chicago 17"
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    assert any(path == "citation_style" for path, _ in exc.value.errors)


def test_nullable_requirements_mean_no_deterministic_requirement():
    """None values are valid and mean 'skip the check' — never ambiguous
    with 0 or missing."""
    p = get_builtin_profile(APA_PROFILE_ID)
    # Both profiles keep caption/list spacing nullable by default.
    assert p.captions.space_before_pt is None
    assert p.captions.space_after_pt is None
    assert p.lists.space_after_pt is None
    assert p.validate() == []


# ---------------------------------------------------------------------------
# Inheritance / role policy
# ---------------------------------------------------------------------------

def test_heading_inheritance_conflict_rejected():
    """inherit_body_font must not coexist with explicit heading font."""
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["heading"]["inherit_body_font"] = True
    d["heading"]["font_size_pt"] = 16.0
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    assert any(path == "heading" for path, _ in exc.value.errors)


def test_role_exemptions_roundtrip():
    d = get_builtin_profile(SUC_PROFILE_ID).to_dict()
    p = profile_from_dict(d)
    assert p.role_policy.exempt_roles == get_builtin_profile(SUC_PROFILE_ID).role_policy.exempt_roles
    assert "COVER" in p.role_policy.exempt_roles
    assert p.role_policy.table_eligibility in ("administrative", "scholarly", "both")


def test_invalid_role_policy_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["role_policy"]["table_eligibility"] = "weird"
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    assert any(path == "role_policy.table_eligibility" for path, _ in exc.value.errors)


# ---------------------------------------------------------------------------
# Deterministic serialization
# ---------------------------------------------------------------------------

def test_serialization_deterministic():
    """to_dict() is byte-stable across calls and JSON round-trips."""
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        p = get_builtin_profile(pid)
        a = json.dumps(p.to_dict(), sort_keys=True)
        b = json.dumps(p.to_dict(), sort_keys=True)
        assert a == b
        # Ordered layout is stable too.
        assert list(p.to_dict().keys()) == list(p.to_dict().keys())


def test_roundtrip_preserves_profile():
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        p = get_builtin_profile(pid)
        restored = profile_from_dict(p.to_dict())
        assert restored.profile_id == p.profile_id
        assert restored.profile_version == p.profile_version
        assert restored.profile_source == p.profile_source
        assert restored.citation_style == "APA 7"
        assert restored.to_dict() == p.to_dict()


def test_exempt_roles_serialized_as_sorted_list():
    """Sets serialize deterministically as sorted lists (byte-stable)."""
    p = get_builtin_profile(SUC_PROFILE_ID)
    d = p.to_dict()
    roles = d["role_policy"]["exempt_roles"]
    assert isinstance(roles, list)
    assert roles == sorted(roles)
    # Round-trip back to a set preserves identity.
    restored = profile_from_dict(d)
    assert restored.role_policy.exempt_roles == p.role_policy.exempt_roles


# ---------------------------------------------------------------------------
# Custom profiles
# ---------------------------------------------------------------------------

def test_new_custom_profile_from_blank_has_no_requirements():
    """A blank custom template has every deterministic requirement None —
    the user must supply explicit values before each check is enabled."""
    p = new_custom_profile("My Blank Profile")
    assert p.profile_source == "custom"
    assert p.profile_version == 1
    assert p.body.font_family is None
    assert p.body.font_size_pt is None
    assert p.margins.margin_left_in is None
    assert p.validate() == []


def test_new_custom_profile_from_builtin_copies_requirements():
    p = new_custom_profile("My APA Copy", base=get_builtin_profile(APA_PROFILE_ID))
    assert p.profile_id != APA_PROFILE_ID
    assert p.profile_source == "custom"
    assert p.body.allowed_font_combos == APA_ALLOWED_FONT_COMBOS
    assert p.margins.margin_left_in == 1.0
    assert p.citation_style == "APA 7"
    assert p.validate() == []


# ---------------------------------------------------------------------------
# Registry integrity
# ---------------------------------------------------------------------------

def test_all_builtin_profiles_valid_and_distinct():
    profiles = list_builtin_profiles()
    assert set(profiles) == {SUC_PROFILE_ID, APA_PROFILE_ID}
    ids = set()
    for pid, p in profiles.items():
        assert p.validate() == [], f"{pid} failed validation: {p.validate()}"
        assert p.profile_source == "built_in"
        assert p.citation_style == "APA 7"
        ids.add(p.profile_id)
    assert len(ids) == 2


def test_builtin_registry_immutable_identity():
    with pytest.raises(KeyError):
        get_builtin_profile("does-not-exist")


# ---------------------------------------------------------------------------
# Citation ↔ Reference List matching controls
# ---------------------------------------------------------------------------

_CITATION_DEFAULTS = {
    "check_citations_have_references": True,
    "check_references_are_cited": False,
    "check_author_year_consistency": True,
    "check_year_suffixes": True,
    "check_duplicate_references": True,
    "flag_ambiguous_matches": True,
    "allow_personal_communication": True,
}


def test_citation_matching_defaults_on_blank_custom_profile():
    p = new_custom_profile("Blank Controls")
    cm = p.citation_matching
    for name, expected in _CITATION_DEFAULTS.items():
        assert getattr(cm, name) is expected, name
    assert p.to_dict()["citation_matching"] == _CITATION_DEFAULTS


def test_both_builtins_expose_the_documented_citation_toggles():
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        cm = get_builtin_profile(pid).citation_matching
        for name, expected in _CITATION_DEFAULTS.items():
            assert getattr(cm, name) is expected, (pid, name)


def test_citation_matching_rejects_non_boolean_with_field_path():
    p = new_custom_profile("Bad Toggle")
    p.citation_matching.check_year_suffixes = "yes"
    assert ("citation_matching.check_year_suffixes", "must be true or false") in p.validate()
    with pytest.raises(ProfileValidationError) as exc:
        p.validate_or_raise()
    assert any(path.startswith("citation_matching.") for path, _ in exc.value.errors)


def test_citation_matching_round_trips_through_canonical_dict():
    p = new_custom_profile("Toggles", base=get_builtin_profile(APA_PROFILE_ID))
    p.citation_matching.check_references_are_cited = True
    p.citation_matching.check_year_suffixes = False
    d = p.to_dict()
    keys = list(d)
    # Canonical order: the group sits after role_policy, before the timestamps.
    assert keys.index("role_policy") < keys.index("citation_matching") < keys.index("created_at")
    assert d["citation_matching"]["check_references_are_cited"] is True
    assert d["citation_matching"]["check_year_suffixes"] is False
    restored = profile_from_dict(json.loads(json.dumps(d)))
    assert restored.citation_matching == p.citation_matching


def test_unknown_citation_matching_field_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["citation_matching"]["mystery_toggle"] = True
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(d)
    assert any(path == "citation_matching.mystery_toggle" for path, _ in exc.value.errors)


def test_missing_citation_matching_group_falls_back_to_defaults():
    """Historical payloads (pre-group) stay loadable; missing key = default."""
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d.pop("citation_matching")
    restored = profile_from_dict(d)
    assert restored.citation_matching == type(restored.citation_matching)()
    assert restored.to_dict()["citation_matching"] == _CITATION_DEFAULTS


def test_new_custom_profile_copy_carries_citation_toggles():
    """new_custom_profile enumerates every group by hand — a forgotten copy
    would silently drop the user's toggles."""
    base = get_builtin_profile(APA_PROFILE_ID)
    base.citation_matching.check_references_are_cited = True
    base.citation_matching.allow_personal_communication = False
    copy = new_custom_profile("Copied Controls", base=base)
    assert copy.citation_matching.check_references_are_cited is True
    assert copy.citation_matching.allow_personal_communication is False
    assert copy.citation_matching is not base.citation_matching


@pytest.mark.parametrize("value", [None, "true", "false", 0, 1, 0.0, 1.0, [], {}])
def test_reference_doi_toggle_requires_a_strict_boolean(value):
    profile = new_custom_profile("DOI strict profile")
    profile.references.check_doi_format = value
    assert ("references.check_doi_format", "must be true or false") in profile.validate()
    with pytest.raises(ProfileValidationError) as exc:
        profile_from_dict(profile.to_dict())
    assert ("references.check_doi_format", "must be true or false") in exc.value.errors


def test_reference_doi_toggle_missing_defaults_off_and_builtins_remain_off():
    for profile_id in (SUC_PROFILE_ID, APA_PROFILE_ID):
        original = get_builtin_profile(profile_id)
        assert original.references.check_doi_format is False
        payload = original.to_dict()
        del payload["references"]["check_doi_format"]
        assert profile_from_dict(payload).references.check_doi_format is False
        copy = new_custom_profile("DOI copy", base=original)
        copy.references.check_doi_format = True
        assert get_builtin_profile(profile_id).references.check_doi_format is False


@pytest.mark.parametrize("enabled", [False, True])
def test_reference_doi_toggle_survives_profile_json_and_independent_copy(enabled):
    profile = new_custom_profile("DOI round trip")
    profile.references.check_doi_format = enabled
    restored = profile_from_dict(json.loads(json.dumps(profile.to_dict())))
    assert restored.references.check_doi_format is enabled
    copy = new_custom_profile("DOI copied", base=restored)
    assert copy.references.check_doi_format is enabled
    assert copy.references is not restored.references
    reference_keys = profile.to_dict()["references"]
    assert {key for key in reference_keys if "doi" in key} == {"check_doi_format"}
    assert not any("url" in key for key in reference_keys)
