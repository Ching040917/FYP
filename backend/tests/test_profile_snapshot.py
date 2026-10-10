"""Effective Profile Snapshot resolution — Build 2 tests.

Covers: SUC/APA resolution, APA allowed font selections (valid + invalid),
heading inheritance, nullable preservation, sorted role exemptions, built-in
immutability, registry uniqueness, unknown profile ID, custom profile
isolation after source mutation, deterministic canonical serialization,
stable + sensitive fingerprint, unsupported schema version, malformed input,
no PresetConfig fallback, no document content in snapshots, adapter purity.
"""
import json
from pathlib import Path

import pytest

from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    BUILTIN_PROFILES,
    get_builtin_profile,
    list_builtin_profiles,
    RECOMMENDED_PROFILE_ID,
)
from app.services.profile_schema import (
    APA_ALLOWED_FONT_COMBOS,
    DocumentFormattingProfile,
    ProfileValidationError,
    new_custom_profile,
)
from app.services.profile_snapshot import (
    SNAPSHOT_SCHEMA_VERSION,
    EffectiveProfileSnapshot,
    resolve_snapshot,
    snapshot_from_dict,
)
from app.services.profile_preset_adapter import snapshot_to_preset_view


# ---------------------------------------------------------------------------
# SUC / APA resolution
# ---------------------------------------------------------------------------

def test_suc_snapshot_resolution():
    snap = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID))
    assert snap.profile_id == SUC_PROFILE_ID
    assert snap.schema_version == SNAPSHOT_SCHEMA_VERSION
    assert snap.profile_version == 2
    assert snap.margin_left_in is None
    assert snap.margin_right_in is None
    assert snap.margin_top_in is None
    assert snap.margin_bottom_in is None
    assert snap.body_font_size_pt == 12.0
    assert snap.body_line_spacing == 1.5
    assert snap.references_line_spacing == 2.0
    # SUC is institution-specific, never universal APA.
    assert snap.institution_specific is True
    assert snap.fingerprint


def test_apa_snapshot_resolution():
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    assert snap.profile_id == APA_PROFILE_ID
    assert snap.margin_left_in == 1.0
    assert snap.body_line_spacing == 2.0
    assert snap.body_alignment == "left"
    assert snap.body_first_line_indent_in == 0.5
    assert snap.references_hanging_indent_in == 0.5
    assert snap.institution_specific is False
    # Allowed combos preserved as pairs — never split font from size.
    assert snap.body_allowed_font_combos == APA_ALLOWED_FONT_COMBOS


def test_apa_body_allowed_combos_preserved_not_split():
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    for family, size in snap.body_allowed_font_combos:
        assert isinstance(family, str) and family
        assert isinstance(size, (int, float))


# ---------------------------------------------------------------------------
# APA font selection
# ---------------------------------------------------------------------------

def _apa_with_selection(family, size):
    """Return an APA profile with an explicit body font selection."""
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["body"]["font_family"] = family
    d["body"]["font_size_pt"] = size
    from app.services.profile_schema import profile_from_dict
    return profile_from_dict(d)


def test_valid_apa_body_font_selection():
    snap = resolve_snapshot(_apa_with_selection("Calibri", 11.0))
    assert snap.body_font_family == "Calibri"
    assert snap.body_font_size_pt == 11.0
    assert snap.body_allowed_font_combos == APA_ALLOWED_FONT_COMBOS


def test_invalid_apa_font_size_pair_rejected():
    """A selected (font, size) outside the allowed set is rejected."""
    with pytest.raises(ProfileValidationError) as exc:
        resolve_snapshot(_apa_with_selection("Times New Roman", 14.0))
    assert any(path == "body" for path, _ in exc.value.errors)


def test_invalid_apa_font_family_rejected():
    with pytest.raises(ProfileValidationError):
        resolve_snapshot(_apa_with_selection("Comic Sans", 12.0))


def test_apa_heading_inherits_selected_body_combination():
    """Inherited heading font uses the selected valid body combination —
    same family+size, no fixed descending heading sizes."""
    snap = resolve_snapshot(_apa_with_selection("Arial", 11.0))
    assert snap.heading_font_family == "Arial"
    assert snap.heading_font_size_pt == 11.0
    assert snap.heading_allowed_font_combos == ()


