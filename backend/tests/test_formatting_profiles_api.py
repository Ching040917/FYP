"""GET /api/formatting-profiles + profile-aware upload — Build 5 tests.

Covers: built-in profile endpoint, one recommended profile, immutable safe
output, no internal fields, unknown POST profile id → safe 400, missing id
uses SUC compatibility default, presentation-safe summaries.
"""
import io

from docx import Document

from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    RECOMMENDED_PROFILE_ID,
)


def _docx_bytes():
    doc = Document()
    doc.add_paragraph("Body text.")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _post(client, profile_id=None):
    files = {"file": ("t.docx", _docx_bytes(), "application/octet-stream")}
    params = {}
    if profile_id:
        params["profile_id"] = profile_id
    return client.post("/api/audit", files=files, params=params)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

def test_formatting_profiles_endpoint_returns_builtins(client):
    resp = client.get("/api/formatting-profiles")
    assert resp.status_code == 200
    profiles = resp.json()["profiles"]
    ids = {p["profile_id"] for p in profiles}
    assert ids == {SUC_PROFILE_ID, APA_PROFILE_ID}


def test_exactly_one_recommended_profile(client):
    profiles = client.get("/api/formatting-profiles").json()["profiles"]
    recommended = [p for p in profiles if p["recommended"]]
    assert len(recommended) == 1
    assert recommended[0]["profile_id"] == RECOMMENDED_PROFILE_ID
    assert recommended[0]["profile_id"] == SUC_PROFILE_ID


def test_endpoint_output_is_presentation_safe(client):
    """No internal fields: fingerprint, schema, allowed combos internals,
    exempt role sets, or validation data never leak."""
    profiles = client.get("/api/formatting-profiles").json()["profiles"]
    allowed = {"profile_id", "profile_name", "profile_version", "description",
               "profile_source", "recommended", "citation_style", "key_requirements"}
    for p in profiles:
        assert set(p.keys()) == allowed
        text = str(p).lower()
        assert "fingerprint" not in text
        assert "schema_version" not in text
        assert "exempt" not in text
        assert "presetconfig" not in text


def test_endpoint_suc_summary_institution_specific(client):
    profiles = client.get("/api/formatting-profiles").json()["profiles"]
    suc = next(p for p in profiles if p["profile_id"] == SUC_PROFILE_ID)
    assert suc["profile_source"] == "built_in"
    assert suc["citation_style"] == "APA 7"
    assert suc["profile_version"] == 2
    joined = " ".join(suc["key_requirements"]).lower()
    assert "margins: not checked" in joined
    assert "course or document template specifies them" in joined
    assert "12 pt body" in joined
    assert "institution" in suc["description"].lower()


def test_endpoint_apa_summary_truthful(client):
    profiles = client.get("/api/formatting-profiles").json()["profiles"]
    apa = next(p for p in profiles if p["profile_id"] == APA_PROFILE_ID)
    joined = " ".join(apa["key_requirements"]).lower()
    assert "margins: 1 in on all sides" in joined
    assert "double line spacing" in joined
    assert "left-aligned" in joined
    assert "allowed fonts" in joined
    assert "headings use the body font" in joined


# ---------------------------------------------------------------------------
# Upload profile-aware
# ---------------------------------------------------------------------------

def test_unknown_profile_id_returns_safe_400(client):
    resp = _post(client, profile_id="nope")
    assert resp.status_code == 400
    assert "unknown profile" in resp.json()["detail"].lower()
    assert "Traceback" not in resp.json()["detail"]


def test_missing_profile_id_uses_suc_default(client):
    resp = _post(client)
    assert resp.status_code == 200
    snap = resp.json()["profile_snapshot"]
    assert snap["profile_id"] == RECOMMENDED_PROFILE_ID
    assert snap["profile_id"] == SUC_PROFILE_ID


def test_apa_selection_persists_apa_snapshot(client):
    resp = _post(client, profile_id=APA_PROFILE_ID)
    assert resp.status_code == 200
    assert resp.json()["profile_snapshot"]["profile_id"] == APA_PROFILE_ID


# ---------------------------------------------------------------------------
# Built-in payload endpoint (Build 3 custom-profile editor)
# ---------------------------------------------------------------------------

def test_builtin_payload_endpoint_returns_canonical_payload(client):
    """The editor copies SUC/APA from the authoritative registry payload."""
    for pid in (SUC_PROFILE_ID, APA_PROFILE_ID):
        resp = client.get(f"/api/formatting-profiles/{pid}/payload")
        assert resp.status_code == 200
        profile = resp.json()["profile"]
        assert profile["profile_id"] == pid
        assert profile["profile_source"] == "built_in"
        assert profile["citation_style"] == "APA 7"
        assert "body" in profile and "margins" in profile and "role_policy" in profile
        # Presentation-safe: no snapshot fingerprint, no internals.
        text = str(profile).lower()
        assert "fingerprint" not in text
        assert "schema_version" not in text
        assert "presetconfig" not in text


def test_builtin_payload_endpoint_404_for_unknown(client):
    resp = client.get("/api/formatting-profiles/nope/payload")
    assert resp.status_code == 404
    assert "Traceback" not in resp.json()["detail"]
