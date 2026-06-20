import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import routes
from app.database import init_db

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


@app.on_event("startup")
async def startup():
    init_db()


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "academic-compliance-auditor"}