def test_apa_heading_inherits_allowed_set_when_no_selection():
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    assert snap.heading_font_family is None
    assert snap.heading_font_size_pt is None
    assert snap.heading_allowed_font_combos == APA_ALLOWED_FONT_COMBOS


def test_heading_inheritance_conflict_rejected():
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["heading"]["inherit_body_font"] = True
    d["heading"]["font_size_pt"] = 16.0
    from app.services.profile_schema import profile_from_dict
    with pytest.raises(ProfileValidationError) as exc:
        resolve_snapshot(profile_from_dict(d))
    assert any(path == "heading" for path, _ in exc.value.errors)


# ---------------------------------------------------------------------------
# Nullables / exemptions / immutability
# ---------------------------------------------------------------------------

def test_nullable_requirements_preserved_null():
    snap = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID))
    assert snap.caption_space_before_pt is None
    assert snap.caption_space_after_pt is None
    assert snap.list_space_after_pt is None
    assert snap.body_first_line_indent_in is None


def test_role_exemptions_sorted():
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        snap = resolve_snapshot(get_builtin_profile(pid))
        assert snap.role_exemptions == tuple(sorted(snap.role_exemptions))
        assert "COVER" in snap.role_exemptions


def test_builtin_registry_immutable():
    """Callers get immutable snapshots, not mutable registry objects."""
    p1 = get_builtin_profile(SUC_PROFILE_ID)
    p2 = get_builtin_profile(SUC_PROFILE_ID)
    # Mutating a returned profile must not affect the registry.
    p1.body.font_family = "Comic Sans"
    p3 = get_builtin_profile(SUC_PROFILE_ID)
    assert p3.body.font_family == "Times New Roman"
    assert p2.body.font_family == "Times New Roman"


def test_registry_uniqueness():
    profiles = list_builtin_profiles()
    ids = [p.profile_id for p in profiles.values()]
    assert len(ids) == len(set(ids))
    assert len(profiles) == 2


def test_unknown_profile_id_controlled_error():
    with pytest.raises(KeyError):
        get_builtin_profile("nope")


# ---------------------------------------------------------------------------
# Custom profile isolation
# ---------------------------------------------------------------------------

def test_custom_profile_snapshot_isolated_from_source_mutation():
    """Editing the source profile after resolution must not alter the
    snapshot (immutable, resolved once)."""
    custom = new_custom_profile("My Copy", base=get_builtin_profile(APA_PROFILE_ID))
    snap = resolve_snapshot(custom)
    original_margin = snap.margin_left_in
    original_fp = snap.fingerprint

    # Mutate the source profile heavily.
    custom.margins.margin_left_in = 3.0
    custom.body.font_family = "Comic Sans"
    custom.body.font_size_pt = 20.0

    assert snap.margin_left_in == original_margin
    assert snap.fingerprint == original_fp
    assert snap.verify_fingerprint()


def test_custom_profile_deletion_does_not_affect_snapshot():
    """Deleting the source profile must not affect an existing snapshot —
    the snapshot is self-contained."""
    custom = new_custom_profile("Ephemeral", base=get_builtin_profile(SUC_PROFILE_ID))
    snap = resolve_snapshot(custom)
    fp = snap.fingerprint
    # 'Delete' the source: the snapshot still round-trips and verifies.
    restored = snapshot_from_dict(snap.to_dict())
    assert restored.fingerprint == fp
    assert restored.profile_id == custom.profile_id


def test_custom_profile_timestamps_not_in_snapshot():
    """Custom identity (id/name/source) is preserved, but timestamps are
    transient and must NOT enter the snapshot/fingerprint."""
    custom = new_custom_profile("Timestamped")
    snap = resolve_snapshot(custom)
    d = snap.to_dict()
    assert "created_at" not in d
    assert "updated_at" not in d
    assert snap.profile_source == "custom"


# ---------------------------------------------------------------------------
# Canonical serialization + fingerprint
# ---------------------------------------------------------------------------

def test_canonical_serialization_deterministic():
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        snap = resolve_snapshot(get_builtin_profile(pid))
        a = snap.canonical_bytes()
        b = snap.canonical_bytes()
        assert a == b
        assert json.dumps(snap.to_dict(), sort_keys=True) == json.dumps(snap.to_dict(), sort_keys=True)


