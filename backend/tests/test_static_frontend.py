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
    # Route fixture only: these bytes are not a real audited DOCX.
    samples = dist_dir / "samples"
    samples.mkdir()
    payload = b"PK\x03\x04synthetic-docx-content"
    (samples / "sample-thesis.docx").write_bytes(payload)
    response = make_app(dist_dir).get("/samples/sample-thesis.docx")
    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert "content-disposition" not in response.headers


def test_sample_route_head_method(dist_dir):
    samples = dist_dir / "samples"
    samples.mkdir()
    payload = b"PK\x03\x04synthetic-docx-content"
    (samples / "sample-thesis.docx").write_bytes(payload)
    client = make_app(dist_dir)
    get = client.get("/samples/sample-thesis.docx")
    head = client.head("/samples/sample-thesis.docx")
    assert get.status_code == head.status_code == 200
    assert get.content == payload
    assert head.content == b""
    for header in ("content-type", "content-length", "etag", "last-modified"):
        assert get.headers[header] == head.headers[header]
    assert int(head.headers["content-length"]) == len(payload)
    assert "content-disposition" not in get.headers
    assert "content-disposition" not in head.headers


def test_sample_route_returns_404_when_missing(dist_dir):
    client = make_app(dist_dir)
    get = client.get("/samples/sample-thesis.docx")
    head = client.head("/samples/sample-thesis.docx")
    assert get.status_code == head.status_code == 404
    assert get.json() == {"detail": "Sample document not found"}
    assert head.content == b""
    for response in (get, head):
        assert response.headers["content-type"].startswith("application/json")
        assert b"<html" not in response.content.lower()
        assert str(dist_dir).encode() not in response.content


def test_sample_thesis_repository_asset_integrity():
    sample = Path(__file__).resolve().parents[2] / "frontend/public/samples/sample-thesis.docx"
    payload = sample.read_bytes()
    assert len(payload) == 37764
    assert hashlib.sha256(payload).hexdigest() == (
        "1c2350d3410ec204a7e8f8cb29d6ea438ecb08f4e0c6de9fe9d3a09315a617bb"
    )
    with zipfile.ZipFile(sample) as archive:
        assert "word/document.xml" in archive.namelist()
        assert "docProps/core.xml" in archive.namelist()
        core = ET.fromstring(archive.read("docProps/core.xml"))
        ns = {"dc": "http://purl.org/dc/elements/1.1/"}
        assert core.find("dc:creator", ns).text == "python-docx"
        assert core.find("dc:description", ns).text == "generated by python-docx"


def test_sample_route_rejects_raw_and_encoded_traversal(dist_dir):
    (dist_dir / "samples").mkdir()
    (dist_dir / "samples/sample-thesis.docx").write_bytes(
        b"PK\x03\x04synthetic-docx-content"
    )
    app = FastAPI()
    register_static_frontend(app, dist_dir)
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    # Raw scope bypasses client URL normalization.
    scope = {
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
    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    assert start["status"] == 404
    assert b"application/json" in dict(start["headers"])[b"content-type"]
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    assert b"<html" not in body.lower()
    client = TestClient(app)
    for path in (
        "/samples/%2e%2e/index.html",
        "/samples/%252e%252e/index.html",
        "/samples/..%2findex.html",
        "/samples/..%5cindex.html",
        "/samples",
        "/samples/",
        "/samples/other.docx",
    ):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.headers["content-type"].startswith("application/json"), path
        assert b"<html" not in response.content.lower(), path


def test_sample_route_no_openapi_side_effects(dist_dir):
    app = FastAPI()
    register_static_frontend(app, dist_dir)
    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter("always")
        schema = app.openapi()
    assert not captured, [str(w.message) for w in captured]
    assert "/samples/sample-thesis.docx" not in schema["paths"]


def test_sample_route_does_not_conflict_with_api_or_spa(dist_dir):
    (dist_dir / "samples").mkdir()
    (dist_dir / "samples/sample-thesis.docx").write_bytes(b"PK\x03\x04test")
    app = FastAPI()

    @app.get("/api/test")
    def api_test():
        return {"route": "api"}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    register_static_frontend(app, dist_dir)
    client = TestClient(app)
    assert client.get("/api/test").json() == {"route": "api"}
    assert client.get("/health").json() == {"status": "ok"}
    for path in ("/dashboard", "/audit/abc"):
        response = client.get(path)
        assert response.status_code == 200
        assert "<div id='root'>" in response.text
        assert response.headers["content-type"].startswith("text/html")
    assert client.get("/samples/sample-thesis.docx").content == b"PK\x03\x04test"
    missing = client.get("/api/unknown")
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Not Found"}
    sample_routes = [r for r in app.routes if r.path.startswith("/samples")]
    assert [r.path for r in sample_routes] == ["/samples/sample-thesis.docx"]
    assert sample_routes[0].methods == {"GET", "HEAD"}


def test_sample_route_frozen_resource_layout(monkeypatch, tmp_path):
    import sys
    from app import static_frontend as sf

    payload = (
        Path(__file__).resolve().parents[2] / "frontend/public/samples/sample-thesis.docx"
    ).read_bytes()
    internal = tmp_path / "_internal/frontend-dist"
    legacy = tmp_path / "frontend-dist"
    for layout in (internal, legacy):
        (layout / "samples").mkdir(parents=True)
        (layout / "index.html").write_text("synthetic shell", encoding="utf-8")
        (layout / "samples/sample-thesis.docx").write_bytes(payload)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "_internal"), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "ACA.exe"))
    assert sf.resolve_frontend_dist() == internal
    for layout in (internal, legacy):
        assert sf.resolve_frontend_dist() == layout
        client = make_app(sf.resolve_frontend_dist())
        get = client.get("/samples/sample-thesis.docx")
        head = client.head("/samples/sample-thesis.docx")
        assert get.status_code == head.status_code == 200
        assert get.content == payload
        assert head.content == b""
        for header in ("content-type", "content-length", "etag", "last-modified"):
            assert get.headers[header] == head.headers[header]
        assert int(head.headers["content-length"]) == len(payload)
        assert get.headers["content-type"] == (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        assert "content-disposition" not in get.headers
        assert "content-disposition" not in head.headers
        (layout / "samples/sample-thesis.docx").unlink()
        missing = client.get("/samples/sample-thesis.docx")
        assert missing.status_code == 404
        assert missing.json() == {"detail": "Sample document not found"}
        (layout / "index.html").unlink()
        assert make_app(layout).get("/samples/sample-thesis.docx").status_code == 404
    assert sf.resolve_frontend_dist() is None


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
