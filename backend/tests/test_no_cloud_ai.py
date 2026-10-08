"""Negative contract tests — the Cloud AI / Gemini module is absent.

Covers, with no network access:
- POST /api/audit exposes no cloud parameter and ignores a stale one;
- GET /api/readiness returns no cloud_ai component;
- Settings and .env.example carry no cloud/gemini configuration;
- no backend source imports the Gemini SDK;
- the deterministic score and findings are identical with the local AI up or
  down (core auditing never depends on AI);
- a historical row with cloud-valued metadata still loads and exports;
- the local-model download endpoints survive;
- Alembic still has exactly one head and no migration was added here.
"""
import io
import json
import re
from pathlib import Path

from sqlalchemy.orm import sessionmaker

from app.api import routes as api_routes
from app.config import Settings, settings
from app.models.audit import AuditRecord, Violation
from app.services import ai_citation
from app.services import setup_readiness as sr
from app.services.ai_citation import async_ai_citation_task

BACKEND_DIR = Path(__file__).resolve().parents[1]

# A document that the deterministic citation sensor flags exactly once:
# an in-text citation with no matching References entry (the bibliography
# exists but does not list Garcia).
CITATION_DOC = {
    "paragraphs": ["Orphan (Garcia, 2018) text."],
    "references": ["Other, X. (2020). Unrelated entry. Press."],
    "with_caption": False,
}


async def _models_installed():
    return ["qwen3.5:4b"]


async def _ai_down(_prompt):
    raise RuntimeError("connection refused")


async def _ai_up(prompt: str) -> str:
    """Echo guidance for every finding key present in the real prompt."""
    keys = re.findall(r'"finding_key":\s*"([0-9a-f-]+)"', prompt)
    return json.dumps([
        {
            "finding_key": k,
            "reason": "Add the matching reference entry for the cited source.",
            "source_type": "unknown",
            "confidence": 0.9,
        }
        for k in keys
    ])


def _deterministic_findings(body):
    """Stable identity tuple list for deterministic findings."""
    return sorted(
        (
            v["rule_code"],
            json.dumps(v["location"], sort_keys=True),
            v["expected_value"],
            v["actual_value"],
        )
        for v in body["physical_layout_errors"]
    )


def _seed_historical_cloud_row(test_engine, deploy_mode="CLOUD", ai_provider="CLOUD_GEMINI"):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit_id = "hist-cloud-0001"
    s.add(AuditRecord(
        id=audit_id,
        filename="legacy-cloud.docx",
        file_size=100,
        weighted_score=80,
        deploy_mode=deploy_mode,
        status="completed",
        ai_review_status="COMPLETED_WITH_SUGGESTIONS",
        ai_provider=ai_provider,
        paragraph_count=1,
        heading_count=0,
        table_count=0,
        image_count=0,
        section_count=1,
        word_count=2,
    ))
    s.add(Violation(
        id="viol-hist-0001",
        audit_id=audit_id,
        rule_code="MARGIN_TOP",
        severity="MAJOR",
        location={"section_index": 0},
        message="Top margin is 1.0in, expected 1.5in.",
        expected_value="1.5in",
        actual_value="1.0in",
    ))
    s.commit()
    s.close()
    return audit_id


# ---------------------------------------------------------------------------
# 1. No cloud audit parameter
# ---------------------------------------------------------------------------