def test_equivalent_snapshots_identical_fingerprint():
    a = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    b = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    assert a.fingerprint == b.fingerprint


def test_fingerprint_changes_on_margin_change():
    apa = get_builtin_profile(APA_PROFILE_ID)
    base = resolve_snapshot(apa).fingerprint
    d = apa.to_dict()
    d["margins"]["margin_left_in"] = 1.25
    from app.services.profile_schema import profile_from_dict
    changed = resolve_snapshot(profile_from_dict(d)).fingerprint
    assert changed != base


def test_fingerprint_changes_on_font_change():
    base = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID)).fingerprint
    changed = resolve_snapshot(_apa_with_selection("Georgia", 11.0)).fingerprint
    assert changed != base


def test_fingerprint_changes_on_spacing_change():
    apa = get_builtin_profile(APA_PROFILE_ID)
    base = resolve_snapshot(apa).fingerprint
    d = apa.to_dict()
    d["references"]["line_spacing"] = 1.5
    from app.services.profile_schema import profile_from_dict
    changed = resolve_snapshot(profile_from_dict(d)).fingerprint
    assert changed != base


def test_fingerprint_changes_on_eligibility_change():
    apa = get_builtin_profile(APA_PROFILE_ID)
    base = resolve_snapshot(apa).fingerprint
    d = apa.to_dict()
    d["role_policy"]["exempt_roles"] = ["COVER"]
    from app.services.profile_schema import profile_from_dict
    changed = resolve_snapshot(profile_from_dict(d)).fingerprint
    assert changed != base


def test_fingerprint_excludes_timestamps():
    """Equivalent profiles with different timestamps → same fingerprint."""
    from app.services.profile_schema import DocumentFormattingProfile, BodySettings
    a = DocumentFormattingProfile(profile_id="x", profile_name="X", created_at="t1")
    b = DocumentFormattingProfile(profile_id="x", profile_name="X", created_at="t2")
    assert resolve_snapshot(a).fingerprint == resolve_snapshot(b).fingerprint


# ---------------------------------------------------------------------------
# Validation / compatibility
# ---------------------------------------------------------------------------

def test_unsupported_schema_version_rejected():
    d = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID)).to_dict()
    d["schema_version"] = 999
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert any(path == "schema_version" for path, _ in exc.value.errors)


def test_malformed_snapshot_rejected():
    with pytest.raises(ProfileValidationError):
        snapshot_from_dict("garbage")
    with pytest.raises(ProfileValidationError):
        snapshot_from_dict(None)


def test_unknown_snapshot_field_rejected():
    d = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID)).to_dict()
    d["mystery"] = 1
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert any(path == "mystery" for path, _ in exc.value.errors)


def test_fingerprint_mismatch_detected():
    """A snapshot whose data no longer matches its fingerprint is rejected —
    corruption is never silently accepted."""
    d = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID)).to_dict()
    d["margins"]["left_in"] = 2.0  # change data but keep old fingerprint
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


def test_unresolved_inheritance_rejected():
    """A snapshot that still carries unresolved inherit_body_font is
    rejected — snapshots are fully resolved."""
    d = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID)).to_dict()
    # Simulate a legacy/malformed snapshot that kept inheritance unresolved.
    d["heading"]["inherit_body_font"] = True
    with pytest.raises(ProfileValidationError):
        snapshot_from_dict(d)


def test_custom_claiming_builtin_source_rejected():
    custom = new_custom_profile("Fake", base=get_builtin_profile(APA_PROFILE_ID))
    custom.profile_source = "built_in"
    with pytest.raises(ProfileValidationError) as exc:
        resolve_snapshot(custom)
    assert any(path == "profile_source" for path, _ in exc.value.errors)


def test_errors_carry_field_paths():
    """Validation errors are (path, message) pairs — never raw stack traces."""
    d = get_builtin_profile(APA_PROFILE_ID).to_dict()
    d["body"]["line_spacing"] = 99
    from app.services.profile_schema import profile_from_dict
    with pytest.raises(ProfileValidationError) as exc:
        resolve_snapshot(profile_from_dict(d))
    for path, msg in exc.value.errors:
        assert isinstance(path, str) and path
        assert isinstance(msg, str) and msg
    assert not str(exc.value).startswith("Traceback")


