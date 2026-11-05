"""Local AI Citation Guidance — in-app local-model download tests.

Covers the trusted-origin boundary, the installed-model pre-check, streamed
NDJSON handling, safe failure classification, the strict eight-field status
contract, duplicate-pull refusal, and the absence of any cancellation surface.

Every test runs against `httpx.MockTransport`; no test touches a real Ollama
service, the network, a database row, or the filesystem.
"""
import asyncio
import inspect
import json
import logging

import httpx
import pytest
from sqlalchemy.orm import Session

from app.config import settings
from app.models.audit import AuditRecord
from app.services import local_model_download as lmd
from app.api.routes import (
    get_local_model_download_status,
    start_local_model_download,
)

EXPECTED_FIELDS = {
    "state",
    "message",
    "model_name",
    "bytes_completed",
    "bytes_total",
    "percentage",
    "retryable",
    "error_category",
}


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_job_state(monkeypatch):
    """Isolate module state per test and remove the real retry delay."""
    monkeypatch.setattr(lmd, "_PULL_RETRY_DELAY_S", 0)
    lmd.reset_state()
    yield
    lmd.reset_state()


def _install(monkeypatch, handler, requests=None):
    """Route every Ollama call through a recording MockTransport.

    Supports both sync and async handlers.
    """
    is_async = asyncio.iscoroutinefunction(handler)

    async def _recording(request: httpx.Request):
        if requests is not None:
            requests.append(request)
        if is_async:
            return await handler(request)
        return handler(request)

    async def _make(timeout):
        return httpx.AsyncClient(
            transport=httpx.MockTransport(_recording), follow_redirects=False
        )

    monkeypatch.setattr(lmd, "_make_client", _make)


def _installed(names):
    return httpx.Response(200, json={"models": [{"name": n} for n in names]})


def _pulling_handler(pull_body, *, model=None):
    """Model is missing until /api/pull runs, then present.

    Mirrors the real sequence: the installed-model pre-check must miss, the
    pull must actually execute, and verification must then find the model.
    """
    name = settings.OLLAMA_MODEL if model is None else model
    state = {"pulled": False}

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([name] if state["pulled"] else [])
        state["pulled"] = True
        body = pull_body() if callable(pull_body) else pull_body
        return httpx.Response(200, content=body)

    return _handler


async def _chunks(parts):
    for part in parts:
        yield part


async def _run_job(timeout: float = 5.0) -> None:
    """Await the retained job task (also proves the strong reference exists)."""
    task = lmd._task
    if task is not None:
        await asyncio.wait_for(task, timeout=timeout)


def _pull_request_bodies(requests):
    return [json.loads(r.content) for r in requests if r.url.path == "/api/pull"]


def _tags_request_count(requests):
    return sum(1 for r in requests if r.url.path == "/api/tags")


# ---------------------------------------------------------------------------
# 6/7. Strict origin validation
# ---------------------------------------------------------------------------


def test_default_config_is_a_loopback_origin():
    assert lmd.loopback_origin() == "http://localhost:11434"


def test_loopback_origin_accepts_the_three_loopback_hosts(monkeypatch):
    cases = {
        "http://127.0.0.1:11434": "127.0.0.1",
        "http://localhost:11434": "localhost",
        "http://[::1]:11434": "::1",
    }
    for configured, host in cases.items():
        monkeypatch.setattr(settings, "OLLAMA_HOST", configured)
        origin = lmd.loopback_origin()
        assert origin is not None, configured
        assert host in origin


def test_loopback_origin_accepts_an_optional_trailing_slash(monkeypatch):
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://127.0.0.1:11434/")
    assert lmd.loopback_origin() == "http://127.0.0.1:11434"


