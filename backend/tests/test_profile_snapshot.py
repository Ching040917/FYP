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


def test_current_snapshot_round_trips_with_reference_rules():
    snap = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID))
    d = snap.to_dict()
    assert SNAPSHOT_SCHEMA_VERSION == 6
    assert d["schema_version"] == 6
    assert list(d)[-4:] == ["headers", "footers", "page_numbers", "fingerprint"]
    assert d["citation_matching"]["check_references_are_cited"] is False
    assert d["references"]["check_hanging_indent"] is True
    assert d["references"]["check_doi_format"] is False
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
    d["schema_version"] = SNAPSHOT_SCHEMA_VERSION + 1
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


# Historical positive controls recorded before v5, never computed from new code.
@pytest.mark.parametrize(
    ("version", "fingerprint"),
    [
        (1, "5b0fa2570973d2c54503d24471b273a2a047beafc7cd9ee6d66aefc4f006b504"),
        (2, "792b27292194ef13746b70ece966d10f05a7615c2fb776975ba3c2aff2f2340e"),
        (3, "83dd87c091afcce7ea8565e63a5164a637c6886af4d87eb61604dbc857dc760f"),
        (4, "ef7dd393581eacbcad8f86053062545dacb72766eba9af4586a375a3fa21d639"),
    ],
)
def test_pre_doi_snapshot_fingerprints_remain_frozen(version, fingerprint):
    snapshot = EffectiveProfileSnapshot(
        schema_version=version,
        profile_id="doi-freeze",
        profile_name="DOI freeze",
        profile_source="custom",
        references_line_spacing=2.0,
        references_hanging_indent_in=0.5,
        references_check_reference_order=True,
    ).with_fingerprint()
    assert snapshot.fingerprint == fingerprint
    payload = json.loads(json.dumps(snapshot.to_dict()))
    assert "check_doi_format" not in payload["references"]
    restored = snapshot_from_dict(payload)
    assert restored.fingerprint == fingerprint
    assert restored.verify_fingerprint()
    assert restored.references_check_doi_format is False
    assert restored.to_dict() == payload


@pytest.mark.parametrize("version", [1, 2, 3, 4])
@pytest.mark.parametrize("value", [False, True])
def test_historical_snapshot_rejects_injected_doi_field(version, value):
    payload = EffectiveProfileSnapshot(schema_version=version).with_fingerprint().to_dict()
    payload["references"]["check_doi_format"] = value
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert ("references.check_doi_format", "unknown field") in exc.value.errors


@pytest.mark.parametrize("value", [None, "true", "false", 0, 1, 0.0, 1.0, [], {}])
def test_v5_snapshot_doi_toggle_rejects_non_boolean(value):
    payload = resolve_snapshot(new_custom_profile("DOI strict snapshot")).to_dict()
    payload["references"]["check_doi_format"] = value
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert ("references.check_doi_format", "must be true or false") in exc.value.errors


def test_v5_doi_toggle_round_trip_copy_and_fingerprint_sensitivity():
    profile = new_custom_profile("DOI snapshot")
    disabled = resolve_snapshot(profile)
    profile.references.check_doi_format = True
    enabled = resolve_snapshot(profile)
    assert disabled.schema_version == enabled.schema_version == 6
    assert disabled.fingerprint != enabled.fingerprint
    assert enabled.fingerprint == resolve_snapshot(profile).fingerprint
    for snapshot, value in ((disabled, False), (enabled, True)):
        assert snapshot.references_check_doi_format is value
        assert snapshot.with_fingerprint().references_check_doi_format is value
        payload = json.loads(json.dumps(snapshot.to_dict()))
        assert payload["references"]["check_doi_format"] is value
        rebuilt = snapshot_from_dict(payload)
        assert rebuilt == snapshot
        assert rebuilt.verify_fingerprint()
    # Missing current-version keys use the documented Off default, but must
    # still verify against the fully reconstructed false snapshot.
    missing = disabled.to_dict()
    del missing["references"]["check_doi_format"]
    restored = snapshot_from_dict(missing)
    assert restored.references_check_doi_format is False
    assert restored.fingerprint == disabled.fingerprint


