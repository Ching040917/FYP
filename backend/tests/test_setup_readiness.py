"""Setup readiness (Build A) tests.

Covers: strict schema, all-ready, causal Ollama/model dependency, optional
neutrality (local AI off, cloud unconfigured), LibreOffice missing/error,
preview provisional wording, database drift → blocked, cache + refresh +
single-flight, read-only guarantees (no fs writes, no DB writes, no process
spawns), and payload privacy (no paths/hosts/ports/env/keys/provider data).
"""
import asyncio
import json
import subprocess
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.services import setup_readiness as sr
from app.services import preview_storage
from app.services.setup_readiness import (
    ReadinessProbes,
    compute_readiness,
    reset_cache,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

ALL_READY = dict(
    expected_head=lambda: "f6a8d19e2b3f2",
    db_version_nums=lambda: ["f6a8d19e2b3f2"],
    fetch_ollama_models=lambda: _async(["qwen3.5:4b"]),
    find_soffice=lambda: r"C:\fake\soffice.com",
    local_ai_enabled=True,
    cloud_ai_configured=False,
    model_name="qwen3.5:4b",
)


def _async(value):
    async def _f():
        return value
    return _f()


def probes(**overrides):
    kw = dict(ALL_READY)
    kw.update(overrides)
    return ReadinessProbes(
        expected_head=kw["expected_head"],
        db_version_nums=kw["db_version_nums"],
        fetch_ollama_models=kw["fetch_ollama_models"],
        find_soffice=kw["find_soffice"],
        storage_root_exists=lambda: True,
        local_ai_enabled=kw["local_ai_enabled"],
        cloud_ai_configured=kw["cloud_ai_configured"],
        model_name=kw["model_name"],
    )


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Never touch real Ollama from these tests."""
    monkeypatch.setattr(sr.settings, "OLLAMA_HOST", "http://127.0.0.1:1")
    monkeypatch.setattr(sr.httpx.AsyncClient, "get",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("real network call")))
    yield


@pytest.fixture(autouse=True)
def fresh_cache():
    reset_cache()
    yield
    reset_cache()


def by_id(payload):
    return {c["id"]: c for c in payload["components"]}


# ---------------------------------------------------------------------------
# All ready / strict schema
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_components_ready_and_strict_ids():
    payload = await compute_readiness(probes())
    assert payload["overall"] == "ready"
    ids = [c["id"] for c in payload["components"]]
    assert ids == [
        "core_backend", "database", "docx_audit", "libreoffice",
        "rendered_preview", "ollama", "local_model", "cloud_ai",
    ]
    # Strict schema round-trip through the response model.
    resp = sr.ReadinessResponse(**payload)
    assert resp.overall == "ready"
    assert len(resp.components) == 8
    assert datetime.fromisoformat(resp.checked_at) is not None
    # checked_at is naive UTC (no tzinfo).
    assert "+" not in resp.checked_at and "Z" not in resp.checked_at


# ---------------------------------------------------------------------------
# Causal Ollama / model dependency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ollama_unreachable_model_unknown_not_second_failure():
    async def down():
        raise ConnectionError("no")
    p = probes(fetch_ollama_models=down)
    payload = await compute_readiness(p)
    b = by_id(payload)
    assert b["ollama"]["state"] == "unavailable"
    assert b["local_model"]["state"] == "unknown"
    assert "could not be checked" in b["local_model"]["message"]
    # Unknown does not block.
    assert payload["overall"] == "degraded"


@pytest.mark.asyncio
async def test_ollama_reachable_model_missing():
    p = probes(fetch_ollama_models=lambda: _async(["gemma4:latest"]))
    payload = await compute_readiness(p)
    b = by_id(payload)
    assert b["ollama"]["state"] == "ready"
    assert b["local_model"]["state"] == "unavailable"
    # Configured model name only inside safe detail.
    assert "qwen3.5:4b" not in b["local_model"]["message"]
    assert "qwen3.5:4b" in b["local_model"]["detail"]
    assert payload["overall"] == "degraded"


@pytest.mark.asyncio
async def test_exact_model_matching_no_normalization():
    p = probes(fetch_ollama_models=lambda: _async(["qwen3.5:4b-instruct"]))
    payload = await compute_readiness(p)
    assert by_id(payload)["local_model"]["state"] == "unavailable"


@pytest.mark.asyncio
async def test_local_ai_disabled_neutral_optional_no_network_call(monkeypatch):
    called = {"n": 0}
    async def spy():
        called["n"] += 1
        return []
    monkeypatch.setattr(sr.settings, "LOCAL_AI_ENABLED", False)
    payload = await compute_readiness(probes(fetch_ollama_models=spy, local_ai_enabled=False))
    b = by_id(payload)
    assert b["ollama"]["state"] == "optional"
    assert b["local_model"]["state"] == "optional"
    assert called["n"] == 0  # no network probe when disabled
    assert payload["overall"] == "ready"


# ---------------------------------------------------------------------------
# Cloud AI neutrality
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cloud_unconfigured_neutral_optional():
    payload = await compute_readiness(probes(cloud_ai_configured=False))
    c = by_id(payload)["cloud_ai"]
    assert c["state"] == "optional"
    assert c["required"] is False
    assert c["message"] == "Cloud AI review is optional and is not configured."


@pytest.mark.asyncio
async def test_cloud_configured_reports_ready_without_generation_call(monkeypatch):
    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("paid call")))
    payload = await compute_readiness(probes(cloud_ai_configured=True))
    c = by_id(payload)["cloud_ai"]
    assert c["state"] == "ready"
    assert c["required"] is False


# ---------------------------------------------------------------------------
# LibreOffice / preview
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_libreoffice_unavailable_optional_nonblocking():
    p2 = probes()
    object.__setattr__(p2, "find_soffice", lambda: None)
    payload = await compute_readiness(p2)
    b = by_id(payload)
    assert b["libreoffice"]["state"] == "unavailable"
    assert b["rendered_preview"]["state"] == "unavailable"
    assert b["rendered_preview"]["message"].startswith("Rendered-page preview is unavailable.")
    assert payload["overall"] == "degraded"


@pytest.mark.asyncio
async def test_libreoffice_probe_error_becomes_unknown():
    p2 = probes()
    object.__setattr__(p2, "find_soffice", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    payload = await compute_readiness(p2)
    b = by_id(payload)
    assert b["libreoffice"]["state"] == "unknown"
    assert payload["overall"] != "blocked"


@pytest.mark.asyncio
async def test_preview_wording_honest_provisional():
    payload = await compute_readiness(probes())
    msg = by_id(payload)["rendered_preview"]["message"]
    assert msg.startswith("Rendered-page preview appears available.")
    assert "confirmed during an audit" in msg
    assert "proven" not in msg.lower()


# ---------------------------------------------------------------------------
# Database drift
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_database_head_match_ready():
    payload = await compute_readiness(probes())
    assert by_id(payload)["database"]["state"] == "ready"


@pytest.mark.asyncio
async def test_database_mismatch_blocked_with_safe_message():
    p = probes(expected_head=lambda: "f6a8d19e2b3f2",
               db_version_nums=lambda: ["older-head"])
    payload = await compute_readiness(p)
    b = by_id(payload)["database"]
    assert b["state"] == "misconfigured"
    assert b["required"] is True
    assert payload["overall"] == "blocked"
    assert b["message"].startswith("The database requires an application update.")


@pytest.mark.asyncio
async def test_database_probe_failure_safe_message(monkeypatch):
    def boom():
        raise RuntimeError("sqlite detail leak attempt")
    p = probes(db_version_nums=boom)
    payload = await compute_readiness(p)
    b = by_id(payload)["database"]
    assert b["state"] == "misconfigured"
    assert "sqlite" not in b["message"]
    assert payload["overall"] == "blocked"


def test_expected_head_constant_matches_script_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    cfg = Config()
    cfg.set_main_option("script_location", "alembic")
    assert sr._default_expected_head() == ScriptDirectory.from_config(cfg).get_current_head()


# ---------------------------------------------------------------------------
# Cache / refresh / single-flight
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cache_returns_same_checked_at(monkeypatch):
    calls = {"n": 0}
    async def tags():
        calls["n"] += 1
        return ["qwen3.5:4b"]
    monkeypatch.setattr(sr._default_probes, "fetch_ollama_models", tags)
    a = await sr.get_readiness()
    at_a = a["checked_at"]
    b = await sr.get_readiness()
    assert a["checked_at"] == b["checked_at"]
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_refresh_bypasses_cache_new_checked_at(monkeypatch):
    async def tags():
        return ["qwen3.5:4b"]
    monkeypatch.setattr(sr._default_probes, "fetch_ollama_models", tags)
    a = await sr.get_readiness()
    await asyncio.sleep(0.01)
    b = await sr.get_readiness(force_refresh=True)
    assert a["checked_at"] != b["checked_at"]


@pytest.mark.asyncio
async def test_concurrent_misses_single_flight(monkeypatch):
    calls = {"n": 0}
    async def slow_tags():
        calls["n"] += 1
        await asyncio.sleep(0.05)
        return ["qwen3.5:4b"]
    monkeypatch.setattr(sr._default_probes, "fetch_ollama_models", slow_tags)
    results = await asyncio.gather(*(sr.get_readiness() for _ in range(5)))
    assert calls["n"] == 1
    checked = {r["checked_at"] for r in results}
    assert len(checked) == 1


# ---------------------------------------------------------------------------
# Privacy / safety guarantees
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_payload_has_no_sensitive_substrings(monkeypatch):
    async def tags():
        return ["qwen3.5:4b"]
    monkeypatch.setattr(sr._default_probes, "fetch_ollama_models", tags)
    raw = json.dumps(await sr.get_readiness()).lower()
    host = sr.settings.OLLAMA_HOST.lower()
    forbidden = [
        host, "localhost", "11434", "c:\\", "program files", "soffice",
        "api_key", "apikey", "gemini", ".docx", "stack", "traceback",
        "password", "token", "alembic_version",
    ]
    for token in forbidden:
        assert token not in raw, f"leaked: {token}"


@pytest.mark.asyncio
async def test_no_filesystem_writes_or_process_spawns(monkeypatch, tmp_path):
    """Endpoint computation performs no writes, no spawns."""
    import builtins
    opened = []
    real_open = builtins.open

    def guarded_open(file, mode="r", *a, **k):
        if any(m in str(mode).lower() for m in ("w", "a", "x", "+")):
            opened.append((str(file), mode))
            raise AssertionError(f"write attempted: {file} mode={mode}")
        return real_open(file, mode, *a, **k)

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(subprocess, "Popen",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("spawn")))
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("spawn")))

    payload = await compute_readiness(probes())
    assert payload["overall"] == "ready"
    assert opened == []


@pytest.fixture
def db_session(tmp_path, monkeypatch):
    """In-memory DB session; preview root under tmp_path."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    monkeypatch.setattr(preview_storage.settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "previews"))
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.mark.asyncio
async def test_no_database_writes(db_session, monkeypatch):
    """Attach a write-blocking listener AFTER seeding; any engine write in the
    compute path fails loudly. Only SELECTs may occur."""
    from sqlalchemy import event, text

    def reader():
        rows = db_session.execute(text("SELECT version_num FROM alembic_version")).fetchall()
        return [r[0] for r in rows]

    # Seed first (listener not yet installed).
    db_session.execute(text(
        "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"))
    db_session.execute(text("DELETE FROM alembic_version"))
    db_session.execute(text("INSERT INTO alembic_version VALUES ('f6a8d19e2b3f2')"))
    db_session.commit()

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        low = statement.lstrip().lower()
        if low.startswith(("insert", "update", "delete", "create", "drop", "alter")):
            raise AssertionError(f"DB write attempted: {statement[:80]}")

    event.listen(db_session.bind, "before_cursor_execute", before_cursor_execute)
    try:
        payload = await compute_readiness(probes(
            expected_head=lambda: "f6a8d19e2b3f2",
            db_version_nums=reader,
        ))
        assert payload["overall"] == "ready"
        assert by_id(payload)["database"]["state"] == "ready"
    finally:
        event.remove(db_session.bind, "before_cursor_execute", before_cursor_execute)


# ---------------------------------------------------------------------------
# Optional unknown never blocks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_optional_unknown_never_blocks(monkeypatch):
    async def down():
        raise TimeoutError()
    payload = await compute_readiness(probes(fetch_ollama_models=down))
    assert payload["overall"] == "degraded"  # not blocked


# ---------------------------------------------------------------------------
# API surface (TestClient against the app)
# ---------------------------------------------------------------------------


def _client(monkeypatch):
    mock_init_db(monkeypatch)
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    return c


def mock_init_db(monkeypatch):
    monkeypatch.setattr("app.main.init_db", lambda: None)
    monkeypatch.setattr(
        "app.main.reconcile_stale_audits", lambda *a, **k: 0,
    )


@pytest.fixture
def api_client(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.database import Base, get_db
    from app.main import app
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    def _override():
        db = Session()
        try:
            yield db
        finally:
            db.close()
    app.dependency_overrides[get_db] = _override
    # Deterministic probes for the endpoint path.
    reset_cache()
    monkeypatch.setattr(sr._default_probes, "expected_head", lambda: "f6a8d19e2b3f2")
    monkeypatch.setattr(sr._default_probes, "db_version_nums", lambda: ["f6a8d19e2b3f2"])
    monkeypatch.setattr(sr._default_probes, "find_soffice", lambda: r"C:\fake\soffice.com")
    monkeypatch.setattr(
        sr._default_probes, "fetch_ollama_models",
        lambda: _async(["qwen3.5:4b"]),
    )
    c = TestClient(app)
    try:
        with c:
            yield c
    finally:
        app.dependency_overrides.clear()
        reset_cache()


def test_endpoint_all_ready_shape(api_client):
    reset_cache()
    resp = api_client.get("/api/readiness")
    assert resp.status_code == 200
    body = resp.json()
    assert body["overall"] == "ready"
    ids = {c["id"] for c in body["components"]}
    assert len(ids) == 8
    raw = json.dumps(body).lower()
    assert "localhost" not in raw and "11434" not in raw