# ---------------------------------------------------------------------------
# No PresetConfig fallback / no document content
# ---------------------------------------------------------------------------

def test_no_preset_config_fallback():
    """A blank custom profile resolves with all nulls — no global default
    leaks in."""
    blank = new_custom_profile("Blank")
    snap = resolve_snapshot(blank)
    assert snap.body_font_family is None
    assert snap.body_font_size_pt is None
    assert snap.margin_left_in is None
    assert snap.body_line_spacing is None


def test_no_document_content_in_snapshot():
    """Snapshots never carry document text, filenames, or paths."""
    d = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID)).to_dict()
    text = json.dumps(d).lower()
    assert "student" not in text
    assert "garcia" not in text
    assert ".docx" not in text
    assert "c:\\" not in text and "/tmp" not in text


# ---------------------------------------------------------------------------
# PresetConfig adapter purity
# ---------------------------------------------------------------------------

def test_adapter_output_from_snapshot_only():
    """Adapter output comes exclusively from the resolved snapshot."""
    snap = resolve_snapshot(get_builtin_profile(SUC_PROFILE_ID))
    view = snapshot_to_preset_view(snap)
    assert view["FONT_FAMILY"] == "Times New Roman"
    assert view["FONT_SIZE_BODY"] == 12.0
    assert view["MARGIN_LEFT"] is None  # SUC margins not enforced
    assert view["MARGIN_RIGHT"] is None
    assert view["MARGIN_TOP"] is None
    assert view["MARGIN_BOTTOM"] is None
    assert view["REFERENCES_LINE_SPACING"] == 2.0
    assert view["LIST_SPACE_AFTER"] is None  # nullable preserved


def test_adapter_nullables_stay_null():
    apa = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    view = snapshot_to_preset_view(apa)
    assert view["FONT_FAMILY"] is None  # allowed set, no exact family
    assert view["FONT_SIZE_BODY"] is None
    assert view["LIST_SPACE_AFTER"] is None
    assert view["CAPTION_SPACE_BEFORE"] is None


def test_adapter_apa_heading_sizes_not_descending():
    """APA headings inherit the body font — no fixed 16/14/12 pt sizes."""
    apa = resolve_snapshot(_apa_with_selection("Calibri", 11.0))
    view = snapshot_to_preset_view(apa)
    assert view["FONT_SIZE_H1"] == view["FONT_SIZE_H2"] == view["FONT_SIZE_H3"] == 11.0


def test_adapter_does_not_leak_global_preset():
    """No global-default fallback — a blank profile maps to all-None."""
    blank = resolve_snapshot(new_custom_profile("Blank"))
    view = snapshot_to_preset_view(blank)
    for value in view.values():
        assert value is None or value == "bold"


# ---------------------------------------------------------------------------
# Snapshot schema v2 — citation matching group + v1 compatibility
# ---------------------------------------------------------------------------

_V1_FIXTURE = Path(__file__).parent / "fixtures" / "snapshot_v1.json"


def _v1_payload():
    """A snapshot written by the v1-producing release (main@e755109), with
    its recorded fingerprint. Regenerating it would defeat the purpose."""
    return json.loads(_V1_FIXTURE.read_text(encoding="utf-8"))


def test_v1_stored_snapshot_loads_with_fingerprint_intact():
    data = _v1_payload()
    assert data["schema_version"] == 1
    snap = snapshot_from_dict(data)
    assert snap.schema_version == 1
    assert snap.verify_fingerprint()
    # v1 payloads carry no citation group → documented defaults apply.
    assert snap.citation_check_citations_have_references is True
    assert snap.citation_check_references_are_cited is False
    assert snap.citation_check_author_year_consistency is True
    assert snap.citation_check_year_suffixes is True
    assert snap.citation_check_duplicate_references is True
    assert snap.citation_flag_ambiguous_matches is True
    assert snap.citation_allow_personal_communication is True