def test_audit_endpoint_exposes_no_cloud_parameter(client, docx_factory):
    params = client.get("/openapi.json").json()["paths"]["/api/audit"]["post"].get(
        "parameters", []
    )
    names = {p["name"] for p in params}
    assert "cloud" not in names
    assert names == {"profile_id"}

    # A stale client still sending ?cloud=1 cannot flip anything: the audit is
    # recorded with the model default and the response stays complete.
    resp = client.post(
        "/api/audit?cloud=1",
        files={"file": ("stale.docx", docx_factory(paragraphs=["Body text."]), "application/octet-stream")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "deploy_mode" not in body  # submission carries no deploy mode claim
    assert client.get(f"/api/audit/{body['audit_id']}").json()["deploy_mode"] == "LOCAL"


def test_new_audit_records_local_deploy_mode(client, docx_factory):
    resp = client.post(
        "/api/audit",
        files={"file": ("fresh.docx", docx_factory(paragraphs=["Body text."]), "application/octet-stream")},
    )
    assert resp.status_code == 200
    detail = client.get(f"/api/audit/{resp.json()['audit_id']}")
    assert detail.status_code == 200
    assert detail.json()["deploy_mode"] == "LOCAL"


# ---------------------------------------------------------------------------
# 2. No cloud readiness component
# ---------------------------------------------------------------------------

def test_readiness_payload_has_no_cloud_component(client, monkeypatch):
    monkeypatch.setattr(sr._default_probes, "fetch_ollama_models", _models_installed)
    sr.reset_cache()
    try:
        resp = client.get("/api/readiness")
        assert resp.status_code == 200
        ids = [c["id"] for c in resp.json()["components"]]
        assert "cloud_ai" not in ids
        assert ids == [
            "core_backend", "database", "docx_audit", "libreoffice",
            "rendered_preview", "ollama", "local_model",
        ]
    finally:
        sr.reset_cache()


# ---------------------------------------------------------------------------
# 3. No cloud/gemini configuration
# ---------------------------------------------------------------------------

def test_settings_and_env_example_have_no_cloud_config():
    assert "DEPLOY_MODE" not in Settings.model_fields
    assert "GEMINI_API_KEY" not in Settings.model_fields
    assert not hasattr(settings, "DEPLOY_MODE")
    assert not hasattr(settings, "GEMINI_API_KEY")

    env_example = (BACKEND_DIR / ".env.example").read_text(encoding="utf-8")
    assert "DEPLOY_MODE" not in env_example
    assert "GEMINI_API_KEY" not in env_example
    assert "gemini" not in env_example.lower()
    assert "cloud" not in env_example.lower()
    # Retained Local AI configuration is still documented.
    assert "OLLAMA_HOST" in env_example and "OLLAMA_MODEL" in env_example


# ---------------------------------------------------------------------------
# 4. No Gemini SDK import anywhere in production source
# ---------------------------------------------------------------------------

def test_no_gemini_sdk_import_in_backend_source():
    pattern = re.compile(r"google\s*\.\s*generativeai")
    hits = [
        str(p.relative_to(BACKEND_DIR))
        for p in (BACKEND_DIR / "app").rglob("*.py")
        if pattern.search(p.read_text(encoding="utf-8", errors="replace"))
    ]
    assert hits == []
    requirements = (BACKEND_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert "google-generativeai" not in requirements
    # The local HTTP path is retained.
    assert "httpx" in requirements


# ---------------------------------------------------------------------------
# 5. Deterministic audit is independent of AI availability
# ---------------------------------------------------------------------------

def test_deterministic_score_identical_with_ai_up_or_down(
    client, test_engine, docx_factory, monkeypatch
):
    # Restore the real AI task; only the provider call is controlled here.
    monkeypatch.setattr(api_routes, "async_ai_citation_task", async_ai_citation_task)

    def _post(name):
        return client.post(
            "/api/audit",
            files={"file": (name, docx_factory(**CITATION_DOC), "application/octet-stream")},
        )

    monkeypatch.setattr(ai_citation, "call_ollama_local", _ai_down)
    down = _post("ai-down.docx")
    assert down.status_code == 200
    down_body = down.json()
    assert down_body["ai_review_status"] == "UNAVAILABLE"
    assert down_body["ai_provider"] is None
    assert down_body["ai_citation_tooltips"] == []
    assert any(
        v["rule_code"] == "CITATION_MISMATCH" for v in down_body["physical_layout_errors"]
    )

    monkeypatch.setattr(ai_citation, "call_ollama_local", _ai_up)
    up = _post("ai-up.docx")
    assert up.status_code == 200
    up_body = up.json()
    assert up_body["ai_review_status"] == "COMPLETED_WITH_SUGGESTIONS"
    assert up_body["ai_provider"] == "LOCAL_OLLAMA"
    assert len(up_body["ai_citation_tooltips"]) >= 1

    # Score, counts and deterministic findings are byte-for-byte identical.
    assert up_body["weighted_compliance_score"] == down_body["weighted_compliance_score"]
    assert up_body["major_count"] == down_body["major_count"]
    assert up_body["minor_count"] == down_body["minor_count"]
    assert up_body["score_breakdown"] == down_body["score_breakdown"]
    assert up_body["document_stats"] == down_body["document_stats"]
    assert _deterministic_findings(up_body) == _deterministic_findings(down_body)


# ---------------------------------------------------------------------------
# 6. Historical cloud-valued rows still load and export
# ---------------------------------------------------------------------------

def test_historical_cloud_row_still_loads_and_exports(client, test_engine):
    audit_id = _seed_historical_cloud_row(test_engine)

    detail = client.get(f"/api/audit/{audit_id}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["deploy_mode"] == "CLOUD"
    assert body["ai_provider"] == "CLOUD_GEMINI"
    assert body["ai_review_status"] == "COMPLETED_WITH_SUGGESTIONS"

    listing = client.get("/api/audits")
    assert listing.status_code == 200
    assert any(item["id"] == audit_id for item in listing.json())

    export = client.get(f"/api/audit/{audit_id}/export-pdf")
    assert export.status_code == 200
    assert export.content[:4] == b"%PDF"
    from pypdf import PdfReader
    text = "\n".join(
        page.extract_text() or "" for page in PdfReader(io.BytesIO(export.content)).pages
    )
    assert "CLOUD" in text


# ---------------------------------------------------------------------------
# 7. Local model download endpoints survive
# ---------------------------------------------------------------------------

def test_local_model_download_endpoints_still_exist(client):
    paths = {route.path for route in api_routes.router.routes}
    assert "/api/setup/local-model/download" in paths
    assert "/api/setup/local-model/download/status" in paths


# ---------------------------------------------------------------------------
# 12. No new migration — exactly one Alembic head
# ---------------------------------------------------------------------------

def test_alembic_single_head_unchanged():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    assert ScriptDirectory.from_config(cfg).get_heads() == ["b3e8d19e2b3f"]
