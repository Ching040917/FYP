# Academic Compliance Auditor (ACA)

ACA is a local-first web application that audits academic DOCX documents against configurable formatting requirements and APA 7 citation patterns. Deterministic checks run entirely on your machine; optional AI-assisted citation review is opt-in.

## Core capabilities

- **DOCX compliance audit** — font consistency, font sizes, paragraph typography, page margins, heading hierarchy, media captions, and APA 7 citation checks.
- **Formatting Profiles** — built-in SUC Academic Report and APA 7 Student Paper profiles, plus custom profiles you create, validate in-app, and store locally in your browser.
- **Weighted scoring** — a single compliance score with per-category verdicts; major findings weigh more than minor ones.
- **Role-aware findings** — each finding links to the exact paragraph with evidence (rendered-page preview when LibreOffice is available, or extracted text otherwise).
- **Audit History** — every audit is stored locally with score, findings, profile snapshot, and PDF export. Historical audits with unavailable scores display `Unavailable` and remain readable after database upgrades.
- **Setup Readiness** — the Dashboard reports whether ACA and its optional components are ready.

## Supported platform

- Windows 10/11 desktop.
- Recommended viewport width: 1280 px or above.
- Minimum supported desktop width: 768 px.
- Mobile local execution is not supported.

## Packaged release overview

A Windows one-folder release is built with PyInstaller (`backend/dist/run-frozen/run-frozen.exe`). The packaged application:

- Requires no Python or Node.js at runtime.
- Bundles the production Frontend and all Python dependencies.
- Stores all mutable data under `%LOCALAPPDATA%\AcademicComplianceAuditor` (see Installation Guide for layout and database lifecycle).
- Binds only to `127.0.0.1` on ports `8010–8015`, opens the default browser after health succeeds, reuses a healthy instance on second launch, and stops only the owned Backend on close via a Windows Job Object.
- Creates fresh production databases automatically through Alembic and upgrades known older packaged databases only after a verified SQLite backup (three newest verified backups retained). Unsupported databases are refused without deletion.

No public download URL is published in this repository. Obtain the verified one-folder release through your distribution channel and keep the entire extracted folder together (`run-frozen.exe` and `_internal` must stay together).

See the [Installation Guide](docs/INSTALLATION.md) for packaged and source setup.

## Requirements

**For the packaged release:** no Python or Node.js required. Optional components below still apply if you want their features.

**For source development:**

| Component | Purpose |
|---|---|
| Git | Clone this repository |
| Python 3.11+ (verified with 3.13.x) | Backend runtime |
| Node.js 18 LTS+ (24.x verified) | Frontend build tooling |

Optional for both modes:

| Component | Purpose |
|---|---|
| LibreOffice | Rendered-page preview (PDF). Without it, deterministic checks still run and extracted-text evidence remains available. |
| Ollama + configured model `qwen3.5:4b` | Local AI-assisted citation review. Without it, deterministic checks still run. |
| Cloud AI (Gemini) | Remote citation review, **explicit opt-in** per audit. Credentials are user-provided; no key is bundled. |

## Source development (not ordinary end-user installation)

```powershell
# Backend
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
python -m alembic upgrade head
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev
```

Then open `http://localhost:5173` and verify `GET http://127.0.0.1:8000/health` returns `{"status":"healthy"}` and `GET http://127.0.0.1:8000/api/readiness` reports `overall: ready` (or `degraded` when optional components are absent).

For the full Windows PowerShell steps, database migration notes, and verification commands, see [docs/INSTALLATION.md](docs/INSTALLATION.md) — **Option 2** is clearly labeled as source development.

## Documentation

- [Installation Guide](docs/INSTALLATION.md) — packaged release and source setup, local data, database lifecycle, and limitations
- User guide *(planned)*
- Privacy notes *(planned)*
- Troubleshooting *(planned)*
- Known limitations *(planned)*
- Third-party notices *(planned)*

## License status

This is an academic Final Year Project repository. No software license has been selected yet; all rights are reserved by the author until one is added.
