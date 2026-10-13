"""Strict Local AI eligibility: helper matrix + route integration (no Ollama)."""
from types import SimpleNamespace

from app.api import routes as api_routes
from app.services import ai_citation
from app.services.ai_citation import async_ai_citation_task
from app.services.ai_citation_eligibility import is_local_ai_citation_eligible
from app.services.layout_violation import LayoutViolation


def _v(rule="CITATION_MISMATCH", severity="MAJOR", location=None, actual="(Smith, 2020)"):
    return LayoutViolation(
        rule_code=rule,
        severity=severity,
        location={"paragraph_index": 2} if location is None else location,
        message="Citation 'Smith (2020)' was found in text, but no matching entry was found.",
        expected_value="Reference entry for Smith",
        actual_value=actual,
    )


# ---- Helper matrix (mirrored with frontend) ----

def test_01_valid_per_citation_eligible():
    assert is_local_ai_citation_eligible(_v()) is True


def test_02_missing_references_section_denied():
    v = _v(location={"paragraph_index": 0, "citation_count": 2, "missing_references_section": True}, actual=None)
    assert is_local_ai_citation_eligible(v) is False


def test_03_missing_paragraph_index_denied():
    assert is_local_ai_citation_eligible(_v(location={"occurrences": 1})) is False
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": None})) is False


def test_04_boolean_paragraph_index_denied():
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": True})) is False
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": False})) is False


def test_05_negative_paragraph_index_denied():
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": -1})) is False


def test_06_string_paragraph_index_denied():
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": "2"})) is False


def test_07_fractional_paragraph_index_denied():
    assert is_local_ai_citation_eligible(_v(location={"paragraph_index": 1.5})) is False


def test_08_null_actual_denied():
    assert is_local_ai_citation_eligible(_v(actual=None)) is False


def test_09_empty_actual_denied():
    assert is_local_ai_citation_eligible(_v(actual="")) is False


def test_10_whitespace_actual_denied():
    assert is_local_ai_citation_eligible(_v(actual="   \n\t ")) is False


def test_11_review_severity_denied():
    assert is_local_ai_citation_eligible(_v(severity="REVIEW")) is False


def test_12_unknown_severity_denied():
    assert is_local_ai_citation_eligible(_v(severity="UNKNOWN")) is False


def test_13_null_severity_denied():
    assert is_local_ai_citation_eligible(_v(severity=None)) is False


def test_14_other_codes_denied():
    for code in (
        "CITATION_REFERENCE_MISMATCH",
        "CITATION_YEAR_SUFFIX_MISMATCH",
        "CITATION_REFERENCE_AMBIGUOUS",
        "REFERENCE_NOT_CITED",
        "REFERENCE_DUPLICATE",
        "REFERENCE_HEADING_TEXT",
        "ALIGNMENT",
    ):
        assert is_local_ai_citation_eligible(_v(rule=code)) is False


def test_15_reference_entry_target_denied():
    v = _v(rule="REFERENCE_DUPLICATE", severity="MINOR",
           location={"paragraph_index": 9, "entry_count": 2, "paragraph_indexes": [8, 9]},
           actual="Smith, J. (2020). Title.")
    assert is_local_ai_citation_eligible(v) is False


def test_16_consolidated_valid_eligible():
    v = _v(location={"paragraph_index": 3, "occurrences": 4, "paragraph_indexes": [3, 7, 9]})
    assert is_local_ai_citation_eligible(v) is True


def test_16b_non_dict_location_denied():
    assert is_local_ai_citation_eligible(LayoutViolation(
        rule_code="CITATION_MISMATCH", severity="MAJOR", location=None,
        message="m", expected_value="e", actual_value="(A, 2020)")) is False
    assert is_local_ai_citation_eligible(LayoutViolation(
        rule_code="CITATION_MISMATCH", severity="MAJOR", location=[1],  # type: ignore
        message="m", expected_value="e", actual_value="(A, 2020)")) is False
    assert is_local_ai_citation_eligible(SimpleNamespace(
        rule_code="CITATION_MISMATCH", severity="MAJOR",
        location={"paragraph_index": 0}, message="m",
        expected_value="e", actual_value="(A, 2020)")) is True


