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


def test_start_route_declares_no_application_parameters():
    assert list(inspect.signature(start_local_model_download).parameters) == []
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

    start_response = client.post("/api/setup/local-model/download")
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

    first = client.post("/api/setup/local-model/download")
    assert first.status_code == 200

    second = client.post("/api/setup/local-model/download")
    assert second.status_code == 409
    assert "already in progress" in second.json()["detail"]


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
