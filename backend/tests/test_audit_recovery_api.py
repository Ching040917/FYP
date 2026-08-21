"""Stale Audit recovery — API behavior tests (Build 1).

Verifies GET does not lazy-promote interrupted, returns safe interruption
metadata, export returns the conflict/unavailable response, and DELETE works
for interrupted rows. Uses the in-memory TestClient (never backend/audit.db).
"""
from datetime import datetime, timedelta

import pytest

from app.models.audit import AuditRecord


@pytest.fixture
def client(test_engine, mock_ai_task, mock_init_db):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker
    from app.database import get_db
    from app.main import app

    Session = sessionmaker(bind=test_engine)
    def _override():
        db = Session()
        try:
            yield db
        finally:
            db.close()
    app.dependency_overrides[get_db] = _override
    c = TestClient(app)
    try:
        with c:
            yield c
    finally:
        app.dependency_overrides.clear()


def test_get_interrupted_returns_safe_metadata(client, test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit = AuditRecord(
        id="a1b2c3d4-0000-4000-8000-000000000002",
        filename="stale.docx", file_size=100, weighted_score=0,
        status="interrupted",
        created_at=datetime.utcnow() - timedelta(hours=1),
        interrupted_at=datetime.utcnow(),
        interruption_reason="application_restart",
    )
    s.add(audit); s.commit(); s.close()

    resp = client.get("/api/audit/a1b2c3d4-0000-4000-8000-000000000002")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "interrupted"
    assert body["interruption_reason"] == "application_restart"
    assert body["interrupted_at"] is not None
    # No findings/score fabricated.
    assert body["violations"] == []
    assert body["weighted_score"] == 0


def test_get_does_not_lazy_promote_interrupted(client, test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit = AuditRecord(
        id="a1b2c3d4-0000-4000-8000-000000000003",
        filename="stale.docx", file_size=100, weighted_score=0,
        status="interrupted",
        created_at=datetime.utcnow() - timedelta(hours=1),
        interrupted_at=datetime.utcnow(),
        interruption_reason="application_restart",
    )
    s.add(audit); s.commit(); s.close()

    client.get("/api/audit/a1b2c3d4-0000-4000-8000-000000000003")
    from sqlalchemy.orm import sessionmaker
    s2 = sessionmaker(bind=test_engine)()
    row = s2.query(AuditRecord).filter(AuditRecord.id == "a1b2c3d4-0000-4000-8000-000000000003").one()
    assert row.status == "interrupted"
    s2.close()


def test_export_interrupted_returns_conflict(client, test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit = AuditRecord(
        id="a1b2c3d4-0000-4000-8000-000000000004",
        filename="stale.docx", file_size=100, weighted_score=0,
        status="interrupted",
        created_at=datetime.utcnow() - timedelta(hours=1),
        interrupted_at=datetime.utcnow(),
        interruption_reason="application_restart",
    )
    s.add(audit); s.commit(); s.close()

    resp = client.get("/api/audit/a1b2c3d4-0000-4000-8000-000000000004/export-pdf")
    assert resp.status_code == 409
    assert "interrupted" in resp.json()["detail"].lower()


def test_delete_interrupted_works(client, test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    aid = "a1b2c3d4-0000-4000-8000-000000000005"
    s.add(AuditRecord(
        id=aid, filename="stale.docx", file_size=100, weighted_score=0,
        status="interrupted",
        created_at=datetime.utcnow() - timedelta(hours=1),
        interrupted_at=datetime.utcnow(),
        interruption_reason="application_restart",
    )); s.commit(); s.close()

    resp = client.delete(f"/api/audit/{aid}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"
    s2 = sessionmaker(bind=test_engine)()
    assert s2.query(AuditRecord).filter(AuditRecord.id == aid).first() is None
    s2.close()


def test_completed_api_unchanged(client, test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit = AuditRecord(
        id="a1b2c3d4-0000-4000-8000-000000000006",
        filename="done.docx", file_size=100, weighted_score=80,
        status="completed",
        created_at=datetime.utcnow() - timedelta(hours=1),
        completed_at=datetime.utcnow(),
    )
    s.add(audit); s.commit(); s.close()

    resp = client.get("/api/audit/a1b2c3d4-0000-4000-8000-000000000006")
    body = resp.json()
    assert body["status"] == "completed"
    assert body["interruption_reason"] is None
    assert body["interrupted_at"] is None
