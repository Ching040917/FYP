"""Static Frontend serving (Packaging Phase 1 PoC).

Registers production Frontend routes on the FastAPI app when a built
`frontend/dist` directory is available. Absent dist → registers nothing and
Backend-only development keeps working byte-for-byte.

Route-safety contract:
- API routes are registered BEFORE this module runs, so `/api/*`, `/health`,
  `/docs`, and `/openapi.json` always win.
- Only explicit SPA paths fall back to `index.html` — no catch-all, so an
  unknown `/api/*` path returns the normal JSON 404.
- Static assets are served by Starlette's StaticFiles (containment built in);
  SPA fallbacks return a fixed `index.html`, never user-controlled paths.
"""
from fastapi import FastAPI
from fastapi.responses import FileResponse
from starlette.staticfiles import StaticFiles
import sys
from pathlib import Path


def resolve_frontend_dist() -> Path | None:
    """Locate the built Frontend assets in source or frozen mode.

    - PyInstaller one-folder (6.x): datas live under ``sys._MEIPASS``
      (``<exe-parent>/_internal``); also accept legacy exe-sibling layout.
    - Source/production run: `<repo>/frontend/dist`.
    Returns None when not found — Backend development never requires it.
    Independent of the current working directory.
    """
    if getattr(sys, "frozen", False):
        candidates = []
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(Path(meipass) / "frontend-dist")
        candidates.append(Path(sys.executable).resolve().parent / "frontend-dist")
        for candidate in candidates:
            if candidate.is_dir() and (candidate / "index.html").is_file():
                return candidate
        return None
    candidate = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if candidate.is_dir() and (candidate / "index.html").is_file():
        return candidate
    return None


# SPA routes served with index.html for direct refresh support.
SPA_ROUTES = ("/", "/dashboard", "/history", "/profiles/custom")


def register_static_frontend(app: FastAPI, dist_dir: Path) -> None:
    """Mount static assets + explicit SPA fallbacks onto `app`.

    Call AFTER all API routers are registered so `/api/*` precedence holds.
    Assets mount provides correct MIME types and path containment; the SPA
    fallback serves only the fixed `index.html`. An incomplete dist
    (missing index.html) registers nothing.
    """
    index_html = dist_dir / "index.html"
    if not index_html.is_file():
        return

    if (dist_dir / "assets").is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=dist_dir / "assets"),
            name="spa-assets",
        )

    def _spa() -> FileResponse:
        return FileResponse(index_html, media_type="text/html")

    app.get("/")(_spa)
    for route in SPA_ROUTES[1:]:
        app.get(route)(_spa)

    # Audit detail pages carry an id segment: /audit/<uuid>.
    def _audit_spa(audit_id: str) -> FileResponse:
        return FileResponse(index_html, media_type="text/html")

    app.get("/audit/{audit_id}")(_audit_spa)
