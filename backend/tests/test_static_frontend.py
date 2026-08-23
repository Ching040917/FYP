"""Static Frontend serving tests (Packaging Phase 1 PoC).

Covers route precedence, SPA fallback for direct refresh, asset MIME types,
path traversal rejection, and dev-mode parity when dist is absent.
Uses synthetic dist fixtures on fresh FastAPI apps — no real network, no
backend/audit.db access.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.static_frontend import register_static_frontend


@pytest.fixture
def dist_dir(tmp_path):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text(
        "<!doctype html><html><body><div id='root'></div>"
        "<script src='/assets/index-test.js'></script></body></html>",
        encoding="utf-8",
    )
    (d / "assets" / "index-test.js").write_text("console.log('aca')", encoding="utf-8")
    (d / "assets" / "style.css").write_text("body{}", encoding="utf-8")
    return d


def make_app(dist_dir, with_api=True):
    app = FastAPI()
    if with_api:
        @app.get("/api/thing")
        def thing():
            return {"ok": True}
    register_static_frontend(app, dist_dir)
    return TestClient(app)


def test_spa_root_serves_index_html(dist_dir):
    c = make_app(dist_dir)
    r = c.get("/")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "index-test.js" in r.text


@pytest.mark.parametrize("route", ["/dashboard", "/history", "/profiles/custom", "/audit/abc-123"])
def test_direct_refresh_returns_shell_for_all_spa_routes(dist_dir, route):
    c = make_app(dist_dir)
    r = c.get(route)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert "<div id='root'>" in r.text


def test_static_js_asset_served_with_correct_mime(dist_dir):
    c = make_app(dist_dir)
    r = c.get("/assets/index-test.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["content-type"]


def test_static_css_asset_served_with_correct_mime(dist_dir):
    (dist_dir / "assets" / "style.css").write_text("body{}", encoding="utf-8")
    c = make_app(dist_dir)
    r = c.get("/assets/style.css")
    assert r.status_code == 200
    assert "css" in r.headers["content-type"]


def test_unknown_api_route_returns_json_404_not_index_html(dist_dir):
    c = make_app(dist_dir)
    r = c.get("/api/does-not-exist")
    assert r.status_code == 404
    assert r.json() == {"detail": "Not Found"}
    assert "text/html" not in r.headers.get("content-type", "")


def test_api_route_takes_precedence_over_spa(dist_dir):
    # /audit/<id> is an SPA route; /api/... must never fall through to it.
    c = make_app(dist_dir)
    r = c.get("/api/thing")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_health_docs_openapi_unaffected_by_registration(dist_dir):
    app = FastAPI()
    from fastapi.testclient import TestClient as TC

    register_static_frontend(app, dist_dir)
    c = TC(app)
    # FastAPI built-ins stay functional and JSON/UI as expected.
    assert c.get("/openapi.json").status_code == 200
    assert c.get("/docs").status_code == 200
    assert c.get("/docs").headers["content-type"].startswith("text/html")


def test_path_traversal_rejected(dist_dir):
    c = make_app(dist_dir)
    r = c.get("/assets/..%2F..%2Fsecret.txt")
    assert r.status_code in (400, 404)
    # Direct traversal shape is also blocked by StaticFiles containment.
    r2 = c.get("/assets/../index.html")
    assert r2.status_code in (400, 404)


def test_missing_dist_registers_nothing(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    c = make_app(empty)
    r = c.get("/")
    assert r.status_code == 404  # no SPA routes registered


# ---------------------------------------------------------------------------
# Frozen resource resolution (pure path logic — no exe build here)
# ---------------------------------------------------------------------------


def test_resolver_frozen_mode_prefers_meipass_then_exe_sibling(monkeypatch, tmp_path):
    """PyInstaller 6 one-folder: datas live under <exe>/_internal (sys._MEIPASS)."""
    import sys
    from pathlib import Path
    from app import static_frontend as sf

    fake_exe = tmp_path / "run-frozen.exe"
    internal = tmp_path / "_internal" / "frontend-dist"
    internal.mkdir(parents=True)
    (internal / "index.html").write_text("x", encoding="utf-8")

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "_internal"), raising=False)
    monkeypatch.setattr(sf.sys, "executable", str(fake_exe))

    resolved = sf.resolve_frontend_dist()
    assert resolved == internal

    # Legacy exe-sibling layout still supported as fallback.
    legacy = tmp_path / "frontend-dist" / "index.html"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("y", encoding="utf-8")
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    resolved2 = sf.resolve_frontend_dist()
    assert resolved2 == legacy.parent


def test_resolver_returns_none_when_no_frontend_anywhere(monkeypatch, tmp_path):
    import sys
    from app import static_frontend as sf

    fake_exe = tmp_path / "run-frozen.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(fake_exe))
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    assert sf.resolve_frontend_dist() is None


def test_resolver_source_mode_uses_repo_frontend_dist(monkeypatch):
    import sys
    from pathlib import Path
    from app import static_frontend as sf

    monkeypatch.setattr(sys, "frozen", False, raising=False)
    repo_dist = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    if not (repo_dist / "index.html").is_file():
        pytest.skip("frontend/dist not built on this machine")
    # Simulate the module living at its normal source location so
    # parents[2] resolves to the repo root.
    monkeypatch.setattr(
        sf, "__file__", str(repo_dist.parents[2] / "app" / "static_frontend.py")
    )
    resolved = sf.resolve_frontend_dist()
    assert resolved == repo_dist