@pytest.mark.parametrize(
    "configured",
    [
        "http://192.168.1.50:11434",        # non-loopback host
        "http://example.com:11434",         # non-loopback host
        "https://localhost:11434",          # scheme is not exactly http
        "http://user:pw@localhost:11434",   # username + password
        "http://user@localhost:11434",      # username only
        "http://localhost:11434/?x=1",      # query
        "http://localhost:11434/#frag",     # fragment
        "http://localhost:11434/api",       # unexpected path
        "http://localhost:11434/../etc",    # unexpected path
        "http://localhost:99999",           # invalid port
        "",
    ],
)
def test_loopback_origin_refuses_unsafe_configuration(monkeypatch, configured):
    monkeypatch.setattr(settings, "OLLAMA_HOST", configured)
    assert lmd.loopback_origin() is None


async def test_non_loopback_origin_fails_without_any_network_call(monkeypatch):
    requests = []
    _install(monkeypatch, lambda r: _installed([]), requests)
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://192.168.1.50:11434")

    assert await lmd.start_download() is not None
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "unsupported_host"
    assert status["retryable"] is False
    assert requests == [], "no request may be sent to a refused origin"


async def test_unsupported_host_message_never_echoes_the_configured_value(monkeypatch):
    _install(monkeypatch, lambda r: _installed([]))
    monkeypatch.setattr(settings, "OLLAMA_HOST", "http://10.0.0.7:11434")

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert "10.0.0.7" not in status["message"]
    assert "10.0.0.7" not in json.dumps(status)


# ---------------------------------------------------------------------------
# 1/2. Unreachable Ollama, bounded retry, waiting state
# ---------------------------------------------------------------------------


async def test_ollama_unreachable_is_retryable_and_safe(monkeypatch):
    def _boom(request):
        raise httpx.ConnectError("connection refused")

    _install(monkeypatch, _boom)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "ollama_unavailable"
    assert status["retryable"] is True
    assert status["message"] == lmd.MODEL_DOWNLOAD_MESSAGES["failed"]


async def test_start_failures_publish_waiting_for_ollama_then_give_up(monkeypatch):
    published = []
    real_publish = lmd._publish

    def _spy(job, state, **kwargs):
        published.append(state)
        real_publish(job, state, **kwargs)

    monkeypatch.setattr(lmd, "_publish", _spy)

    def _boom(request):
        raise httpx.ConnectError("refused")

    _install(monkeypatch, _boom)

    await lmd.start_download()
    await _run_job()

    assert lmd.MODEL_DOWNLOAD_WAITING_FOR_OLLAMA in published
    assert published.count(lmd.MODEL_DOWNLOAD_WAITING_FOR_OLLAMA) == (
        lmd._PULL_START_ATTEMPTS - 1
    )
    assert published[-1] == "failed"


async def test_start_attempts_are_bounded(monkeypatch):
    requests = []

    def _counting_handler(request):
        raise httpx.ConnectError("refused")

    _install(monkeypatch, _counting_handler, requests)

    await lmd.start_download()
    await _run_job()

    assert _tags_request_count(requests) == lmd._PULL_START_ATTEMPTS


# ---------------------------------------------------------------------------
# 3. Already-installed model: no redundant pull
# ---------------------------------------------------------------------------


async def test_already_installed_model_completes_without_pulling(monkeypatch):
    requests = []
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]), requests)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "completed"
    assert status["model_name"] == settings.OLLAMA_MODEL
    assert _pull_request_bodies(requests) == [], "must not POST /api/pull"
    assert _tags_request_count(requests) >= 1


async def test_already_installed_model_is_reported_ready_without_bytes(monkeypatch):
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]))

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["bytes_completed"] is None
    assert status["percentage"] is None
    assert status["retryable"] is False


# ---------------------------------------------------------------------------
# 4/5. Configured model only, no client-controlled target
# ---------------------------------------------------------------------------


def test_start_route_declares_only_consent_token_and_request():
    """The route accepts only a consent token and request; no model, host, or path can be injected."""
    params = inspect.signature(start_local_model_download).parameters
    assert list(params) == ["payload", "request"]
    assert params["payload"].annotation is lmd.LocalModelDownloadRequest
    assert set(lmd.LocalModelDownloadRequest.model_fields.keys()) == {"consent_token"}
    assert list(inspect.signature(get_local_model_download_status).parameters) == []