def test_v1_snapshot_canonical_bytes_stay_v1():
    """A v1 snapshot must serialize WITHOUT the v2 group, or every stored
    fingerprint would stop matching (historical audits lose disclosure)."""
    snap = snapshot_from_dict(_v1_payload())
    d = snap.to_dict()
    assert "citation_matching" not in d
    assert d["schema_version"] == 1
    assert snap.compute_fingerprint() == snap.fingerprint
    assert set(d) == set(snap.to_dict())


def test_v1_payload_carrying_v2_group_rejected():
    d = _v1_payload()
    d["citation_matching"] = {"check_year_suffixes": False}
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert any(path == "citation_matching" for path, _ in exc.value.errors)


def test_v3_snapshot_round_trips_with_reference_rules():
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    d = snap.to_dict()
    assert SNAPSHOT_SCHEMA_VERSION == 3
    assert d["schema_version"] == 3
    assert list(d)[-2:] == ["citation_matching", "fingerprint"]
    assert d["citation_matching"]["check_references_are_cited"] is False
    assert d["references"]["check_hanging_indent"] is True
    restored = snapshot_from_dict(json.loads(json.dumps(d)))
    assert restored == snap


def test_v2_snapshot_round_trips_with_citation_group():
    from app.services.profile_snapshot import EffectiveProfileSnapshot

    current = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    legacy = EffectiveProfileSnapshot(
        schema_version=2,
        profile_id=current.profile_id,
        profile_name=current.profile_name,
        profile_source=current.profile_source,
        references_line_spacing=current.references_line_spacing,
        references_hanging_indent_in=current.references_hanging_indent_in,
        citation_check_references_are_cited=current.citation_check_references_are_cited,
    ).with_fingerprint()
    d = legacy.to_dict()
    assert d["schema_version"] == 2
    assert set(d["references"]) == {"line_spacing", "hanging_indent_in"}
    restored = snapshot_from_dict(json.loads(json.dumps(d)))
    assert restored == legacy


def test_v2_citation_toggle_type_rejected():
    d = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID)).to_dict()
    d["citation_matching"]["check_year_suffixes"] = "yes"
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert ("citation_matching.check_year_suffixes", "must be true or false") in exc.value.errors


def test_future_schema_version_rejected():
    d = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID)).to_dict()
    d["schema_version"] = 4
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(d)
    assert any(path == "schema_version" for path, _ in exc.value.errors)


def test_dependent_citation_toggles_normalized_when_parent_off():
    p = new_custom_profile("Deps", base=get_builtin_profile(APA_PROFILE_ID))
    p.citation_matching.check_citations_have_references = False
    p.citation_matching.check_author_year_consistency = True
    p.citation_matching.check_year_suffixes = True
    snap = resolve_snapshot(p)
    assert snap.citation_check_citations_have_references is False
    assert snap.citation_check_author_year_consistency is False
    assert snap.citation_check_year_suffixes is False
    # Independent toggles survive untouched.
    assert snap.citation_check_duplicate_references is True
    assert snap.citation_flag_ambiguous_matches is True
    assert snap.citation_check_references_are_cited is False


def test_citation_group_changes_fingerprint():
    p = new_custom_profile("Fingerprint", base=get_builtin_profile(APA_PROFILE_ID))
    before = resolve_snapshot(p).fingerprint
    p.citation_matching.check_duplicate_references = False
    after = resolve_snapshot(p).fingerprint
    assert before != after


def test_adapter_exposes_citation_toggles_from_snapshot_only():
    from app.services.profile_preset_adapter import EffectiveProfileConfig
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    cfg = EffectiveProfileConfig(snap)
    assert cfg.CITATION_CHECK_CITATIONS_HAVE_REFERENCES is True
    assert cfg.CITATION_CHECK_REFERENCES_ARE_CITED is False
    assert cfg.CITATION_CHECK_AUTHOR_YEAR_CONSISTENCY is True
    assert cfg.CITATION_CHECK_YEAR_SUFFIXES is True
    assert cfg.CITATION_CHECK_DUPLICATE_REFERENCES is True
    assert cfg.CITATION_FLAG_AMBIGUOUS_MATCHES is True
    assert cfg.CITATION_ALLOW_PERSONAL_COMMUNICATION is True
