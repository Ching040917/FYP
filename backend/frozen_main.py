"""PyInstaller frozen entry point (Packaging Phase 1 PoC).

Sets isolated PoC environment values BEFORE importing any application module
(settings reads env at import), then starts Uvicorn bound to 127.0.0.1 only.

Phase 1 exclusions: no browser auto-open, no dynamic ports, no single-instance
mutex, no automatic migration.
"""
import os
import sys
import tempfile
from pathlib import Path


def _configure_poc_environment() -> None:
    """Point mutable data at an isolated PoC location, never the source tree."""
    if getattr(sys, "frozen", False):
        bundle_dir = Path(sys.executable).resolve().parent
    else:  # direct `python frozen_main.py` from backend/
        bundle_dir = Path(__file__).resolve().parent

    poc_root = (
        Path(os.environ.get("LOCALAPPDATA") or Path.home())
        / "AcademicComplianceAuditor"
        / "poc"
    )
    poc_root.mkdir(parents=True, exist_ok=True)

    os.environ["DATABASE_URL"] = f"sqlite:///{(poc_root / 'poc.db').as_posix()}"
    os.environ["PREVIEW_STORAGE_DIR"] = str(poc_root / "rendered-previews")
    # PoC never carries user credentials; keep cloud AI unconfigured unless
    # the operator explicitly exports a key themselves.
    os.environ.setdefault("GEMINI_API_KEY", "")
    # Fixed Phase 1 test port (8010) — distinct from dev Backend on 8000.
    os.environ["ACA_POC_PORT"] = "8010"
    del bundle_dir  # reserved for later phases (alembic/ data resolution)


def main() -> None:
    _configure_poc_environment()

    # Static import AFTER environment configuration; PyInstaller's analysis
    # follows this function-level import and bundles the full app package.
    # Pass the app object (not the import string) so uvicorn needs no runtime
    # module lookup.
    from app.main import app as fastapi_app

    import uvicorn

    uvicorn.run(
        fastapi_app,
        host="127.0.0.1",
        port=int(os.environ["ACA_POC_PORT"]),
        log_level="info",
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