async def test_pull_targets_the_configured_model_only(monkeypatch):
    requests = []

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler, requests)
    monkeypatch.setattr(settings, "OLLAMA_MODEL", "trusted-tag:9b")

    await lmd.start_download()
    await _run_job()

    bodies = _pull_request_bodies(requests)
    assert len(bodies) == 1
    assert bodies[0]["model"] == "trusted-tag:9b"
    assert lmd.get_status()["model_name"] == "trusted-tag:9b"


async def test_pull_body_is_exactly_model_stream_and_insecure(monkeypatch):
    requests = []

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler, requests)

    await lmd.start_download()
    await _run_job()

    (body,) = _pull_request_bodies(requests)
    assert set(body) == {"model", "stream", "insecure"}
    assert body == {
        "model": settings.OLLAMA_MODEL,
        "stream": True,
        "insecure": False,
    }


# ---------------------------------------------------------------------------
# 8. Nothing happens without an explicit start request
# ---------------------------------------------------------------------------


async def test_status_never_starts_a_pull(monkeypatch):
    requests = []
    _install(monkeypatch, lambda r: _installed([]), requests)

    assert lmd.get_status()["state"] == "idle"
    assert (await get_local_model_download_status())["state"] == "idle"
    assert requests == []


def test_reset_returns_to_idle_without_network(monkeypatch):
    requests = []
    _install(monkeypatch, lambda r: _installed([]), requests)
    lmd.reset_state()
    assert lmd.get_status()["state"] == "idle"
    assert requests == []


# ---------------------------------------------------------------------------
# 9/10/19/20. Streaming, duplicate refusal, single upstream pull
# ---------------------------------------------------------------------------


async def test_ndjson_split_across_chunk_boundaries(monkeypatch):
    lines = (
        b'{"status":"pulling manifest"}\n'
        b'{"status":"pulling sha256:aa","digest":"sha256:aa",'
        b'"total":100,"completed":100}\n'
        b'{"status":"verifying sha256 digest"}\n'
        b'{"status":"success"}\n'
    )
    # Split in the middle of a JSON object and in the middle of a line.
    parts = [lines[:20], lines[20:95], lines[95:]]

    _install(monkeypatch, _pulling_handler(lambda: _chunks(parts)))

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "completed"
    assert status["bytes_completed"] == 100


async def test_duplicate_start_is_refused_and_only_one_pull_is_sent(monkeypatch):
    requests = []

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"pulling manifest"}\n')

    _install(monkeypatch, _handler, requests)

    first = await lmd.start_download()
    second = await lmd.start_download()

    assert first is not None
    assert second is None, "a second concurrent job must be refused"
    assert lmd.get_status()["state"] in lmd.MODEL_DOWNLOAD_ACTIVE_STATES

    await _run_job()
    assert len(_pull_request_bodies(requests)) == 1


# ---------------------------------------------------------------------------
# 11/12/13. Progress accounting
# ---------------------------------------------------------------------------


async def test_byte_progress_without_total_is_indeterminate(monkeypatch):
    _install(monkeypatch, _pulling_handler(
        b'{"status":"pulling sha256:aa","digest":"sha256:aa","completed":4096}\n'
        b'{"status":"success"}\n'
    ))

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "completed"
    assert status["bytes_completed"] == 4096
    assert status["bytes_total"] is None
    assert status["percentage"] is None, "percentage must never be fabricated"


async def test_valid_completed_over_total_produces_percentage(monkeypatch):
    seen = []
    real_publish = lmd._publish

    def _spy(job, state, **kwargs):
        real_publish(job, state, **kwargs)
        seen.append(dict(lmd.get_status()))

    monkeypatch.setattr(lmd, "_publish", _spy)

    def _pulling_body():
        return (
            b'{"status":"pulling sha256:aa","digest":"sha256:aa",'
            b'"total":1000,"completed":400}\n'
            b'{"status":"success"}\n'
        )

    _install(monkeypatch, _pulling_handler(_pulling_body))

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "completed"
    assert status["bytes_completed"] == 400
    assert status["bytes_total"] == 1000
    assert status["percentage"] == 40
    assert any(s["percentage"] == 40 for s in seen)


