"""Tests for Local AI Citation Guidance privacy and loopback origin validation.

Verifies:
1. Pure loopback validator rejects all non-loopback, deceptive, and malformed origins.
2. When LOCAL_AI_ENABLED=False, route skips citation snippet construction and task dispatch.
3. When OLLAMA_HOST is unsafe/non-loopback, route skips citation snippet construction and task dispatch.
4. Valid loopback origins are accepted and dispatched.
5. Transport rejects HTTP redirects (follow_redirects=False).
6. Direct service invocation (async_ai_citation_task, call_ollama_local) enforces defense-in-depth.
7. Readiness probe rejects unsafe hosts without network probe.
8. Server logs never contain document snippets or configured remote hosts.
"""

import json
import logging
import pytest
import httpx
from unittest.mock import AsyncMock

from app.config import settings
from app.api import routes as api_routes
from app.services.loopback_validator import loopback_origin
from app.services import ai_citation
from app.services.ai_citation import (
    async_ai_citation_task,
    call_ollama_local,
    AiCitationResult,
    AI_STATUS_UNAVAILABLE,
    AI_STATUS_NO_SUGGESTIONS,
    AI_STATUS_WITH_SUGGESTIONS,
    AI_PROVIDER_LOCAL,
)
from app.services import setup_readiness as sr


# ---------------------------------------------------------------------------
# 1. Pure Loopback Origin Validator Matrix
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw_url, expected",
    [
        ("http://127.0.0.1:11434", "http://127.0.0.1:11434"),
        ("http://localhost:11434", "http://localhost:11434"),
        ("http://[::1]:11434", "http://[::1]:11434"),
        ("http://127.0.0.1:11434/", "http://127.0.0.1:11434"),
        ("http://localhost:11434/", "http://localhost:11434"),
        ("  http://127.0.0.1:11434  ", "http://127.0.0.1:11434"),
        ("http://127.0.0.1", "http://127.0.0.1:80"),
        ("http://localhost", "http://localhost:80"),
        ("http://[::1]", "http://[::1]:80"),
    ],
)
def test_loopback_validator_accepts_valid_origins(raw_url, expected):
    assert loopback_origin(raw_url) == expected


@pytest.mark.parametrize(
    "raw_url",
    [
        "http://192.168.1.50:11434",
        "http://evil.com",
        "http://evil.com:11434",
        "http://localhost.evil.com",
        "http://localhost.evil.com:11434",
        "http://user:pass@127.0.0.1:11434",
        "http://user@localhost:11434",
        "http://127.0.0.1:11434/api",
        "http://127.0.0.1:11434/api/generate",
        "http://127.0.0.1:11434?query=1",
        "http://localhost:11434#fragment",
        "http://0.0.0.0:11434",
        "https://127.0.0.1:11434",
        "https://localhost:11434",
        "ftp://127.0.0.1:11434",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:-1",
        "http://127.0.0.1:notaport",
        "",
        "   ",
        None,
    ],
)
def test_loopback_validator_rejects_unsafe_or_invalid_origins(raw_url):
    assert loopback_origin(raw_url) is None


# ---------------------------------------------------------------------------
# 2. Route Layer Gating — Disabled Local AI
# ---------------------------------------------------------------------------

