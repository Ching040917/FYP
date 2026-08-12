"""Tests for AI-assisted citation review execution status (Build 7D).

Covers:
- provider path tracking (LOCAL / CLOUD / CLOUD_FALLBACK_LOCAL);
- completed-with-suggestions vs completed-no-suggestions vs unavailable;
- persistence of AI metadata from POST to GET;
- historical NULL metadata (status not recorded);
- migration upgrade / downgrade / re-upgrade on a temporary database.

No external requests are made: provider functions are monkeypatched and the
migration runs against a temporary SQLite file, never backend/audit.db.
"""
import asyncio
from pathlib import Path

import pytest

from app.api import routes as api_routes
from app.services import ai_citation
from app.services.ai_citation import (
    AiCitationResult,
    async_ai_citation_task,
    AI_STATUS_WITH_SUGGESTIONS,
    AI_STATUS_NO_SUGGESTIONS,
    AI_STATUS_UNAVAILABLE,
    AI_PROVIDER_LOCAL,
    AI_PROVIDER_CLOUD,
    AI_PROVIDER_CLOUD_FALLBACK_LOCAL,
)

OK_ISSUE_JSON = ('[{"finding_key": "fk-0", "reason": "Add the reference entry for the cited source.", '
                  '"source_type": "unknown", "confidence": 0.9}]')


async def _fake_ok(_prompt: str) -> str:
    return OK_ISSUE_JSON


async def _fake_empty(_prompt: str) -> str:
    return "[]"


async def _fake_fail(_prompt: str) -> str:
    raise RuntimeError("provider unreachable")


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
# Unit-level execution status (providers mocked, no network)
# ---------------------------------------------------------------------------

