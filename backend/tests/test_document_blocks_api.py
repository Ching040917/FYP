"""Tests for Evidence-Linked Document Preview persistence and API (Build 8B).

Covers: POST persistence, ordered-block endpoint, empty/duplicate paragraph
fidelity, historical NULL, 404, deletion cascade, contract stability, and
the document_blocks migration roundtrip on a temporary database.
"""
from pathlib import Path

import pytest

from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

from app.models.audit import AuditRecord

BLOCK_KEYS = {"order", "type", "index", "text", "style_name", "heading_level"}


def _post_audit(client, docx_factory, paragraphs):
    return client.post(
        "/api/audit",
        files={"file": ("preview.docx", docx_factory(paragraphs=paragraphs), "application/octet-stream")},
    )


def test_post_persists_blocks_and_endpoint_returns_them(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["first", "second", "third"])
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]

    blocks = client.get(f"/api/audit/{audit_id}/document-blocks")
    assert blocks.status_code == 200
    body = blocks.json()
    assert body["audit_id"] == audit_id
    assert [b["order"] for b in body["blocks"]] == [0, 1, 2]
    assert [b["index"] for b in body["blocks"]] == [0, 1, 2]
    assert [b["text"] for b in body["blocks"]] == ["first", "second", "third"]


def test_empty_paragraphs_preserve_indexes(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["first", "", "third"])
    audit_id = resp.json()["audit_id"]
    blocks = client.get(f"/api/audit/{audit_id}/document-blocks").json()["blocks"]
    assert len(blocks) == 3
    assert blocks[1]["text"] == ""
    assert blocks[2]["index"] == 2


def test_duplicate_text_remains_separate_blocks(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["same", "same", "same"])
    audit_id = resp.json()["audit_id"]
    blocks = client.get(f"/api/audit/{audit_id}/document-blocks").json()["blocks"]
    assert len(blocks) == 3
    assert [b["index"] for b in blocks] == [0, 1, 2]


def test_blocks_contain_only_contract_fields(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["alpha", "beta"])
    audit_id = resp.json()["audit_id"]
    blocks = client.get(f"/api/audit/{audit_id}/document-blocks").json()["blocks"]
    assert all(set(b.keys()) == BLOCK_KEYS for b in blocks)


def test_historical_null_returns_unavailable(client, test_engine):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    s.add(AuditRecord(id="hist-blocks-1", filename="old.docx", file_size=10,
                     weighted_score=90, deploy_mode="LOCAL", status="completed"))
    s.commit()
    s.close()

    body = client.get("/api/audit/hist-blocks-1/document-blocks").json()
    assert body["blocks"] is None
    assert body["audit_id"] == "hist-blocks-1"

    # Existing GET contract stays unchanged: no blocks field on the audit response.
    audit = client.get("/api/audit/hist-blocks-1").json()
    assert "document_blocks" not in audit


def test_unknown_audit_returns_404(client):
    resp = client.get("/api/audit/does-not-exist/document-blocks")
    assert resp.status_code == 404


def test_delete_removes_blocks_with_parent(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["to be deleted"])
    audit_id = resp.json()["audit_id"]
    assert client.get(f"/api/audit/{audit_id}/document-blocks").status_code == 200

    deleted = client.delete(f"/api/audit/{audit_id}")
    assert deleted.status_code == 200

    assert client.get(f"/api/audit/{audit_id}/document-blocks").status_code == 404


def test_existing_response_contract_unchanged(client, docx_factory):
    resp = _post_audit(client, docx_factory, ["body text"])
    body = resp.json()
    for key in ("status", "audit_id", "weighted_compliance_score",
                "physical_layout_errors", "ai_citation_tooltips",
                "score_breakdown", "document_stats", "major_count",
                "minor_count", "ai_review_status", "ai_provider"):
        assert key in body
    assert "document_blocks" not in body


def _strip_random_ids(payload):
    """Violation/citation ids are random UUIDs — drop them before comparing."""
    for v in payload.get("physical_layout_errors", []):
        v.pop("id", None)
    for c in payload.get("ai_citation_tooltips", []):
        c.pop("id", None)
    return payload


def test_blocks_persistence_does_not_change_audit_results(client, docx_factory):
    """8E regression: persisting document blocks must not perturb scoring,
    findings, statistics, or AI metadata — two identical audits agree
    field-for-field after stripping random ids."""
    def _post():
        r = client.post("/api/audit", files={"file": (
            "regression.docx",
            docx_factory(paragraphs=["First body paragraph.", "Second body paragraph."]),
            "application/octet-stream",
        )})
        assert r.status_code == 200
        return r.json()

    first = _strip_random_ids(_post())
    second = _strip_random_ids(_post())
    for key in ("weighted_compliance_score", "physical_layout_errors",
                "ai_citation_tooltips", "score_breakdown", "document_stats",
                "major_count", "minor_count", "ai_review_status", "ai_provider"):
        assert first[key] == second[key], f"blocks persistence changed {key}"


def test_migration_roundtrip_document_blocks(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config

    from app.config import settings as app_settings

    db_path = tmp_path / "blocks.db"
    url = f"sqlite:///{db_path}"
    backend_dir = Path(__file__).resolve().parents[1]

    cfg = Config()
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))

    def _columns():
        return {c["name"] for c in inspect(create_engine(url)).get_columns("audit_records")}

    monkeypatch.setattr(app_settings, "DATABASE_URL", url)

    command.upgrade(cfg, "head")
    assert "document_blocks" in _columns()

    command.downgrade(cfg, "b2c8d19e2b3f")
    assert "document_blocks" not in _columns()

    command.upgrade(cfg, "head")
    assert "document_blocks" in _columns()