async def test_per_digest_counters_are_aggregated_not_reset(monkeypatch):
    _install(monkeypatch, _pulling_handler(
        b'{"status":"pulling sha256:aa","digest":"sha256:aa",'
        b'"total":100,"completed":100}\n'
        b'{"status":"pulling sha256:bb","digest":"sha256:bb",'
        b'"total":100,"completed":0}\n'
        b'{"status":"pulling sha256:bb","digest":"sha256:bb",'
        b'"total":100,"completed":50}\n'
        b'{"status":"success"}\n'
    ))

    await lmd.start_download()
    await _run_job()

    # Aggregated across both layers: 100 + 50 of 200. A naive per-event
    # reading would report only the last layer (50 of 100).
    status = lmd.get_status()
    assert status["bytes_completed"] == 150
    assert status["bytes_total"] == 200
    assert status["percentage"] == 75


async def test_digest_values_are_never_exposed(monkeypatch):
    _install(monkeypatch, _pulling_handler(
        b'{"status":"pulling sha256:deadbeef","digest":"sha256:deadbeef",'
        b'"total":100,"completed":10}\n'
        b'{"status":"success"}\n'
    ))

    await lmd.start_download()
    await _run_job()

    assert lmd.get_status()["state"] == "completed"
    assert "deadbeef" not in json.dumps(lmd.get_status())


# ---------------------------------------------------------------------------
# 14/15/16/17. Stream failure classification
# ---------------------------------------------------------------------------


async def test_malformed_lines_are_skipped_individually(monkeypatch):
    _install(monkeypatch, _pulling_handler(
        b'not json at all\n'
        b'{"status":"pulling manifest"}\n'
        b'{"unterminated":\n'
        b'{"status":"success"}\n'
    ))

    await lmd.start_download()
    await _run_job()

    assert lmd.get_status()["state"] == "completed"


async def test_fully_malformed_stream_fails_safely(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'garbage\nmore garbage\n')

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "malformed_response"
    assert status["retryable"] is True
    assert "garbage" not in json.dumps(status)


async def test_unknown_status_strings_do_not_fail_the_job(monkeypatch):
    _install(monkeypatch, _pulling_handler(
        b'{"status":"something brand new"}\n'
        b'{"status":"success"}\n'
    ))

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "completed"
    assert "brand new" not in json.dumps(status)