# ---- Route integration (mock only the provider boundary) ----

def _install_spy(monkeypatch):
    """Route uses the real task; provider boundary is spied, never called for real."""
    calls = {"prompts": 0, "findings": None}

    async def _fake_provider(prompt):
        calls["prompts"] += 1
        return "[]"

    real_task = async_ai_citation_task

    async def _spy_task(*args, **kwargs):
        calls["findings"] = kwargs.get("citation_findings", [])
        return await real_task(*args, **kwargs)

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_provider)
    monkeypatch.setattr(api_routes, "async_ai_citation_task", _spy_task)
    return calls


def test_root_finding_persisted_major_scored_no_provider(client, docx_factory, monkeypatch):
    calls = _install_spy(monkeypatch)
    file_bytes = docx_factory(paragraphs=["Body intro.", "Orphan (Garcia, 2018) text."], references=None)
    resp = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()
    roots = [v for v in data["physical_layout_errors"]
             if v["rule_code"] == "CITATION_MISMATCH"
             and (v["location"] or {}).get("missing_references_section") is True]
    assert len(roots) == 1
    assert roots[0]["severity"] == "MAJOR"
    assert data["weighted_compliance_score"] == 95
    # Root never reaches the provider: empty eligible list, no provider call.
    assert calls["findings"] == []
    assert calls["prompts"] == 0
    assert data["ai_citation_tooltips"] == []
    assert data["ai_review_status"] == "COMPLETED_NO_SUGGESTIONS"


def test_valid_per_citation_reaches_provider_snippet_only(client, docx_factory, monkeypatch):
    calls = _install_spy(monkeypatch)
    file_bytes = docx_factory(
        paragraphs=["Body intro.", "See (Smith, 2019) for detail."],
        references=["Doe, J. (2020). Unrelated reference entry text."],
    )
    resp = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()
    assert calls["prompts"] == 1
    assert len(calls["findings"]) == 1
    finding = calls["findings"][0]
    assert finding["rule_code"] == "CITATION_MISMATCH"
    assert type(finding["paragraph_index"]) is int
    assert finding["snippet"].strip() != ""
    assert "(Smith, 2019)" in finding["snippet"]
    # No Reference List text leaks into the provider input.
    blob = str(calls["findings"])
    assert "Unrelated reference entry text" not in blob
    assert "Doe" not in blob


def test_unsupported_year_mismatch_never_reaches_provider(client, docx_factory, monkeypatch):
    calls = _install_spy(monkeypatch)
    file_bytes = docx_factory(
        paragraphs=["Body intro.", "See (Smith, 2019) for detail."],
        references=["Smith, J. (2020). Same author different year entry."],
    )
    resp = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()
    codes = {v["rule_code"] for v in data["physical_layout_errors"]}
    assert "CITATION_MISMATCH" not in codes
    assert calls["findings"] == []
    assert calls["prompts"] == 0
    assert data["ai_citation_tooltips"] == []


def test_deterministic_parity_ai_available_vs_unavailable(client, docx_factory, monkeypatch):
    from app.services.ai_citation import AiCitationResult
    file_bytes = docx_factory(paragraphs=["Body intro.", "Orphan (Garcia, 2018) text."], references=None)

    async def _fail(*args, **kwargs):
        return AiCitationResult(status="UNAVAILABLE", provider=None, suggestions=[])

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _fail)
    unavailable = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")}).json()

    calls = _install_spy(monkeypatch)
    available = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")}).json()

    def _sans_ids(violations):
        return [{k: v for k, v in item.items() if k != "id"} for item in violations]

    assert _sans_ids(unavailable["physical_layout_errors"]) == _sans_ids(available["physical_layout_errors"])
    assert unavailable["weighted_compliance_score"] == available["weighted_compliance_score"] == 95