def test_local_with_suggestions(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_ok)
    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _fake_fail)
    result = asyncio.run(async_ai_citation_task(audit_id="a1", db=ai_session, cloud=False, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_WITH_SUGGESTIONS
    assert result.provider == AI_PROVIDER_LOCAL
    assert len(result.suggestions) == 1
    assert result.suggestions[0]["issue_type"] == "citation_mismatch"
    assert ai_session.query(ai_citation.CitationIssue).count() == 1


def test_local_completed_no_suggestions(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_empty)
    result = asyncio.run(async_ai_citation_task(audit_id="a2", db=ai_session, cloud=False, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_NO_SUGGESTIONS
    assert result.provider == AI_PROVIDER_LOCAL
    assert result.suggestions == []
    assert ai_session.query(ai_citation.CitationIssue).count() == 0


def test_local_unavailable(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_fail)
    result = asyncio.run(async_ai_citation_task(audit_id="a3", db=ai_session, cloud=False, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_UNAVAILABLE
    assert result.provider is None
    assert result.suggestions == []
    assert ai_session.query(ai_citation.CitationIssue).count() == 0


def test_cloud_gemini_success(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _fake_ok)
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_fail)
    result = asyncio.run(async_ai_citation_task(audit_id="a4", db=ai_session, cloud=True, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_WITH_SUGGESTIONS
    assert result.provider == AI_PROVIDER_CLOUD
    assert len(result.suggestions) == 1


def test_cloud_fallback_to_local(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _fake_fail)
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_empty)
    result = asyncio.run(async_ai_citation_task(audit_id="a5", db=ai_session, cloud=True, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_NO_SUGGESTIONS
    assert result.provider == AI_PROVIDER_CLOUD_FALLBACK_LOCAL
    assert result.suggestions == []


def test_cloud_and_local_both_unavailable(ai_session, monkeypatch):
    monkeypatch.setattr(ai_citation, "call_gemini_cloud", _fake_fail)
    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake_fail)
    result = asyncio.run(async_ai_citation_task(audit_id="a6", db=ai_session, cloud=True, citation_findings=[{"finding_key": "fk-0", "paragraph_index": 0, "rule_code": "CITATION_MISMATCH", "severity": "MAJOR", "snippet": "Smith (2022)", "message": "No References entry.", "expected_value": "Reference entry for Smith", "actual_value": "Smith (2022)"}]))
    assert result.status == AI_STATUS_UNAVAILABLE
    assert result.provider is None
    assert result.suggestions == []
    assert ai_session.query(ai_citation.CitationIssue).count() == 0


# ---------------------------------------------------------------------------
# API-level persistence (POST → GET)
# ---------------------------------------------------------------------------

def test_post_get_persists_ai_metadata(ai_client, docx_factory):
    client, _set = ai_client
    _set(AiCitationResult(status=AI_STATUS_WITH_SUGGESTIONS, provider=AI_PROVIDER_LOCAL, suggestions=[]))
    post = client.post("/api/audit", files={"file": ("t.docx", docx_factory(paragraphs=["Body text"]), "application/octet-stream")})
    assert post.status_code == 200
    body = post.json()
    assert body["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert body["ai_provider"] == AI_PROVIDER_LOCAL
    assert isinstance(body["ai_citation_tooltips"], list)

    get = client.get(f"/api/audit/{body['audit_id']}")
    assert get.status_code == 200
    assert get.json()["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert get.json()["ai_provider"] == AI_PROVIDER_LOCAL


def test_post_cloud_metadata(ai_client, docx_factory):
    client, _set = ai_client
    _set(AiCitationResult(status=AI_STATUS_NO_SUGGESTIONS, provider=AI_PROVIDER_CLOUD_FALLBACK_LOCAL, suggestions=[]))
    post = client.post("/api/audit?cloud=1", files={"file": ("c.docx", docx_factory(paragraphs=["Body text"]), "application/octet-stream")})
    assert post.status_code == 200
    body = post.json()
    assert body["ai_review_status"] == AI_STATUS_NO_SUGGESTIONS
    assert body["ai_provider"] == AI_PROVIDER_CLOUD_FALLBACK_LOCAL

    get = client.get(f"/api/audit/{body['audit_id']}")
    assert get.status_code == 200
    assert get.json()["deploy_mode"] == "CLOUD"


def test_unavailable_keeps_deterministic_results(ai_client, docx_factory):
    client, _set = ai_client
    _set(AiCitationResult(status=AI_STATUS_UNAVAILABLE, provider=None, suggestions=[]))
    post = client.post("/api/audit", files={"file": ("u.docx", docx_factory(paragraphs=["Body text"]), "application/octet-stream")})
    assert post.status_code == 200
    body = post.json()
    assert body["ai_review_status"] == AI_STATUS_UNAVAILABLE
    assert body["ai_provider"] is None
    assert body["ai_citation_tooltips"] == []
    assert body["weighted_compliance_score"] >= 0
    assert isinstance(body["physical_layout_errors"], list)


def test_historical_null_metadata_is_null(client, test_engine, docx_factory):
    """A record with no AI metadata must surface nulls — never a guessed value."""
    from sqlalchemy.orm import sessionmaker
    from app.models.audit import AuditRecord
    Session = sessionmaker(bind=test_engine)
    s = Session()
    rec = AuditRecord(id="hist-0001", filename="old.docx", file_size=10, weighted_score=90,
                      deploy_mode="LOCAL", status="completed")
    s.add(rec)
    s.commit()
    s.close()

    get = client.get("/api/audit/hist-0001")
    assert get.status_code == 200
    body = get.json()
    assert body["ai_review_status"] is None
    assert body["ai_provider"] is None


# ---------------------------------------------------------------------------
# Migration upgrade / downgrade / re-upgrade on a temporary database
# ---------------------------------------------------------------------------

def test_migration_roundtrip(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    from app.config import settings as app_settings

    db_path = tmp_path / "mig.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]

    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))

    def _columns():
        return {c["name"] for c in inspect(create_engine(url)).get_columns("audit_records")}

    # env.py reads settings.DATABASE_URL; point it at the temp DB for this test.
    monkeypatch.setattr(app_settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    cols = _columns()
    assert "ai_review_status" in cols
    assert "ai_provider" in cols

    command.downgrade(cfg, "a4c7d19e2b3f")
    cols = _columns()
    assert "ai_review_status" not in cols
    assert "ai_provider" not in cols

    command.upgrade(cfg, "head")
    cols = _columns()
    assert "ai_review_status" in cols
    assert "ai_provider" in cols