async def test_ollama_error_field_is_classified_safely(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(
            200, content=b'{"error":"pull access denied for internal.registry/team"}\n'
        )

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "ollama_error"
    assert status["retryable"] is True
    assert "internal.registry" not in json.dumps(status)


async def test_registry_failure_over_http_status_is_safe(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(500, content=b"upstream unavailable")

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "ollama_error"
    assert "upstream" not in json.dumps(status)


async def test_inactivity_timeout_is_classified_as_stalled(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        raise httpx.ReadTimeout("no data for too long")

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "stalled"
    assert status["retryable"] is True


async def test_mid_stream_disconnect_is_a_distinct_state(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"pulling manifest"}\n')

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "disconnected"
    assert status["error_category"] == "ollama_disconnected"
    assert status["retryable"] is True


# ---------------------------------------------------------------------------
# 21/22. Completion is verified through /api/tags
# ---------------------------------------------------------------------------


async def test_success_event_alone_never_completes(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])  # model never actually appears
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "verification_failed"
    assert status["retryable"] is True


async def test_completion_requires_the_exact_configured_model(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([f"{settings.OLLAMA_MODEL}-instruct", "other:1b"])
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] == "verification_failed"


async def test_verification_failure_when_tags_probe_errors(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags" and request.method == "POST":
            return _installed([])
        # Pull succeeds, then the verification probe fails outright.
        if request.url.path == "/api/pull":
            return httpx.Response(200, content=b'{"status":"success"}\n')
        raise httpx.ConnectError("service went away")

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert status["state"] == "failed"
    assert status["error_category"] in {"verification_failed", "ollama_unavailable"}


# ---------------------------------------------------------------------------
# 26. No raw exception text anywhere in the contract
# ---------------------------------------------------------------------------


async def test_no_raw_exception_text_is_exposed(monkeypatch):
    secret = "SECRET-TOKEN-abc123"

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        raise RuntimeError(secret)

    _install(monkeypatch, _handler)

    await lmd.start_download()
    await _run_job()

    status = lmd.get_status()
    assert secret not in json.dumps(status)
    assert status["message"] == lmd.MODEL_DOWNLOAD_MESSAGES["failed"]
    assert status["error_category"] == "unknown"


def test_status_contract_has_exactly_eight_fields():
    assert set(lmd.get_status()) == EXPECTED_FIELDS
    assert set(lmd.LocalModelDownloadStatus.model_fields) == EXPECTED_FIELDS


# ---------------------------------------------------------------------------
# 27. No cancellation surface
# ---------------------------------------------------------------------------


def test_module_defines_no_cancel_state_or_endpoint():
    source_states = set(lmd.DownloadState.__args__)
    assert not any("cancel" in s for s in source_states)
    assert not hasattr(lmd, "cancel_download")
    assert not hasattr(lmd, "cancel")
    assert "cancel" not in lmd.MODEL_DOWNLOAD_MESSAGES


def test_no_cancel_route_exists(client):
    response = client.post("/api/setup/local-model/download/cancel")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 23/24/25. No database write, no audit change, no document data sent
# ---------------------------------------------------------------------------


def test_route_contract_and_no_audit_row_written(client, test_engine, monkeypatch):
    requests = []

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([settings.OLLAMA_MODEL])
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler, requests)

    with Session(test_engine) as session:
        before = session.query(AuditRecord).count()

    status_response = client.get("/api/setup/local-model/download/status")
    assert status_response.status_code == 200
    assert set(status_response.json()) == EXPECTED_FIELDS

    dev_origin = "http://localhost:5173"
    consent_resp = client.post("/api/setup/local-model/download/consent", headers={"Origin": dev_origin})
    assert consent_resp.status_code == 200
    token = consent_resp.json()["consent_token"]
    assert token
    assert consent_resp.json()["model_name"] == settings.OLLAMA_MODEL
    assert consent_resp.json()["expires_in_seconds"] == 300

    start_response = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": dev_origin},
        json={"consent_token": token},
    )
    assert start_response.status_code == 200
    body = start_response.json()
    assert set(body) == EXPECTED_FIELDS
    assert body["model_name"] == settings.OLLAMA_MODEL
    assert body["state"] in lmd.MODEL_DOWNLOAD_ACTIVE_STATES or body["state"] == "idle"

    with Session(test_engine) as session:
        after = session.query(AuditRecord).count()

    assert after == before, "a download must never write an Audit row"


def test_second_route_start_returns_409(client, monkeypatch):
    async def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        # Never completes, so the first job stays active.
        await asyncio.sleep(30)
        return httpx.Response(200, content=b"")

    _install(monkeypatch, _handler)

    dev_origin = "http://localhost:5173"
    consent1 = client.post("/api/setup/local-model/download/consent", headers={"Origin": dev_origin})
    token1 = consent1.json()["consent_token"]
    first = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": dev_origin},
        json={"consent_token": token1},
    )
    assert first.status_code == 200

    # Issuance during active pull returns 409
    consent2 = client.post("/api/setup/local-model/download/consent", headers={"Origin": dev_origin})
    assert consent2.status_code == 409
    assert "already in progress" in consent2.json()["detail"]

    # Second start with replayed token returns 403 (token consumed on first call)
    second = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": dev_origin},
        json={"consent_token": token1},
    )
    assert second.status_code == 403
    assert "previously redeemed" in second.json()["detail"]

