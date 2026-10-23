"""POST /api/formatting-profiles/validate — Build 2 tests.

Presentation-safe custom profile validation: authoritative backend
profile_from_dict + resolve_snapshot, friendly stable field identifiers,
friendly English messages, deterministic normalized output, and NO side
effects (no Audit, no DB row, no registry change, no files).
"""
import json

import pytest

from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    get_builtin_profile,
)
from app.services.profile_schema import new_custom_profile
from app.services.custom_profile_validation import validate_custom_profile

URL = "/api/formatting-profiles/validate"


def _blank_payload(**overrides):
    payload = {
        "profile_id": "custom-blank",
        "profile_name": "Blank Custom",
        "profile_version": 1,
        "profile_source": "custom",
        "description": "",
        "citation_style": "APA 7",
    }
    payload.update(overrides)
    return payload


def _from_builtin(pid, profile_id="custom-copy", profile_name="Copied Profile"):
    base = get_builtin_profile(pid).to_dict()
    base["profile_id"] = profile_id
    base["profile_name"] = profile_name
    base["profile_source"] = "custom"
    return base


# ---------------------------------------------------------------------------
# Valid cases
# ---------------------------------------------------------------------------

def test_valid_blank_custom_profile(client):
    resp = client.post(URL, json=_blank_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    profile = body["profile"]
    assert profile["profile_source"] == "custom"
    assert profile["body"]["font_family"] is None
    assert profile["margins"]["margin_left_in"] is None
    assert profile["citation_style"] == "APA 7"


def test_custom_profile_copied_from_suc(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    resp = client.post(URL, json=payload)
    assert resp.status_code == 200
    profile = resp.json()["profile"]
    assert profile["profile_source"] == "custom"
    assert profile["body"]["font_family"] == "Times New Roman"
    assert profile["body"]["font_size_pt"] == 12.0
    assert profile["heading"]["font_size_pt"] == 16.0


def test_custom_profile_copied_from_apa(client):
    payload = _from_builtin(APA_PROFILE_ID)
    resp = client.post(URL, json=payload)
    assert resp.status_code == 200
    profile = resp.json()["profile"]
    assert profile["profile_source"] == "custom"
    assert profile["margins"]["margin_left_in"] == 1.0
    assert profile["heading"]["inherit_body_font"] is True


def test_explicit_one_point_five_inch_left_margin(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    payload["margins"] = {
        "margin_left_in": 1.5,
        "margin_right_in": None,
        "margin_top_in": None,
        "margin_bottom_in": None,
    }
    resp = client.post(URL, json=payload)
    assert resp.status_code == 200
    profile = resp.json()["profile"]
    assert profile["margins"]["margin_left_in"] == 1.5
    assert profile["margins"]["margin_right_in"] is None


def test_null_margins_remain_null(client):
    payload = _blank_payload()
    payload["margins"] = {
        "margin_left_in": None,
        "margin_right_in": None,
        "margin_top_in": None,
        "margin_bottom_in": None,
    }
    resp = client.post(URL, json=payload)
    assert resp.status_code == 200
    margins = resp.json()["profile"]["margins"]
    assert margins["margin_left_in"] is None
    assert margins["margin_right_in"] is None


# ---------------------------------------------------------------------------
# Invalid cases
# ---------------------------------------------------------------------------

def test_invalid_enabled_margin_below_editor_minimum(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    payload["margins"] = {
        "margin_left_in": 0.1,
        "margin_right_in": None,
        "margin_top_in": None,
        "margin_bottom_in": None,
    }
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "margins.left"
    assert "0.25 and 4" in body["errors"][0]["message"]


def test_invalid_font_size_pair(client):
    payload = _from_builtin(APA_PROFILE_ID)
    payload["body"]["allowed_font_combos"] = [
        ["Times New Roman", 12.0],
        ["Calibri", 999.0],
    ]
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "body.font_pairs"
    assert "font size" in body["errors"][0]["message"].lower()


def test_heading_inheritance_conflict(client):
    payload = _from_builtin(APA_PROFILE_ID)
    payload["heading"]["inherit_body_font"] = True
    payload["heading"]["font_size_pt"] = 16.0
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "headings.level_1.font"
    assert "inheritance" in body["errors"][0]["message"].lower()


def test_duplicate_font_pair(client):
    payload = _from_builtin(APA_PROFILE_ID)
    combos = [list(c) for c in payload["body"]["allowed_font_combos"]]
    combos.append(["Times New Roman", 12.0])
    payload["body"]["allowed_font_combos"] = combos
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "body.font_pairs"
    assert "only once" in body["errors"][0]["message"]


def test_unsupported_citation_style(client):
    payload = _blank_payload(citation_style="Chicago 17")
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "general.citation_style"
    assert "APA 7" in body["errors"][0]["message"]


def test_unknown_field_rejected(client):
    payload = _blank_payload()
    payload["mystery_field"] = "x"
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "mystery_field"
    assert "not recognized" in body["errors"][0]["message"]


def test_future_schema_version_rejected(client):
    payload = _blank_payload(schema_version=99)
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "general.version"
    assert "unsupported schema version" in body["errors"][0]["message"]


def test_builtin_source_claim_rejected(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    payload["profile_source"] = "built_in"
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "general.source"


def test_builtin_profile_id_as_custom_identity_rejected(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    payload["profile_id"] = SUC_PROFILE_ID
    payload["profile_name"] = "Impersonator"
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "general.id"


def test_heading_inherit_without_body_font_rejected(client):
    payload = _blank_payload()
    payload["heading"] = {"inherit_body_font": True}
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["valid"] is False
    assert body["errors"][0]["field"] == "headings.level_1.font"
    assert "cannot inherit" in body["errors"][0]["message"]


# ---------------------------------------------------------------------------
# Presentation safety
# ---------------------------------------------------------------------------

def test_safe_normalized_success_response(client):
    resp = client.post(URL, json=_blank_payload())
    text = str(resp.json()).lower()
    assert "fingerprint" not in text
    assert "schema_version" not in text
    assert "presetconfig" not in text
    assert "traceback" not in text


def test_friendly_field_identifiers(client):
    payload = _blank_payload(citation_style="Chicago 17")
    resp = client.post(URL, json=payload)
    errors = resp.json()["errors"]
    assert errors[0]["field"] == "general.citation_style"
    assert not any("body.allowed_font_combos" in e["field"] for e in errors)


def test_no_stack_trace_or_internal_path(client):
    payload = _blank_payload()
    payload["body"] = {"allowed_font_combos": "garbage"}
    resp = client.post(URL, json=payload)
    assert resp.status_code == 422
    text = str(resp.json()).lower()
    assert "traceback" not in text
    assert ".py" not in text
    assert "c:\\" not in text
    assert "profile_schema" not in text
    assert "exception" not in text


# ---------------------------------------------------------------------------
# No side effects
# ---------------------------------------------------------------------------

def test_endpoint_creates_no_audit(client):
    before = client.get("/api/audits").json()
    client.post(URL, json=_blank_payload())
    client.post(URL, json=_from_builtin(APA_PROFILE_ID))
    after = client.get("/api/audits").json()
    assert len(after) == len(before)


def test_database_remains_unchanged(client, test_engine):
    from app.models.audit import AuditRecord
    from sqlalchemy import inspect
    before = client.get("/api/audits").json()
    client.post(URL, json=_blank_payload())
    client.post(URL, json=_blank_payload(profile_id="custom-blank", profile_name="Blank Custom"))
    after = client.get("/api/audits").json()
    assert after == before
    assert len(before) == 0
    assert len(inspect(test_engine).get_table_names()) >= 1
    assert test_engine.connect().execute(
        __import__("sqlalchemy").select(__import__("sqlalchemy").func.count(AuditRecord.id))
    ).scalar() == 0


def test_repeat_request_is_deterministic(client):
    payload = _from_builtin(APA_PROFILE_ID)
    a = client.post(URL, json=payload).json()
    b = client.post(URL, json=payload).json()
    assert a == b


def test_input_object_mutation_cannot_alter_response(client):
    payload = _from_builtin(SUC_PROFILE_ID)
    resp1 = client.post(URL, json=payload).json()
    mutated = dict(payload)
    mutated["margins"] = {"margin_left_in": 3.0, "margin_right_in": None,
                          "margin_top_in": None, "margin_bottom_in": None}
    mutated["body"]["font_size_pt"] = 999.0
    resp2 = client.post(URL, json=mutated).json()
    assert resp1["valid"] is True
    assert resp1["profile"]["margins"]["margin_left_in"] is None
    assert resp1["profile"]["margins"]["margin_right_in"] is None
    assert resp1["profile"]["body"]["font_size_pt"] == 12.0



# ---------------------------------------------------------------------------
# Citation ↔ Reference List matching toggles
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


def test_payload_without_citation_group_valid_and_normalized_to_defaults(client):
    """Saved custom profiles predating the group keep validating."""
    resp = client.post(URL, json=_blank_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert body["profile"]["citation_matching"] == _CITATION_DEFAULTS


def test_citation_toggles_round_trip_through_validation(client):
    submitted = {
        "check_citations_have_references": True,
        "check_references_are_cited": True,
        "check_author_year_consistency": False,
        "check_year_suffixes": False,
        "check_duplicate_references": False,
        "flag_ambiguous_matches": False,
        "allow_personal_communication": False,
    }
    resp = client.post(URL, json=_blank_payload(citation_matching=submitted))
    body = resp.json()
    assert body["valid"] is True
    assert body["profile"]["citation_matching"] == submitted


def test_non_boolean_citation_toggle_rejected_with_friendly_message(client):
    resp = client.post(URL, json=_blank_payload(
        citation_matching={"check_year_suffixes": "yes"},
    ))
    body = resp.json()
    assert body["valid"] is False
    assert {
        "field": "citation_matching.check_year_suffixes",
        "message": "Choose true or false for this check.",
    } in body["errors"]


def test_unknown_citation_toggle_rejected_safely(client):
    resp = client.post(URL, json=_blank_payload(
        citation_matching={"mystery_toggle": True},
    ))
    body = resp.json()
    assert body["valid"] is False
    assert {
        "field": "citation_matching.mystery_toggle",
        "message": "This field is not recognized.",
    } in body["errors"]


def test_citation_group_must_be_an_object(client):
    resp = client.post(URL, json=_blank_payload(citation_matching=["on"]))
    body = resp.json()
    assert body["valid"] is False
    assert any(e["field"] == "citation_matching" for e in body["errors"])


def test_page_element_validation_normalizes_legacy_defaults_without_version_bump():
    result = validate_custom_profile(_blank_payload(schema_version=1))
    assert result["valid"] is True
    assert result["profile"]["headers"] == {"check_header_requirements": False}
    assert result["profile"]["footers"] == {"check_footer_requirements": False}
    assert result["profile"]["page_numbers"] == {
        "check_page_number_requirements": False, "placement": "either",
    }


def test_page_element_validation_reports_friendly_field_paths():
    cases = [
        ({"headers": None}, "headers", "This section is not well formed."),
        ({"footers": []}, "footers", "This section is not well formed."),
        ({"page_numbers": False}, "page_numbers", "This section is not well formed."),
        ({"headers": {"check_header_requirements": 1}},
         "headers.check_header_requirements", "Choose true or false for this check."),
        ({"footers": {"check_footer_requirements": "true"}},
         "footers.check_footer_requirements", "Choose true or false for this check."),
        ({"page_numbers": {"check_page_number_requirements": None}},
         "page_numbers.check_page_number_requirements", "Choose true or false for this check."),
        ({"page_numbers": {"placement": "body"}},
         "page_numbers.placement", "Choose Header, Footer or Either."),
        ({"headers": {"unknown": False}},
         "headers.unknown", "This field is not recognized."),
    ]
    for overrides, field, message in cases:
        result = validate_custom_profile(_blank_payload(**overrides))
        assert result == {"valid": False, "errors": [{"field": field, "message": message}]}


def test_page_element_validation_keeps_custom_only_error_on_each_control():
    for group, toggle in (
        ("headers", "check_header_requirements"),
        ("footers", "check_footer_requirements"),
        ("page_numbers", "check_page_number_requirements"),
    ):
        result = validate_custom_profile(_blank_payload(
            profile_source="built_in", **{group: {toggle: True}},
        ))
        assert result == {
            "valid": False,
            "errors": [{
                "field": f"{group}.{toggle}",
                "message": "Available only in Custom Profiles",
            }],
        }


def test_page_element_enabled_settings_survive_api_validation_without_mutation(client):
    payload = _blank_payload(
        schema_version=1,
        headers={"check_header_requirements": True},
        footers={"check_footer_requirements": True},
        page_numbers={"check_page_number_requirements": True, "placement": "footer"},
    )
    response = client.post(URL, json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result["valid"] is True
    for group in ("headers", "footers", "page_numbers"):
        assert result["profile"][group] == payload[group]
    assert payload["schema_version"] == 1


@pytest.mark.parametrize(("group", "value", "field"), [
    ("heading", {"allowed_font_combos": [42]}, "headings.level_1.font"),
    ("body", {"allowed_font_combos": "not-pairs"}, "body.font_pairs"),
    ("body", {"allowed_font_combos": [[["nested"], 12]]}, "body.font_pairs"),
    ("role_policy", {"exempt_roles": 42}, "role_policy.exempt_roles"),
    ("role_policy", {"exempt_roles": [{}]}, "role_policy.exempt_roles"),
    ("body", {"font_family": True}, "body.font_pairs"),
    ("heading", {"inherit_body_font": "yes"}, "headings.level_1.font"),
])
def test_malformed_nested_values_return_field_errors(client, group, value, field):
    response = client.post(URL, json=_blank_payload(**{group: value}))
    assert response.status_code == 422
    result = response.json()
    assert result["valid"] is False
    assert field in {error["field"] for error in result["errors"]}


@pytest.mark.parametrize(("group", "value", "field"), [
    ("body", {"line_spacing": float("inf")}, "body.line_spacing"),
    ("heading", {"allowed_font_combos": [["Arial", float("nan")]]}, "headings.level_1.font"),
    ("heading", {"level_1": {"retained_metadata": float("-inf")}}, "heading.level_1.retained_metadata"),
])
def test_nonfinite_values_cannot_escape_into_normalized_json(client, group, value, field):
    response = client.post(
        URL,
        content=json.dumps(_blank_payload(**{group: value})),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    result = response.json()
    assert result["valid"] is False
    assert result["errors"][0]["field"] == field


def test_description_boundary_matches_editor_without_truncation(client):
    description = "Ω" * 500
    valid = client.post(URL, json=_blank_payload(description=description))
    assert valid.status_code == 200
    assert valid.json()["profile"]["description"] == description
    invalid = client.post(URL, json=_blank_payload(description=description + "Ω"))
    assert invalid.status_code == 422
    assert invalid.json()["errors"][0]["field"] == "general.description"


def test_schema_version_boolean_is_not_version_one(client):
    response = client.post(URL, json=_blank_payload(schema_version=True))
    assert response.status_code == 422
    assert response.json()["errors"][0]["field"] == "general.version"


def test_validation_preserves_supported_disabled_and_unknown_role_metadata(client):
    references = {
        "check_font_family": False,
        "font_family": "Georgia",
        "check_line_spacing": None,
        "line_spacing": 2,
        "check_heading_bold": True,
        "heading_bold": False,
    }
    role_policy = {"exempt_roles": ["UNKNOWN", "UNRECOGNIZED_ROLE"], "table_eligibility": "both"}
    response = client.post(URL, json=_blank_payload(
        references=references,
        role_policy=role_policy,
        body={"first_line_indent_in": 0.5},
        heading={"level_1": {"alignment": "center", "retained_metadata": {"key": "value"}}},
    ))
    assert response.status_code == 200
    normalized = response.json()["profile"]
    assert all(normalized["references"][key] == value for key, value in references.items())
    assert set(normalized["role_policy"]["exempt_roles"]) == set(role_policy["exempt_roles"])
    assert normalized["body"]["first_line_indent_in"] == 0.5
    assert normalized["heading"]["level_1"] == {
        "alignment": "center", "retained_metadata": {"key": "value"},
    }
