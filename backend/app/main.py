import logging
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import routes
from app.database import init_db
from app.config import settings
from app.services.audit_recovery import reconcile_stale_audits
from app.services.guided_fix_storage import cleanup as cleanup_guided_outputs

# Root logging config so module-level loggers (app.api.routes, app.services.ai_citation)
# emit tracebacks and info lines to the server terminal.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

app = FastAPI(
    title="Academic Compliance Auditor API",
    description="Local-first .docx layout and APA citation compliance checker",
    version="1.0.0",
)

# CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)

# Production Frontend (Packaging Phase 1): when a built `frontend/dist`
# exists, serve static assets and explicit SPA fallback routes. Registered
# AFTER the API router so `/api/*`, `/health`, `/docs`, `/openapi.json` keep
# precedence. Missing dist → Backend-only development, unchanged.
from app.static_frontend import register_static_frontend, resolve_frontend_dist

_frontend_dist = resolve_frontend_dist()
if _frontend_dist is not None:
    register_static_frontend(app, _frontend_dist)

logger = logging.getLogger(__name__)


@app.on_event("startup")
async def startup():
    # 1. Capture process start (naive UTC) BEFORE any reconciliation.
    process_started_at = datetime.utcnow()
    # 2. Initialize the database schema (create_all only). Existing databases are
    #    upgraded automatically by the packaged launcher preflight before this
    #    backend starts, so no manual Alembic step is required.
    try:
        init_db()
    except Exception:
        try:
            from app.launcher_support import write_startup_failure
            write_startup_failure("DATABASE_UPGRADE_OR_VERIFICATION_FAILURE")
        except Exception:
            pass
        raise
    cleanup_guided_outputs()
    # 3. Run startup reconciliation for abandoned `processing` rows from an
    #    earlier process. Enabled by default for the supported local
    #    single-process deployment; the settings flag can disable it.
    if settings.AUDIT_RECONCILE_ON_START:
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            reconcile_stale_audits(db, process_started_at, enabled=True)
        except Exception:
            try:
                from app.launcher_support import write_startup_failure
                write_startup_failure("DATABASE_RECONCILIATION_REFUSAL")
            except Exception:
                pass
            # Migration/schema mismatch must fail startup rather than serve
            # against an incompatible database. Safe message — no paths,
            # stack traces, or document content.
            logger.error("stale audit reconciliation failed at startup")
            raise RuntimeError(
                "ACA could not safely verify the existing data. Your data has not been "
                "replaced. Close ACA and review the data-folder recovery steps in the "
                "troubleshooting guide before trying again."
            )
        finally:
            db.close()


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "academic-compliance-auditor"}