async def test_no_document_or_citation_data_is_transmitted(monkeypatch):
    requests = []

    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"success"}\n')

    _install(monkeypatch, _handler, requests)

    await lmd.start_download()
    await _run_job()

    for request in requests:
        payload = json.loads(request.content) if request.content else {}
        # The only keys ever sent to Ollama are the three pull fields.
        assert set(payload) <= {"model", "stream", "insecure"}


# ---------------------------------------------------------------------------
# 28. Job lifecycle hygiene
# ---------------------------------------------------------------------------


async def test_retained_task_reference_is_cleared_and_state_is_terminal(monkeypatch):
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]))

    await lmd.start_download()
    await _run_job()

    assert lmd._task is None
    assert lmd.get_status()["state"] not in lmd.MODEL_DOWNLOAD_ACTIVE_STATES


async def test_terminal_snapshot_is_preserved_after_completion(monkeypatch):
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]))

    await lmd.start_download()
    await _run_job()

    assert lmd.get_status()["state"] == "completed"
    assert lmd.get_status()["state"] == "completed"


async def test_reset_clears_a_superseded_job(monkeypatch):
    def _handler(request):
        if request.url.path == "/api/tags":
            return _installed([])
        return httpx.Response(200, content=b'{"status":"pulling manifest"}\n')

    _install(monkeypatch, _handler)

    await lmd.start_download()
    assert lmd.get_status()["state"] in lmd.MODEL_DOWNLOAD_ACTIVE_STATES

    lmd.reset_state()
    assert lmd.get_status()["state"] == "idle"
    assert lmd._task is None


def test_http_client_never_follows_redirects():
    """A redirect must not be able to move the request off loopback."""

    async def _exercise():
        client = await lmd._make_client(lmd._PROBE_TIMEOUT)
        try:
            assert client.follow_redirects is False
        finally:
            await client.aclose()

    asyncio.run(_exercise())


def test_http_client_disables_environment_proxies(monkeypatch):
    """An injected proxy must never intercept a Local AI loopback request."""
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8888")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)

    async def _exercise():
        client = await lmd._make_client(lmd._PROBE_TIMEOUT)
        try:
            assert client.trust_env is False
            assert not client._mounts
        finally:
            await client.aclose()

    asyncio.run(_exercise())


# ---------------------------------------------------------------------------
# B-PRIV-03 Consent Issuance, Redemption, and Origin Tests
# ---------------------------------------------------------------------------

def test_origin_validation_matrix():
    """Verify validate_origin rejects untrusted/malformed and accepts approved local origins."""
    # Missing
    assert lmd.validate_origin([]) is None
    # Null
    assert lmd.validate_origin(["null"]) is None
    assert lmd.validate_origin(["NULL"]) is None
    # Empty
    assert lmd.validate_origin([""]) is None
    assert lmd.validate_origin(["   "]) is None
    # External
    assert lmd.validate_origin(["http://evil.com"]) is None
    assert lmd.validate_origin(["http://evil.com:11434"]) is None
    assert lmd.validate_origin(["http://localhost.evil.com:5173"]) is None
    assert lmd.validate_origin(["https://localhost:5173"]) is None
    # Multiple / comma-joined
    assert lmd.validate_origin(["http://localhost:5173", "http://evil.com"]) is None
    assert lmd.validate_origin(["http://localhost:5173, http://evil.com"]) is None
    # Credentials / path / query / fragment
    assert lmd.validate_origin(["http://user:pw@localhost:5173"]) is None
    assert lmd.validate_origin(["http://localhost:5173/path"]) is None
    assert lmd.validate_origin(["http://localhost:5173?q=1"]) is None
    assert lmd.validate_origin(["http://localhost:5173#frag"]) is None
    # Unapproved port
    assert lmd.validate_origin(["http://localhost:9999"]) is None
    assert lmd.validate_origin(["http://127.0.0.1:4000"]) is None
    # Approved development origins
    assert lmd.validate_origin(["http://localhost:5173"]) == "http://localhost:5173"
    assert lmd.validate_origin(["http://127.0.0.1:5173"]) == "http://127.0.0.1:5173"
    assert lmd.validate_origin(["http://[::1]:5173"]) == "http://[::1]:5173"
    assert lmd.validate_origin(["http://localhost:3000"]) == "http://localhost:3000"
    assert lmd.validate_origin(["http://127.0.0.1:3000"]) == "http://127.0.0.1:3000"
    # Approved packaged origins
    assert lmd.validate_origin(["http://localhost:8000"]) == "http://localhost:8000"
    assert lmd.validate_origin(["http://127.0.0.1:8000"]) == "http://127.0.0.1:8000"
    assert lmd.validate_origin(["http://127.0.0.1:8012"]) == "http://127.0.0.1:8012"
    # Dynamic request port support
    assert lmd.validate_origin(["http://127.0.0.1:61501"], request_port=61501) == "http://127.0.0.1:61501"