def test_v5_doi_toggle_tampering_cannot_reuse_the_disabled_fingerprint():
    payload = resolve_snapshot(new_custom_profile("DOI tamper")).to_dict()
    payload["references"]["check_doi_format"] = True
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5])
def test_snapshot_rejects_unconfigured_doi_format_and_url_fields(version):
    for name in ("doi_format", "doi_url", "url"):
        payload = EffectiveProfileSnapshot(schema_version=version).with_fingerprint().to_dict()
        payload["references"][name] = "https://doi.org/<doi>"
        with pytest.raises(ProfileValidationError) as exc:
            snapshot_from_dict(payload)
        assert (f"references.{name}", "unknown field") in exc.value.errors


def test_v5_page_elements_positive_control_remains_frozen():
    snapshot = EffectiveProfileSnapshot(
        schema_version=5,
        profile_id="page-elements-freeze",
        profile_name="Page elements freeze",
        profile_source="custom",
        references_line_spacing=2.0,
        references_hanging_indent_in=0.5,
        references_check_reference_order=True,
        references_check_doi_format=True,
    ).with_fingerprint()
    expected = "a8a442e1056028fdc76d52c50506a33feeaad62c13d1ab9e923d1b42f6e8a983"
    assert snapshot.fingerprint == expected
    payload = snapshot.to_dict()
    assert payload["references"]["check_doi_format"] is True
    assert not {"headers", "footers", "page_numbers"} & payload.keys()
    restored = snapshot_from_dict(json.loads(json.dumps(payload)))
    assert restored.to_dict() == payload
    assert restored.fingerprint == expected
    assert restored.verify_fingerprint()


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5])
@pytest.mark.parametrize("group,toggle", [
    ("headers", "check_header_requirements"),
    ("footers", "check_footer_requirements"),
    ("page_numbers", "check_page_number_requirements"),
])
@pytest.mark.parametrize("value", [False, True])
def test_historical_snapshot_rejects_structural_group(version, group, toggle, value):
    payload = EffectiveProfileSnapshot(schema_version=version).with_fingerprint().to_dict()
    payload[group] = {toggle: value}
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert (group, "unknown field") in exc.value.errors


@pytest.mark.parametrize("header", [False, True])
@pytest.mark.parametrize("footer", [False, True])
@pytest.mark.parametrize("page_number", [False, True])
@pytest.mark.parametrize("placement", ["header", "footer", "either"])
def test_v6_structural_round_trip_and_config_independence(header, footer, page_number, placement):
    from app.services.profile_preset_adapter import EffectiveProfileConfig
    profile = new_custom_profile("Structural snapshot")
    profile.headers.check_header_requirements = header
    profile.footers.check_footer_requirements = footer
    profile.page_numbers.check_page_number_requirements = page_number
    profile.page_numbers.placement = placement
    snapshot = resolve_snapshot(profile)
    restored = snapshot_from_dict(json.loads(json.dumps(snapshot.to_dict())))
    assert restored == snapshot
    assert restored.verify_fingerprint()
    assert restored.with_fingerprint() == snapshot
    config = EffectiveProfileConfig(restored)
    assert config.HEADER_CHECK_REQUIREMENTS is header
    assert config.FOOTER_CHECK_REQUIREMENTS is footer
    assert config.PAGE_NUMBER_CHECK_REQUIREMENTS is page_number
    assert config.PAGE_NUMBER_PLACEMENT == placement
    profile.headers.check_header_requirements = not header
    profile.footers.check_footer_requirements = not footer
    profile.page_numbers.placement = "footer" if placement == "header" else "header"
    assert restored.header_check_requirements is header
    assert restored.footer_check_requirements is footer
    assert restored.page_number_placement == placement


def test_v6_missing_structural_defaults_still_verify_real_fingerprint():
    snapshot = resolve_snapshot(new_custom_profile("Defaults"))
    payload = snapshot.to_dict()
    for group in ("headers", "footers", "page_numbers"):
        del payload[group]
    assert snapshot_from_dict(payload) == snapshot
    payload["fingerprint"] = "0" * 64
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


@pytest.mark.parametrize("group,toggle", [
    ("headers", "check_header_requirements"),
    ("footers", "check_footer_requirements"),
    ("page_numbers", "check_page_number_requirements"),
])
def test_v6_missing_structural_fields_and_tampering(group, toggle):
    snapshot = resolve_snapshot(new_custom_profile("Structural defaults"))
    payload = snapshot.to_dict()
    payload[group] = {}
    assert snapshot_from_dict(payload) == snapshot
    payload[group][toggle] = True
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


