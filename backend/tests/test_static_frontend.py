"""Static Frontend serving tests (Packaging Phase 1 PoC).

Covers route precedence, SPA fallback for direct refresh, asset MIME types,
path traversal rejection, and dev-mode parity when dist is absent.
Uses synthetic dist fixtures on fresh FastAPI apps — no real network, no
backend/audit.db access.
"""
import asyncio
import hashlib
import warnings
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
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
# Packaged sample thesis DOCX route tests
# ---------------------------------------------------------------------------


def test_sample_route_serves_synthetic_fixture_bytes(dist_dir):
    samples_dir = dist_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    synthetic_bytes = b"PK\x03\x04synthetic-docx-content"
    (samples_dir / "sample-thesis.docx").write_bytes(synthetic_bytes)

    c = make_app(dist_dir)
    r = c.get("/samples/sample-thesis.docx")

    assert r.status_code == 200
    assert r.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert r.content == synthetic_bytes
    assert "content-disposition" not in r.headers


def test_sample_route_head_method(dist_dir):
    samples_dir = dist_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    synthetic_bytes = b"PK\x03\x04synthetic-docx-content"
    (samples_dir / "sample-thesis.docx").write_bytes(synthetic_bytes)

    c = make_app(dist_dir)
    r = c.head("/samples/sample-thesis.docx")

    assert r.status_code == 200
    assert r.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert r.content == b""


def test_sample_route_returns_404_when_missing(dist_dir):
    # dist_dir has no samples/sample-thesis.docx
    c = make_app(dist_dir)
    r = c.get("/samples/sample-thesis.docx")

    assert r.status_code == 404
    assert "application/json" in r.headers.get("content-type", "")
    assert r.json().get("detail") == "Sample document not found"
    assert "text/html" not in r.headers.get("content-type", "")
    assert "<!doctype html>" not in r.text


def test_sample_thesis_repository_asset_integrity():
    repo_root = Path(__file__).resolve().parents[2]
    sample_path = repo_root / "frontend" / "public" / "samples" / "sample-thesis.docx"

    assert sample_path.is_file(), f"Sample DOCX missing at {sample_path}"
    file_bytes = sample_path.read_bytes()
    expected_sha256 = "1c2350d3410ec204a7e8f8cb29d6ea438ecb08f4e0c6de9fe9d3a09315a617bb"
    actual_sha256 = hashlib.sha256(file_bytes).hexdigest()
    assert actual_sha256 == expected_sha256, (
        f"SHA-256 mismatch: got {actual_sha256}, expected {expected_sha256}"
    )
    assert len(file_bytes) == 37764, f"File size mismatch: got {len(file_bytes)}, expected 37764"

    with zipfile.ZipFile(sample_path) as zf:
        names = zf.namelist()
        assert "word/document.xml" in names, "Missing word/document.xml"
        assert "docProps/core.xml" in names, "Missing docProps/core.xml"

        core_xml = zf.read("docProps/core.xml")
        root = ET.fromstring(core_xml)
        ns = {
            "dc": "http://purl.org/dc/elements/1.1/",
            "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
        }
        creator = root.find("dc:creator", ns)
        description = root.find("dc:description", ns)
        assert creator is not None and creator.text == "python-docx"
        assert description is not None and description.text == "generated by python-docx"


def test_sample_route_rejects_raw_and_encoded_traversal(dist_dir):
    samples_dir = dist_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)
    (samples_dir / "sample-thesis.docx").write_bytes(b"PK\x03\x04synthetic-docx-content")

    app = FastAPI()
    register_static_frontend(app, dist_dir)

    # 1. Raw ASGI scope dispatch bypassing TestClient URL normalization
    sent_messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent_messages.append(message)

    raw_scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/samples/../index.html",
        "raw_path": b"/samples/../index.html",
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 80),
    }
    asyncio.run(app(raw_scope, receive, send))
    response_start = next(msg for msg in sent_messages if msg["type"] == "http.response.start")
    assert response_start["status"] == 404

    c = TestClient(app)

    # 2. Single-encoded traversal
    r_single = c.get("/samples/%2e%2e/index.html")
    assert r_single.status_code == 404
    assert "text/html" not in r_single.headers.get("content-type", "")

    # 3. Double-encoded traversal
    r_double = c.get("/samples/%252e%252e/index.html")
    assert r_double.status_code == 404
    assert "text/html" not in r_double.headers.get("content-type", "")

    # 4. Encoded slash traversals
    for path in ("/samples/..%2findex.html", "/samples/..%5cindex.html"):
        r_slash = c.get(path)
        assert r_slash.status_code == 404
        assert "text/html" not in r_slash.headers.get("content-type", "")

    # 5. Non-matching and directory paths
    for path in ("/samples/other.docx", "/samples/", "/samples"):
        r_other = c.get(path)
        assert r_other.status_code == 404
        assert "text/html" not in r_other.headers.get("content-type", "")


def test_sample_route_no_openapi_side_effects(dist_dir):
    (dist_dir / "samples").mkdir(parents=True, exist_ok=True)
    (dist_dir / "samples" / "sample-thesis.docx").write_bytes(b"PK\x03\x04test")
    app = FastAPI()
    register_static_frontend(app, dist_dir)
    with warnings.catch_warnings(record=True) as ws:
        warnings.simplefilter("always")
        schema = app.openapi()
        assert not ws, f"Unexpected openapi warnings: {[str(w.message) for w in ws]}"
    assert "/samples/sample-thesis.docx" not in schema.get("paths", {})


def test_sample_route_does_not_conflict_with_api_or_spa(dist_dir):
    (dist_dir / "samples").mkdir(parents=True, exist_ok=True)
    (dist_dir / "samples" / "sample-thesis.docx").write_bytes(b"PK\x03\x04test")
    app = FastAPI()

    @app.get("/api/test")
    def api_test():
        return {"route": "api"}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    register_static_frontend(app, dist_dir)
    c = TestClient(app)

    # API route
    r_api = c.get("/api/test")
    assert r_api.status_code == 200
    assert r_api.json() == {"route": "api"}

    # Health route
    r_health = c.get("/health")
    assert r_health.status_code == 200
    assert r_health.json() == {"status": "ok"}

    # SPA routes
    r_dash = c.get("/dashboard")
    assert r_dash.status_code == 200
    assert "<div id='root'>" in r_dash.text
    assert "text/html" in r_dash.headers["content-type"]

    r_audit = c.get("/audit/abc")
    assert r_audit.status_code == 200
    assert "<div id='root'>" in r_audit.text
    assert "text/html" in r_audit.headers["content-type"]

    # Sample route
    r_sample = c.get("/samples/sample-thesis.docx")
    assert r_sample.status_code == 200
    assert r_sample.content == b"PK\x03\x04test"

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