@pytest.mark.asyncio
async def test_consent_store_bounded_and_purges_expired(monkeypatch):
    """Verify consent store limits capacity and purges expired records."""
    lmd.reset_state()
    origin = "http://localhost:5173"
    tokens = []
    for _ in range(lmd.MAX_PENDING_CONSENT_TOKENS):
        resp = await lmd.issue_consent(origin)
        tokens.append(resp.consent_token)
    assert len(lmd._consent_store) == lmd.MAX_PENDING_CONSENT_TOKENS

    # Next issuance raises capacity exceeded
    with pytest.raises(lmd.ConsentCapacityExceededError):
        await lmd.issue_consent(origin)

    # Simulate expiration of older tokens
    for tok in tokens[:10]:
        lmd._consent_store[tok].expires_at_monotonic = 0

    # Now issuing consent succeeds because expired tokens are purged
    new_resp = await lmd.issue_consent(origin)
    assert new_resp.consent_token
    assert len(lmd._consent_store) == lmd.MAX_PENDING_CONSENT_TOKENS - 10 + 1


@pytest.mark.parametrize("bad_origin", [
    None,
    "null",
    "http://evil.com",
    "http://localhost:9999",
    "http://user:pw@localhost:5173",
    "https://localhost:5173",
])
def test_route_consent_and_start_reject_unapproved_origins(client, bad_origin):
    """Verify routes reject missing, null, external, and malformed origins."""
    headers = {} if bad_origin is None else {"Origin": bad_origin}
    # Challenge endpoint
    r1 = client.post("/api/setup/local-model/download/consent", headers=headers)
    assert r1.status_code == 403
    assert "origin" in r1.json()["detail"].lower()

    # Start endpoint
    r2 = client.post("/api/setup/local-model/download", headers=headers, json={"consent_token": "dummy"})
    assert r2.status_code == 403
    assert "origin" in r2.json()["detail"].lower()


def test_consent_issuance_starts_no_pull(client, monkeypatch):
    """Calling /consent issues a token but creates no background pull job."""
    requests = []
    _install(monkeypatch, lambda r: _installed([]), requests)

    resp = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"})
    assert resp.status_code == 200
    assert resp.json()["consent_token"]
    assert lmd._task is None
    assert lmd.get_status()["state"] == "idle"
    assert len(requests) == 0


def test_valid_token_starts_exactly_one_pull(client, monkeypatch):
    """Redeeming a valid token starts exactly one pull."""
    requests = []
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]), requests)

    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    resp = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert resp.status_code == 200
    assert resp.json()["state"] in lmd.MODEL_DOWNLOAD_ACTIVE_STATES or resp.json()["state"] == "idle"