@pytest.mark.parametrize("group", ["headers", "footers", "page_numbers"])
@pytest.mark.parametrize("value", [None, False, 0, "", [], "object"])
def test_v6_structural_groups_are_strict_objects(group, value):
    payload = resolve_snapshot(new_custom_profile("Strict groups")).to_dict()
    payload[group] = value
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == group for path, _ in exc.value.errors)


@pytest.mark.parametrize("group,toggle", [
    ("headers", "check_header_requirements"),
    ("footers", "check_footer_requirements"),
    ("page_numbers", "check_page_number_requirements"),
])
@pytest.mark.parametrize("value", [None, "true", "false", 0, 1, [], {}])
def test_v6_structural_toggles_are_actual_booleans(group, toggle, value):
    payload = resolve_snapshot(new_custom_profile("Strict toggles")).to_dict()
    payload[group][toggle] = value
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == f"{group}.{toggle}" for path, _ in exc.value.errors)


@pytest.mark.parametrize("group", ["headers", "footers", "page_numbers"])
def test_v6_structural_unknown_keys_rejected(group):
    payload = resolve_snapshot(new_custom_profile("Unknown keys")).to_dict()
    payload[group]["unknown"] = False
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert (f"{group}.unknown", "unknown field") in exc.value.errors


@pytest.mark.parametrize("value", [None, False, 0, [], {}, "", "Header", "body"])
def test_v6_page_placement_validated_even_when_off(value):
    payload = resolve_snapshot(new_custom_profile("Placement")).to_dict()
    payload["page_numbers"]["placement"] = value
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "page_numbers.placement" for path, _ in exc.value.errors)


def test_v6_off_placement_changes_fingerprint():
    profile = new_custom_profile("Off placement")
    either = resolve_snapshot(profile)
    profile.page_numbers.placement = "header"
    header = resolve_snapshot(profile)
    assert header.fingerprint != either.fingerprint
    payload = either.to_dict()
    payload["page_numbers"]["placement"] = "header"
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


@pytest.mark.parametrize("group,toggle", [
    ("headers", "check_header_requirements"),
    ("footers", "check_footer_requirements"),
    ("page_numbers", "check_page_number_requirements"),
])
def test_v6_builtin_snapshot_rejects_enabled_structural_setting(group, toggle):
    payload = resolve_snapshot(get_builtin_profile(APA_PROFILE_ID)).to_dict()
    payload[group][toggle] = True
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert (f"{group}.{toggle}", "Available only in Custom Profiles") in exc.value.errors


@pytest.mark.parametrize("group,toggle", [
    ("headers", "check_header_requirements"),
    ("footers", "check_footer_requirements"),
    ("page_numbers", "check_page_number_requirements"),
])
def test_v6_missing_enabled_setting_cannot_bypass_fingerprint(group, toggle):
    from dataclasses import replace
    snapshot = EffectiveProfileSnapshot(profile_source="custom")
    attr = {
        "headers": "header_check_requirements",
        "footers": "footer_check_requirements",
        "page_numbers": "page_number_check_requirements",
    }[group]
    enabled = replace(snapshot, **{attr: True}).with_fingerprint()
    assert enabled.fingerprint != snapshot.with_fingerprint().fingerprint
    assert getattr(enabled, attr) is True
    payload = enabled.to_dict()
    del payload[group][toggle]
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "fingerprint" for path, _ in exc.value.errors)


@pytest.mark.parametrize("version", [True, False, 1.0, 6.0, "6", 0, 7, None])
def test_snapshot_supports_only_explicit_integer_versions(version):
    payload = resolve_snapshot(new_custom_profile("Version")).to_dict()
    payload["schema_version"] = version
    with pytest.raises(ProfileValidationError) as exc:
        snapshot_from_dict(payload)
    assert any(path == "schema_version" for path, _ in exc.value.errors)


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5])
def test_historical_snapshot_structural_defaults_are_off_without_serializing(version):
    original = EffectiveProfileSnapshot(schema_version=version).with_fingerprint()
    restored = snapshot_from_dict(original.to_dict())
    assert restored.header_check_requirements is False
    assert restored.footer_check_requirements is False
    assert restored.page_number_check_requirements is False
    assert restored.page_number_placement == "either"
    assert restored.to_dict() == original.to_dict()
