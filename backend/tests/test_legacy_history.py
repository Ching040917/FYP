"""Legacy history — NULL score after upgrade through Phase 3B."""
import pathlib, tempfile, sqlite3, uuid, os
import pytest

def _db_url(p): return f"sqlite:///{p.as_posix()}"

REVISIONS = [
    "f17a86596071", "a4c7d19e2b3f", "b2c8d19e2b3f", "c3d8d19e2b3f",
    "d4e8d19e2b3f", "e5f8d19e2b3f", "f6a8d19e2b3f",
]

@pytest.mark.parametrize("rev", REVISIONS)
def test_legacy_list_and_detail_null_score(tmp_path, rev):
    """Every older rev: create valid audit, upgrade, keep row, GET 200 with null preserved."""
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    import app.db_lifecycle as dl
    import app.launcher_support as ls
    from pathlib import Path
    from alembic.config import Config
    from alembic import command
    from app.config import settings
    import logging

    db = tmp_path / "audit.db"
    url = ls._sqlite_url(db)
    dl.init_fresh_database(db, url)
    # Downgrade to rev
    backend_dir = Path(__file__).resolve().parents[1]
    orig = settings.DATABASE_URL
    orig_env = os.environ.get("DATABASE_URL")
    try:
        os.environ["DATABASE_URL"] = url
        settings.DATABASE_URL = url
        cfg = Config(str(backend_dir / "alembic.ini"))
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        cfg.set_main_option("sqlalchemy.url", url)
        command.downgrade(cfg, rev)
    finally:
        settings.DATABASE_URL = orig
        if orig_env is None: os.environ.pop("DATABASE_URL", None)
        else: os.environ["DATABASE_URL"] = orig_env
        for name in list(logging.Logger.manager.loggerDict.keys()):
            try: logging.getLogger(name).disabled = False
            except: pass

    # Insert revision-valid audit with NULL score (historical)
    aid = str(uuid.uuid4())
    con = sqlite3.connect(str(db))
    con.execute("INSERT INTO audit_records (id, filename, file_size, status, weighted_score, deploy_mode) VALUES (?,?,?,?,?,?)",
                (aid, f"legacy-{rev}.docx", 100, "completed", None, "LOCAL"))
    con.commit()
    con.close()

    # Upgrade via Phase 3B path
    user_root = tmp_path / "ACA"
    user_root.mkdir()
    err = dl.upgrade_existing_database(db, url, user_root)
    assert err is None, err

    # Verify via API (use conftest in-memory override pattern but with file DB)
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from fastapi.testclient import TestClient
    from app.main import app
    from app.database import get_db, Base
    engine = create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Session = sessionmaker(bind=engine)
    def _ov():
        s = Session()
        try: yield s
        finally: s.close()
    from app.database import get_db as _get_db
    app.dependency_overrides[_get_db] = _ov
    client = TestClient(app)
    try:
        r = client.get("/api/audits")
        assert r.status_code == 200, r.text[:500]
        items = r.json()
        legacy = next(x for x in items if x["id"] == aid)
        assert legacy["weighted_score"] is None
        # No false zero
        assert legacy["weighted_score"] != 0

        r2 = client.get(f"/api/audit/{aid}")
        assert r2.status_code == 200
        assert r2.json()["weighted_score"] is None
        # Ensure no grade computed from zero

        # PDF export should be 409 unavailable (no stored result)
        r3 = client.get(f"/api/audit/{aid}/export-pdf")
        assert r3.status_code == 409

        # Modern audit via normal POST still works
        # Use docx_factory equivalent
        from tests.conftest import make_docx_bytes
        docx_bytes = make_docx_bytes(paragraphs=["Body text."], with_caption=False)
        r4 = client.post("/api/audit", files={"file": ("modern.docx", docx_bytes, "application/octet-stream")})
        assert r4.status_code == 200
        assert r4.json()["weighted_compliance_score"] is not None
        # List now has both
        r5 = client.get("/api/audits")
        assert len(r5.json()) >= 2
    finally:
        app.dependency_overrides.clear()
        engine.dispose()

    # Row preserved, not re-scored
    con = sqlite3.connect(str(db))
    row = list(con.execute("SELECT weighted_score FROM audit_records WHERE id=?", (aid,)))[0]
    assert row[0] is None
    con.close()