def test_disabled_local_ai_skips_task_and_snippet_construction(client, docx_factory, monkeypatch):
    """When LOCAL_AI_ENABLED=False, snippets are never constructed and task is not called."""
    task_calls = []

    async def _spy_task(*args, **kwargs):
        task_calls.append(kwargs)
        return AiCitationResult(status=AI_STATUS_NO_SUGGESTIONS, provider=None, suggestions=[])

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _spy_task)
    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", False)

    file_bytes = docx_factory(
        paragraphs=[
            "Intro text citing (Garcia, 2018).",
            "References",
            "Smith, J. (2020). Book title.",
        ]
    )

    resp = client.post("/api/audit", files={"file": ("test.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()

    assert len(task_calls) == 0, "async_ai_citation_task must not be called when LOCAL_AI_ENABLED=False"
    assert data["ai_review_status"] is None
    assert data["ai_provider"] is None
    assert data["ai_citation_tooltips"] == []
    # Deterministic audit completed normally
    assert data["status"] == "Success"
    assert data["weighted_compliance_score"] is not None


# ---------------------------------------------------------------------------
# 3. Route Layer Gating — Unsafe/Non-Loopback Host
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "unsafe_host",
    [
        "http://192.168.1.50:11434",
        "http://evil.com",
        "http://localhost.evil.com",
        "http://user:pass@127.0.0.1:11434",
        "http://127.0.0.1:11434/api",
    ],
)
def test_unsafe_host_rejected_before_dispatch(client, docx_factory, monkeypatch, unsafe_host):
    """When OLLAMA_HOST is unsafe, task is not dispatched and status is UNAVAILABLE."""
    task_calls = []

    async def _spy_task(*args, **kwargs):
        task_calls.append(kwargs)
        return AiCitationResult(status=AI_STATUS_NO_SUGGESTIONS, provider=None, suggestions=[])

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _spy_task)
    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", True)
    monkeypatch.setattr(settings, "OLLAMA_HOST", unsafe_host)

    file_bytes = docx_factory(
        paragraphs=[
            "Intro text citing (Garcia, 2018).",
            "References",
            "Smith, J. (2020). Book title.",
        ]
    )

    resp = client.post("/api/audit", files={"file": ("test.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()

    assert len(task_calls) == 0, "async_ai_citation_task must not be dispatched when host is unsafe"
    assert data["ai_review_status"] == AI_STATUS_UNAVAILABLE
    assert data["ai_provider"] is None
    assert data["ai_citation_tooltips"] == []
    assert data["status"] == "Success"


# ---------------------------------------------------------------------------
# 4. Route Layer — Valid Loopback Host Dispatched
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "valid_host",
    [
        "http://127.0.0.1:11434",
        "http://localhost:11434",
        "http://[::1]:11434",
        "http://127.0.0.1:11434/",
    ],
)
def test_valid_loopback_hosts_accepted(client, docx_factory, monkeypatch, valid_host):
    """When LOCAL_AI_ENABLED=True and host is valid loopback, task is dispatched."""
    task_calls = []

    async def _spy_task(*args, **kwargs):
        task_calls.append(kwargs)
        return AiCitationResult(
            status=AI_STATUS_WITH_SUGGESTIONS,
            provider=AI_PROVIDER_LOCAL,
            suggestions=[
                {
                    "id": "ci-1",
                    "paragraph_index": 0,
                    "issue_type": "citation_mismatch",
                    "text_snippet": "(Garcia, 2018)",
                    "message": "Missing reference entry",
                    "suggestion": "Add Garcia (2018) to the References section.",
                    "confidence": 0.9,
                },
            ],
        )

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _spy_task)
    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", True)
    monkeypatch.setattr(settings, "OLLAMA_HOST", valid_host)

    file_bytes = docx_factory(
        paragraphs=[
            "Intro text citing (Garcia, 2018).",
            "References",
            "Smith, J. (2020). Book title.",
        ]
    )

    resp = client.post("/api/audit", files={"file": ("test.docx", file_bytes, "application/octet-stream")})
    assert resp.status_code == 200
    data = resp.json()

    assert len(task_calls) == 1, "async_ai_citation_task must be dispatched for valid loopback host"
    assert data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert data["ai_provider"] == AI_PROVIDER_LOCAL
    assert len(data["ai_citation_tooltips"]) == 1


# ---------------------------------------------------------------------------
# 5. Transport Security — Redirects Rejected & Origin Check
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_call_ollama_local_rejects_unsafe_host_without_transport(monkeypatch):
    """call_ollama_local raises before any HTTP client call if host is non-loopback."""
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://evil.com:11434")

    with pytest.raises(RuntimeError, match="Refusing Ollama call: host is not a verified loopback origin"):
        await call_ollama_local("test prompt")


@pytest.mark.asyncio
async def test_transport_rejects_redirects(monkeypatch):
    """Transport fails closed on HTTP 3xx redirect and does not follow it."""
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://127.0.0.1:11434")

    # Mock transport returning a 302 redirect to external server
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=302,
            headers={"Location": "http://evil.com/leak"},
            content=b"",
            request=request,
        )

    transport = httpx.MockTransport(handler)

    # Patch httpx.AsyncClient to use our mock transport while preserving follow_redirects=False
    original_async_client = httpx.AsyncClient

    def mock_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return original_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", mock_async_client)

    with pytest.raises(RuntimeError, match="Ollama HTTP transport failed: HTTPStatusError"):
        await call_ollama_local("test prompt")


# ---------------------------------------------------------------------------
# 6. Service Layer Direct Call Defense-in-Depth
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_service_layer_direct_call_defense_in_depth(monkeypatch):
    """Direct calls to async_ai_citation_task fail closed when disabled or host is unsafe."""
    findings = [
        {
            "finding_key": "fk-1",
            "paragraph_index": 0,
            "rule_code": "CITATION_MISMATCH",
            "severity": "MAJOR",
            "snippet": "Garcia (2018)",
            "message": "Missing reference",
            "expected_value": "Garcia",
            "actual_value": "Garcia (2018)",
        }
    ]

    # Subtest A: LOCAL_AI_ENABLED=False
    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", False)
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://127.0.0.1:11434")
    out = await async_ai_citation_task(audit_id="direct-1", db=None, citation_findings=findings)
    assert out.status == AI_STATUS_UNAVAILABLE
    assert out.provider is None
    assert out.suggestions == []

    # Subtest B: LOCAL_AI_ENABLED=True but unsafe host
    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", True)
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://192.168.1.100:11434")
    out = await async_ai_citation_task(audit_id="direct-2", db=None, citation_findings=findings)
    assert out.status == AI_STATUS_UNAVAILABLE
    assert out.provider is None
    assert out.suggestions == []


# ---------------------------------------------------------------------------
# 7. Readiness Probe Loopback Gating
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_readiness_probe_rejects_unsafe_host_without_network(monkeypatch):
    """_default_fetch_ollama_models raises immediately if host is non-loopback."""
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://evil.com:11434")

    with pytest.raises(RuntimeError, match="Refusing Ollama probe: host is not a verified loopback origin"):
        await sr._default_fetch_ollama_models()


# ---------------------------------------------------------------------------
# 8. Privacy: Zero Document Text or Configured Host Leakage in Logs
# ---------------------------------------------------------------------------

def test_no_snippet_or_host_in_logs(client, docx_factory, monkeypatch, caplog):
    """Ensure logs never contain citation snippets or configured remote host."""
    remote_host = "http://malicious-external-host.example.com:11434"
    secret_snippet = "Confidential Author (2024)"

    monkeypatch.setattr(settings, "LOCAL_AI_ENABLED", True)
    monkeypatch.setattr(settings, "OLLAMA_HOST", remote_host)

    file_bytes = docx_factory(
        paragraphs=[
            f"Intro text with {secret_snippet}.",
            "References",
            "Smith, J. (2020). Book title.",
        ]
    )

    with caplog.at_level(logging.DEBUG):
        resp = client.post("/api/audit", files={"file": ("secret.docx", file_bytes, "application/octet-stream")})

    assert resp.status_code == 200
    for record in caplog.records:
        assert secret_snippet not in record.message, f"Secret snippet leaked into log: {record.message}"
        assert "malicious-external-host" not in record.message, f"Remote host leaked into log: {record.message}"
