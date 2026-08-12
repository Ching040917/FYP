"""Guards: pytest must never target the real development database.

conftest.py forces DATABASE_URL=sqlite:///:memory: before any app module
import. These tests assert that invariant so a future refactor cannot
silently point the test process back at backend/audit.db.
"""
from app.config import settings
from app.database import engine


def test_settings_database_url_is_in_memory():
    assert settings.DATABASE_URL == "sqlite:///:memory:"


def test_app_engine_targets_in_memory_not_dev_db():
    url = str(engine.url)
    assert "audit.db" not in url
    assert ":memory:" in url
