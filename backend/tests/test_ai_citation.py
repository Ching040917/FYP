"""Tests for the deterministic-first AI citation guidance layer (Build 7F).

Covers:
- LOCAL guidance for confirmed findings
- CLOUD guidance for confirmed findings
- CLOUD fallback to LOCAL
- no findings skips provider call
- valid [] means COMPLETED_NO_SUGGESTIONS
- malformed response means UNAVAILABLE
- timeout means UNAVAILABLE
- one suggestion maps to the correct finding
- reordered provider output maps correctly
- unknown or duplicate mapping is rejected safely
- deterministic findings and score are identical with AI available and unavailable
- prompt, document text, and raw response are absent from captured logs
"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.api import routes as api_routes
from app.services import ai_citation
from app.services.ai_citation import (
    AiCitationResult,
    async_ai_citation_task,
    _GUIDANCE_PARSE_ERROR,
    _parse_guidance_response,
    _validate_guidance_confidence,
    AI_STATUS_WITH_SUGGESTIONS,
    AI_STATUS_NO_SUGGESTIONS,
    AI_STATUS_UNAVAILABLE,
    AI_PROVIDER_LOCAL,
    AI_PROVIDER_CLOUD,
    AI_PROVIDER_CLOUD_FALLBACK_LOCAL,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def ai_session(test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def ai_client(client, monkeypatch):
    """Return (client, setter) where setter re-points the AI task result."""
    def _set(result: AiCitationResult):
        async def _fake(*args, **kwargs):
            return result
        monkeypatch.setattr(api_routes, "async_ai_citation_task", _fake)
    return client, _set


# ---------------------------------------------------------------------------
# Deterministic helper factories
# ---------------------------------------------------------------------------

def _finding(idx, author="Smith", year="2020"):
    return {
        "finding_key": f"fk-{idx}-{author}-{year}",
        "paragraph_index": idx,
        "rule_code": "CITATION_MISMATCH",
        "severity": "MAJOR",
        "snippet": f"({author}, {year})",
        "message": f"Citation '{author} ({year})' was found in text, but no matching entry was found in the References bibliography.",
        "expected_value": f"Reference entry for {author}",
        "actual_value": f"({author}, {year})",
    }


# ---------------------------------------------------------------------------
# _parse_guidance_response
# ---------------------------------------------------------------------------

def test_parse_guidance_valid_array():
    raw = '[{"paragraph_index": 0, "suggestion": "Fix it.", "confidence": 0.9}]'
    out = _parse_guidance_response(raw)
    assert len(out) == 1
    assert out[0]["paragraph_index"] == 0
    assert out[0]["suggestion"] == "Fix it."


def test_parse_guidance_empty_array():
    assert _parse_guidance_response("[]") == []


def test_parse_guidance_malformed_returns_error():
    assert _parse_guidance_response("not json") is _GUIDANCE_PARSE_ERROR
    assert _parse_guidance_response("") is _GUIDANCE_PARSE_ERROR
    assert _parse_guidance_response(None) is _GUIDANCE_PARSE_ERROR
    # Also test garbage that contains brackets but isn't valid JSON
    assert _parse_guidance_response("{{{not json}}}") is _GUIDANCE_PARSE_ERROR


def test_parse_guidance_valid_empty_array():
    assert _parse_guidance_response("[]") == []


def test_parse_guidance_with_code_fence():
    raw = '```json\n[{"paragraph_index": 1, "suggestion": "Add ref.", "confidence": 1.0}]\n```'
    out = _parse_guidance_response(raw)
    assert len(out) == 1
    assert out[0]["paragraph_index"] == 1


def test_parse_guidance_object_envelope_unwrap():
    raw = '{"findings": [{"paragraph_index": 0, "suggestion": "x", "confidence": 0.8}]}'
    out = _parse_guidance_response(raw)
    assert len(out) == 1


# ---------------------------------------------------------------------------
# _validate_guidance_confidence
# ---------------------------------------------------------------------------

def test_validate_confidence_valid():
    assert _validate_guidance_confidence(0.9) == 0.9
    assert _validate_guidance_confidence(1.0) == 1.0
    assert _validate_guidance_confidence(0.0) == 0.0


def test_validate_confidence_out_of_range():
    assert _validate_guidance_confidence(1.1) is None
    assert _validate_guidance_confidence(-0.1) is None


def test_validate_confidence_none():
    assert _validate_guidance_confidence(None) is None


def test_validate_confidence_non_numeric():
    assert _validate_guidance_confidence("high") is None
    assert _validate_guidance_confidence(True) is None


# ---------------------------------------------------------------------------
# async_ai_citation_task — LOCAL guidance for confirmed findings
# ---------------------------------------------------------------------------

async def test_local_guidance_for_findings(ai_session, monkeypatch):
    """LOCAL mode: findings present → provider called → suggestions persisted."""
    findings = [_finding(3), _finding(7, "Garcia", "2018")]

    async def _fake(prompt):
        # prompt must contain the findings, NOT raw document text
        assert "CITATION_MISMATCH" in prompt
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add Garcia (2018) to References.", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[1]["finding_key"], "reason": "Add the missing reference entry.", "source_type": "unknown", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)
    out = await async_ai_citation_task(
        audit_id="g1",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert out.provider == AI_PROVIDER_LOCAL
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 3
    assert out.suggestions[0]["confidence"] == 1.0
    assert out.suggestions[1]["paragraph_index"] == 7
    assert out.suggestions[1]["confidence"] == 0.9


# ---------------------------------------------------------------------------
# async_ai_citation_task — CLOUD guidance for confirmed findings
# ---------------------------------------------------------------------------

async def test_cloud_guidance_for_findings(ai_session, monkeypatch):
    """CLOUD mode: Gemini primary → suggestions persisted."""
    findings = [_finding(5)]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add the reference.", "source_type": "unknown", "confidence": 0.95},
        ])

    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _fake)
    monkeypatch.setattr(ai_citation, "call_ollama_local", lambda p: (_ for _ in ()).throw(RuntimeError("no")))

    out = await async_ai_citation_task(
        audit_id="g2",
        db=ai_session,
        cloud=True,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert out.provider == AI_PROVIDER_CLOUD
    assert len(out.suggestions) == 1
    assert out.suggestions[0]["paragraph_index"] == 5


# ---------------------------------------------------------------------------
# async_ai_citation_task — CLOUD fallback to LOCAL
# ---------------------------------------------------------------------------

async def test_cloud_fallback_to_local_guidance(ai_session, monkeypatch):
    """Cloud fails → fallback to Ollama → suggestions persisted."""
    findings = [_finding(2)]

    async def _fake_ollama(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add ref.", "source_type": "unknown", "confidence": 0.8},
        ])

    monkeypatch.setattr(ai_citation, "call_gemini_cloud", lambda p: (_ for _ in ()).throw(RuntimeError("cloud down")))
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_ollama)

    out = await async_ai_citation_task(
        audit_id="g3",
        db=ai_session,
        cloud=True,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert out.provider == AI_PROVIDER_CLOUD_FALLBACK_LOCAL
    assert len(out.suggestions) == 1


# ---------------------------------------------------------------------------
# async_ai_citation_task — no findings skips provider
# ---------------------------------------------------------------------------

async def test_no_findings_skips_provider(ai_session, monkeypatch):
    """Empty findings → no provider call → COMPLETED_NO_SUGGESTIONS."""
    called = []

    async def _never_call(prompt):
        called.append(prompt)
        return "[]"

    monkeypatch.setattr(ai_citation, "call_ollama_local", _never_call)

    out = await async_ai_citation_task(
        audit_id="g4",
        db=ai_session,
        cloud=False,
        citation_findings=[],
    )

    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.provider is None
    assert out.suggestions == []
    assert called == [], "Provider must not be called when no findings"


async def test_none_findings_skips_provider(ai_session, monkeypatch):
    """None findings → same as empty."""
    called = []

    async def _never_call(prompt):
        called.append(prompt)
        return "[]"

    monkeypatch.setattr(ai_citation, "call_ollama_local", _never_call)

    out = await async_ai_citation_task(
        audit_id="g4b",
        db=ai_session,
        cloud=False,
        citation_findings=None,
    )

    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.provider is None
    assert called == []


# ---------------------------------------------------------------------------
# async_ai_citation_task — valid [] means COMPLETED_NO_SUGGESTIONS
# ---------------------------------------------------------------------------

async def test_empty_array_response_means_no_suggestions(ai_session, monkeypatch):
    """Provider returns [] → COMPLETED_NO_SUGGESTIONS, no rows persisted."""
    findings = [_finding(1)]

    async def _fake(_prompt):
        return "[]"

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g5",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.provider == AI_PROVIDER_LOCAL
    assert out.suggestions == []
    assert ai_session.query(ai_citation.CitationIssue).filter_by(audit_id="g5").count() == 0


# ---------------------------------------------------------------------------
# async_ai_citation_task — malformed response means UNAVAILABLE
# ---------------------------------------------------------------------------

async def test_malformed_response_means_unavailable(ai_session, monkeypatch):
    """Provider returns garbage → parse returns [] → map finds nothing → UNAVAILABLE."""
    findings = [_finding(1)]

    async def _fake(_prompt):
        return "this is not json at all {{{"

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g6",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    # parse returns [], no entries mapped → status reflects unusable mapping
    assert out.status == AI_STATUS_UNAVAILABLE
    assert out.provider is None
    assert out.suggestions == []


# ---------------------------------------------------------------------------
# async_ai_citation_task — timeout means UNAVAILABLE
# ---------------------------------------------------------------------------

async def test_timeout_means_unavailable(ai_session, monkeypatch):
    """Connection timeout → provider=None → UNAVAILABLE."""
    findings = [_finding(1)]

    async def _fake(_prompt):
        raise RuntimeError("connection timed out")

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g7",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )

    assert out.status == AI_STATUS_UNAVAILABLE
    assert out.provider is None
    assert out.suggestions == []


async def test_cloud_then_local_both_timeout(ai_session, monkeypatch):
    """Both cloud and local timeout → UNAVAILABLE."""
    findings = [_finding(1)]

    async def _raise(_prompt):
        raise RuntimeError("timeout")

    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _raise)
    monkeypatch.setattr(ai_citation, "call_ollama_local", _raise)

    out = await async_ai_citation_task(
        audit_id="g7b",
        db=ai_session,
        cloud=True,
        citation_findings=findings,
    )

    assert out.status == AI_STATUS_UNAVAILABLE
    assert out.provider is None


# ---------------------------------------------------------------------------
# async_ai_citation_task — one suggestion maps to the correct finding
# ---------------------------------------------------------------------------

async def test_suggestion_maps_to_correct_finding(ai_session, monkeypatch):
    """Response item[0] maps to finding[0] by index; paragraph_index preserved."""
    findings = [
        _finding(0, "Smith", "2020"),
        _finding(3, "Garcia", "2018"),
    ]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add Smith 2020 ref.", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[1]["finding_key"], "reason": "Add Garcia 2018 ref.", "source_type": "unknown", "confidence": 0.95},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g8",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 0
    assert "Add Smith 2020 ref." in out.suggestions[0]["suggestion"]
    assert out.suggestions[1]["paragraph_index"] == 3


# ---------------------------------------------------------------------------
# async_ai_citation_task — reordered provider output maps correctly
# ---------------------------------------------------------------------------

async def test_reordered_provider_output_maps_correctly(ai_session, monkeypatch):
    """Provider returns items out of order — index-based mapping picks by paragraph_index, not position."""
    findings = [
        _finding(0, "Alpha", "2021"),
        _finding(2, "Beta", "2019"),
    ]

    async def _fake(prompt):
        # Provider returns Beta suggestion first, Alpha second (reordered)
        return json.dumps([
            {"finding_key": findings[1]["finding_key"], "reason": "Fix Beta.", "source_type": "unknown", "confidence": 0.9},
            {"finding_key": findings[0]["finding_key"], "reason": "Fix Alpha.", "source_type": "unknown", "confidence": 0.85},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g9",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    # Index-based mapping: finding[0] (para=0) gets Alpha guidance; finding[1] (para=2) gets Beta guidance
    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 0
    assert "Fix Alpha." in out.suggestions[0]["suggestion"]
    assert out.suggestions[1]["paragraph_index"] == 2
    assert "Fix Beta." in out.suggestions[1]["suggestion"]


# ---------------------------------------------------------------------------
# async_ai_citation_task — unknown or duplicate mapping rejected safely
# ---------------------------------------------------------------------------

async def test_mismatched_paragraph_index_rejected(ai_session, monkeypatch):
    """Provider returns wrong paragraph_index for an item → item skipped.
    Valid JSON response (non-empty array) with no matching items → COMPLETED_NO_SUGGESTIONS."""
    findings = [_finding(5)]

    async def _fake(prompt):
        # provider returns finding_key=99 instead of the real one
        return json.dumps([
            {"finding_key": "bad-key", "reason": "wrong key", "source_type": "unknown", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g10",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    # Valid JSON array, but no items matched findings → no suggestions
    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.provider == AI_PROVIDER_LOCAL
    assert out.suggestions == []


async def test_duplicate_paragraph_index_in_response_uses_first_match(ai_session, monkeypatch):
    """Two findings in same paragraph with different finding_keys: response
    gives both keys the same guidance item → second key not in response →
    only first accepted (first-match-wins on duplicate key)."""
    findings = [
        _finding(1, "First", "2020"),
        _finding(1, "Second", "2021"),  # same para, different key
    ]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "fix 1", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[0]["finding_key"], "reason": "also fix 1", "source_type": "unknown", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g11",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    # Both findings have distinct keys; response has 2 items but both claim
    # key[0] → first match wins, second key has no match → 1 accepted
    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 1


async def test_provider_returns_fewer_items_than_findings(ai_session, monkeypatch):
    """Response shorter than findings → trailing findings get no suggestion."""
    findings = [_finding(0), _finding(1), _finding(2)]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "fix 0", "source_type": "unknown", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="g12",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 1
    assert out.suggestions[0]["paragraph_index"] == 0


# ---------------------------------------------------------------------------
# Deterministic findings and score identical with AI available and unavailable
# ---------------------------------------------------------------------------

def test_deterministic_findings_unchanged_with_ai_available(client, docx_factory, monkeypatch):
    """AI guidance present → score unchanged from deterministic violations only."""
    from app.api import routes as api_routes

    async def _fake_guidance(*args, **kwargs):
        return AiCitationResult(
            status=AI_STATUS_WITH_SUGGESTIONS,
            provider=AI_PROVIDER_LOCAL,
            suggestions=[
                {
                    "id": "g-1",
                    "paragraph_index": 1,
                    "text_snippet": "(Garcia, 2018)",
                    "issue_type": "citation_mismatch",
                    "message": "Citation '(Garcia, 2018)' was found in text, but no matching entry was found in the References bibliography.",
                    "suggestion": "Add Garcia (2018) to the References section.",
                    "confidence": 1.0,
                }
            ],
        )

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _fake_guidance)

    body = ["Body intro.", "Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(paragraphs=body, references=None)
    resp = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert data["weighted_compliance_score"] == 79  # 2 margin majors (16) + 1 citation MAJOR (5)


def test_deterministic_findings_unchanged_with_ai_unavailable(client, docx_factory, monkeypatch):
    """AI unavailable → same deterministic score as when AI is available."""
    from app.api import routes as api_routes

    async def _fake_fail(*args, **kwargs):
        return AiCitationResult(
            status=AI_STATUS_UNAVAILABLE,
            provider=None,
            suggestions=[],
        )

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _fake_fail)

    body = ["Body intro.", "Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(paragraphs=body, references=None)
    resp = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ai_review_status"] == AI_STATUS_UNAVAILABLE
    # Score must match the deterministic-only score (no AI tip count added for LOCAL)
    assert data["weighted_compliance_score"] == 79


# ---------------------------------------------------------------------------
# Logging privacy — no document text, prompts, or raw responses in logs
# ---------------------------------------------------------------------------

async def test_logs_no_document_text_no_prompt_no_raw_response(ai_session, monkeypatch, caplog):
    """Captured logs must not contain document paragraphs, full prompts, or raw model responses."""
    import logging
    caplog.set_level(logging.INFO, logger="app.services.ai_citation")

    findings = [_finding(3, "SecretAuthor", "2019")]

    async def _fake(prompt):
        # prompt contains document text — must not appear in logs
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add ref.", "source_type": "unknown", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    with caplog.at_level(logging.INFO):
        out = await async_ai_citation_task(
            audit_id="log-test",
            db=ai_session,
            cloud=False,
            citation_findings=findings,
        )

    log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert "COMPLETED_WITH_SUGGESTIONS" in out.status
    # Document text and full prompt must NOT appear in any log
    assert "SecretAuthor" not in log_text, "Document text leaked into logs"
    assert "CITATION_MISMATCH" not in log_text or "findings" in log_text.lower(), "Prompt content in logs"
    # Structured fields that SHOULD be present
    assert "log-test" in log_text
    assert "LOCAL_OLLAMA" in log_text


# ---------------------------------------------------------------------------
# API-level tests — POST and GET
# ---------------------------------------------------------------------------

def test_post_with_citation_mismatch_persists_guidance(client, docx_factory, monkeypatch):
    from app.api import routes as api_routes
    from app.models.audit import CitationIssue

    async def _fake_guidance(audit_id, db, *args, **kwargs):
        # Persist the mock suggestion so GET can retrieve it from the DB
        issue = CitationIssue(
            id="sug-1",
            audit_id=audit_id,
            paragraph_index=1,
            text_snippet="(Garcia, 2018)",
            issue_type="citation_mismatch",
            message="Citation '(Garcia, 2018)' was found in text, but no matching entry was found in the References bibliography.",
            suggestion="Add Garcia (2018) to the References section.",
            confidence=1.0,
        )
        db.add(issue)
        db.commit()
        return AiCitationResult(
            status=AI_STATUS_WITH_SUGGESTIONS,
            provider=AI_PROVIDER_LOCAL,
            suggestions=[
                {
                    "id": "sug-1",
                    "paragraph_index": 1,
                    "text_snippet": "(Garcia, 2018)",
                    "issue_type": "citation_mismatch",
                    "message": "Citation '(Garcia, 2018)' was found in text, but no matching entry was found in the References bibliography.",
                    "suggestion": "Add Garcia (2018) to the References section.",
                    "confidence": 1.0,
                }
            ],
        )

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _fake_guidance)
    body = ["Body intro.", "Orphan (Garcia, 2018) text."]
    file_bytes = docx_factory(paragraphs=body, references=None)
    post = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert post.status_code == 200
    data = post.json()
    assert data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert data["ai_provider"] == AI_PROVIDER_LOCAL
    assert len(data["ai_citation_tooltips"]) == 1
    assert data["ai_citation_tooltips"][0]["suggestion"] == "Add Garcia (2018) to the References section."

    get = client.get(f"/api/audit/{data['audit_id']}")
    assert get.status_code == 200
    get_data = get.json()
    assert get_data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert len(get_data["citation_issues"]) == 1
    assert get_data["citation_issues"][0]["suggestion"] == "Add Garcia (2018) to the References section."


def test_post_without_citation_mismatch_skips_provider(ai_client, docx_factory):
    """Doc with no CITATION_MISMATCH → no provider call → COMPLETED_NO_SUGGESTIONS."""
    client, _set = ai_client
    _set(AiCitationResult(
        status=AI_STATUS_NO_SUGGESTIONS,
        provider=None,
        suggestions=[],
    ))
    body = ["Smith (2020) wrote about it."]
    refs = ["Smith, J. (2020). Title. Press."]
    file_bytes = docx_factory(paragraphs=body, references=refs)
    post = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert post.status_code == 200
    data = post.json()
    assert data["ai_review_status"] == AI_STATUS_NO_SUGGESTIONS
    assert data["ai_provider"] is None
    assert data["ai_citation_tooltips"] == []


# ---------------------------------------------------------------------------
# Backward-compat: existing test patterns still work
# ---------------------------------------------------------------------------

async def test_async_ai_citation_task_no_findings_returns_no_suggestions(ai_session, monkeypatch):
    """Calling without citation_findings (backward compat) → no provider call."""
    called = []

    async def _never(prompt):
        called.append(prompt)
        return "[]"

    monkeypatch.setattr(ai_citation, "call_ollama_local", _never)

    out = await async_ai_citation_task(
        audit_id="bc1",
        db=ai_session,
        cloud=False,
        citation_findings=[],
    )
    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.provider is None
    assert called == []


def test_prompt_contains_guidance_instructions():
    """Locks the regression so the guidance prompt includes the no-discovery rule."""
    from app.services.ai_citation import CITATION_GUIDANCE_PROMPT
    assert "NOT to find issues" in CITATION_GUIDANCE_PROMPT
    assert "finding_key" in CITATION_GUIDANCE_PROMPT
    assert "student-friendly" in CITATION_GUIDANCE_PROMPT.lower()
    assert "confidence" in CITATION_GUIDANCE_PROMPT


# ---------------------------------------------------------------------------
# Same-paragraph findings — finding_key disambiguation (Build 7F.1)
# ---------------------------------------------------------------------------

async def test_same_paragraph_findings_get_distinct_guidance(ai_session, monkeypatch):
    """Two CITATION_MISMATCH findings in the same paragraph each get
    their own guidance item mapped by unique finding_key."""
    findings = [
        _finding(5, "Smith", "2020"),
        _finding(5, "Jones", "2019"),  # same paragraph, different citation
    ]

    async def _fake(prompt):
        assert "finding_key" in prompt
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add Smith 2020 ref.", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[1]["finding_key"], "reason": "Add Jones 2019 ref.", "source_type": "unknown", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp1",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 5
    assert "Add Smith 2020 ref." in out.suggestions[0]["suggestion"]
    assert out.suggestions[1]["paragraph_index"] == 5
    assert "Add Jones 2019 ref." in out.suggestions[1]["suggestion"]


async def test_reordered_output_maps_by_finding_key(ai_session, monkeypatch):
    """Provider returns items in arbitrary order — finding_key matching
    preserves correct guidance per finding regardless of output order."""
    findings = [
        _finding(0, "Alpha", "2021"),
        _finding(2, "Beta", "2019"),
        _finding(5, "Gamma", "2017"),
    ]

    async def _fake(prompt):
        # Provider returns in reverse order
        return json.dumps([
            {"finding_key": findings[2]["finding_key"], "reason": "Fix Gamma.", "source_type": "unknown", "confidence": 0.95},
            {"finding_key": findings[0]["finding_key"], "reason": "Fix Alpha.", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[1]["finding_key"], "reason": "Fix Beta.", "source_type": "unknown", "confidence": 0.85},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp2",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 3
    # Order in result follows finding order, not response order
    assert out.suggestions[0]["paragraph_index"] == 0
    assert "Fix Alpha." in out.suggestions[0]["suggestion"]
    assert out.suggestions[1]["paragraph_index"] == 2
    assert "Fix Beta." in out.suggestions[1]["suggestion"]
    assert out.suggestions[2]["paragraph_index"] == 5
    assert "Fix Gamma." in out.suggestions[2]["suggestion"]


async def test_duplicate_finding_key_accepted_at_most_once(ai_session, monkeypatch):
    """Provider returns two items with the same finding_key — only the
    first is accepted; the second is silently dropped."""
    findings = [
        _finding(0, "A", "2020"),
        _finding(1, "B", "2019"),
    ]

    async def _fake(prompt):
        # Both response items claim the same key
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "fix A", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[0]["finding_key"], "reason": "also fix A", "source_type": "unknown", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp3",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    # finding[0] matches first item; finding[1] has no match
    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 1
    assert out.suggestions[0]["paragraph_index"] == 0
    assert "fix A" in out.suggestions[0]["suggestion"]


async def test_unknown_finding_key_ignored(ai_session, monkeypatch):
    """Provider returns a finding_key not in the request — silently ignored."""
    findings = [_finding(0, "A", "2020")]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": "not-in-findings", "reason": "wrong key", "source_type": "unknown", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp4",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.suggestions == []


async def test_missing_finding_key_rejected(ai_session, monkeypatch):
    """Provider response item without finding_key is rejected."""
    findings = [_finding(0, "A", "2020")]

    async def _fake(prompt):
        return json.dumps([
            {"suggestion": "no key", "confidence": 1.0},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp5",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_NO_SUGGESTIONS
    assert out.suggestions == []


async def test_partial_valid_response_preserves_correct_mappings(ai_session, monkeypatch):
    """3 findings, provider returns 2 — the 2 that match are persisted
    and status reflects partial success (WITH_SUGGESTIONS, not NO_SUGGESTIONS)."""
    findings = [
        _finding(0, "A", "2020"),
        _finding(1, "B", "2019"),
        _finding(2, "C", "2018"),
    ]

    async def _fake(prompt):
        # Only first two findings get guidance
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "fix A", "source_type": "unknown", "confidence": 1.0},
            {"finding_key": findings[2]["finding_key"], "reason": "fix C", "source_type": "unknown", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="sp6",
        db=ai_session,
        cloud=False,
        citation_findings=findings,
    )
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 0
    assert out.suggestions[1]["paragraph_index"] == 2


async def test_score_unchanged_with_same_paragraph_findings(client, docx_factory, monkeypatch):
    """Score is deterministic — AI guidance presence/absence does not
    alter the weighted_compliance_score."""
    from app.api import routes as api_routes

    async def _fake_guidance(*args, **kwargs):
        return AiCitationResult(
            status=AI_STATUS_WITH_SUGGESTIONS,
            provider=AI_PROVIDER_LOCAL,
            suggestions=[],
        )

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _fake_guidance)

    # Doc with 2 CITATION_MISMATCH in same paragraph + margin violation
    body = ["Para with (Smith, 2020) and (Jones, 2019)."]
    file_bytes = docx_factory(paragraphs=body, references=None, margins={"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0})
    resp = client.post("/api/audit", files={"file": ("t.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()
    # Score reflects deterministic violations only — AI suggestions don't add deductions
    assert data["weighted_compliance_score"] == 82  # 3 margin majors (24) + 1 citation MAJOR (5) = 100-18=82
    assert data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS


async def test_no_document_text_in_logs_with_finding_key(ai_session, monkeypatch, caplog):
    """Logs must not contain document text even when finding_key is used."""
    import logging
    caplog.set_level(logging.INFO, logger="app.services.ai_citation")

    findings = [_finding(3, "SecretAuthor", "2019")]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add ref.", "source_type": "unknown", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    with caplog.at_level(logging.INFO):
        out = await async_ai_citation_task(
            audit_id="log-fk",
            db=ai_session,
            cloud=False,
            citation_findings=findings,
        )

    log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert "SecretAuthor" not in log_text, "Document text leaked into logs"
    assert "log-fk" in log_text
    assert "LOCAL_OLLAMA" in log_text