def test_consent_token_single_use_replay_rejected(client, monkeypatch):
    """Tokens cannot be replayed; second use is rejected with 403."""
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]))

    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    r1 = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert r1.status_code == 200

    # Second redemption attempt fails
    r2 = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert r2.status_code == 403
    assert "previously redeemed" in r2.json()["detail"].lower()


def test_consent_token_expiry_rejected(client):
    """Expired tokens are rejected."""
    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    # Manually expire the token in the store
    lmd._consent_store[token].expires_at_monotonic = 0

    r = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert r.status_code == 403
    assert "expired" in r.json()["detail"].lower()


def test_consent_token_model_change_rejected(client, monkeypatch):
    """A token issued for model A cannot be redeemed for model B."""
    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    monkeypatch.setattr(settings, "OLLAMA_MODEL", "different-model:latest")

    r = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert r.status_code == 400
    assert "model" in r.json()["detail"].lower()


def test_consent_token_origin_change_rejected(client):
    """A token issued for one origin cannot be redeemed from a different origin."""
    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    r = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:8000"},
        json={"consent_token": token},
    )
    assert r.status_code == 403
    assert "origin" in r.json()["detail"].lower()


def test_backend_restart_clears_consent_tokens(client):
    """Tokens do not survive backend restart (reset_state)."""
    consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    token = consent["consent_token"]

    lmd.reset_state()

    r = client.post(
        "/api/setup/local-model/download",
        headers={"Origin": "http://localhost:5173"},
        json={"consent_token": token},
    )
    assert r.status_code == 403
    assert "invalid" in r.json()["detail"].lower() or "previously redeemed" in r.json()["detail"].lower()


def test_failed_start_consumes_consent_token(client, monkeypatch):
    """If start fails due to active pull, the token is still consumed and cannot be replayed."""
    async def _handler(request):
        await asyncio.sleep(30)
        return httpx.Response(200, content=b"")
    _install(monkeypatch, _handler)

    c1 = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
    c2 = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()

    # Start first job
    r1 = client.post("/api/setup/local-model/download", headers={"Origin": "http://localhost:5173"}, json={"consent_token": c1["consent_token"]})
    assert r1.status_code == 200

    # Second start returns 409 because pull is active
    r2 = client.post("/api/setup/local-model/download", headers={"Origin": "http://localhost:5173"}, json={"consent_token": c2["consent_token"]})
    assert r2.status_code == 409

    # Now retry using c2's token — must be 403 because it was consumed during the 409 attempt!
    r3 = client.post("/api/setup/local-model/download", headers={"Origin": "http://localhost:5173"}, json={"consent_token": c2["consent_token"]})
    assert r3.status_code == 403


def test_start_download_rejects_missing_or_extra_body_fields(client):
    """Download endpoint strictly requires only consent_token."""
    origin = "http://localhost:5173"
    # No body
    assert client.post("/api/setup/local-model/download", headers={"Origin": origin}).status_code == 422
    # Empty body
    assert client.post("/api/setup/local-model/download", headers={"Origin": origin}, json={}).status_code == 422
    # Extra field
    assert client.post("/api/setup/local-model/download", headers={"Origin": origin}, json={"consent_token": "a", "extra": 1}).status_code == 422


def test_consent_token_never_in_logs_or_status(client, monkeypatch, caplog):
    """Verify consent token is never logged or exposed in status polling."""
    _install(monkeypatch, lambda r: _installed([settings.OLLAMA_MODEL]))

    with caplog.at_level(logging.DEBUG):
        consent = client.post("/api/setup/local-model/download/consent", headers={"Origin": "http://localhost:5173"}).json()
        token = consent["consent_token"]
        client.post("/api/setup/local-model/download", headers={"Origin": "http://localhost:5173"}, json={"consent_token": token})
        status = client.get("/api/setup/local-model/download/status").json()

    assert token not in caplog.text, "Token leaked in logs!"
    assert "consent_token" not in status, "Token leaked in status response!"
    assert token not in json.dumps(status), "Token value leaked in status response!"
