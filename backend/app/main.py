import logging
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import routes
from app.database import init_db
from app.config import settings
from app.services.audit_recovery import reconcile_stale_audits

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

logger = logging.getLogger(__name__)


@app.on_event("startup")
async def startup():
    # 1. Capture process start (naive UTC) BEFORE any reconciliation.
    process_started_at = datetime.utcnow()
    # 2. Initialize the database schema (create_all only — Alembic migrations
    #    are applied manually by existing installations).
    init_db()
    # 3. Run startup reconciliation for abandoned `processing` rows from an
    #    earlier process. Enabled by default for the supported local
    #    single-process deployment; the settings flag can disable it.
    if settings.AUDIT_RECONCILE_ON_START:
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            reconcile_stale_audits(db, process_started_at, enabled=True)
        except Exception:
            # Migration/schema mismatch must fail startup rather than serve
            # against an incompatible database. Safe message — no paths,
            # stack traces, or document content.
            logger.exception("stale audit reconciliation failed at startup")
            raise RuntimeError(
                "Database schema is not ready for the current application. "
                "Run: python -m alembic upgrade head"
            )
        finally:
            db.close()


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "academic-compliance-auditor"}