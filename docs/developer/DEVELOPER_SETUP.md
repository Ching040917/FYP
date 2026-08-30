# Developer Setup — Academic Compliance Auditor

This guide is for developers and evaluators running ACA from source. It is **not** needed to use the packaged release — packaged users install the Setup EXE and need no development tools (see [Installation](../INSTALLATION.md)).

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Python | 3.11 or 3.12 (3.12 verified for release builds) | `python --version` |
| Node.js | 18 LTS+ (24.x verified) | `node --version` |
| npm | ships with Node | `npm --version` |

Python 3.13 is currently unsupported: the pinned dependency set lacks required Windows wheels for a clean install.

Optional: LibreOffice (rendered-page preview) and Ollama with the configured model `qwen3.5:4b` (local AI). Without them, deterministic checks still run.

## Backend setup

From the repository root in Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
# If script execution is blocked:
# Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
copy .env.example .env
python -m alembic upgrade head
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Keep this terminal open. On startup ACA applies stale-audit recovery and serves `http://127.0.0.1:8000`. The current migration head is `90fc17718e11`.

### Environment file (backend/.env)

| Variable | Default | Notes |
|---|---|---|
| `DEPLOY_MODE` | `LOCAL` | `LOCAL` or `CLOUD` |
| `DATABASE_URL` | `sqlite:///./audit.db` | Source database at `backend\audit.db` (git-ignored) |
| `OLLAMA_HOST` | `http://localhost:11434` | Local AI service |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Set in `.env` |
| `GEMINI_API_KEY` | *(empty)* | Required only for Cloud AI; never commit |

## Frontend setup

Open a second terminal from the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Keep this terminal open. The app is served at `http://localhost:5173`.

### Vite proxy behavior

The Vite dev server proxies `/api` and `/health` to `http://127.0.0.1:8000` (configured in `frontend/vite.config.ts`). The proxy targets `127.0.0.1` rather than `localhost` deliberately: Node resolves `localhost` to `::1` first on Windows, while the backend binds `127.0.0.1` only — using `localhost` causes proxy hangs. Do not "fix" the proxy target back to `localhost`.

## Verify the source installation

With both terminals running:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
# Expected: status = healthy

Invoke-RestMethod http://127.0.0.1:8000/api/readiness
# Expected: overall = ready (or degraded when optional components are absent)
```

Then open `http://localhost:5173` — the Dashboard readiness card should show **Ready to audit documents**. Use **Try with the sample thesis** or upload your own `.docx` (up to 10 MB) and inspect findings, evidence, and History.

## Source versus packaged databases

- **Source mode** stores audits in `backend\audit.db` (git-ignored).
- **Packaged mode** stores audits in `%LOCALAPPDATA%\AcademicComplianceAuditor\audit.db`.

They are fully separate. Running source mode never touches packaged data, and vice versa. The source database is created/upgraded with `python -m alembic upgrade head` (run it while the backend is stopped); packaged databases are managed automatically by the packaged launcher — never run Alembic against packaged data.

## Optional components in development

- **LibreOffice:** install it normally; ACA detects it at its default locations. `SOFFICE_EXECUTABLE` can override the path if needed.
- **Ollama:** install and start Ollama, then `ollama pull qwen3.5:4b`. Point `OLLAMA_HOST` at a different port for isolated testing.
- **Cloud AI:** set `GEMINI_API_KEY` in `.env` for explicit per-audit opt-in testing. Never commit the key.

## Stopping services

Press `Ctrl+C` in each terminal (backend first, then Vite). Closing the terminals has the same effect.

## Tests and checks

```powershell
# Backend tests (in-memory SQLite, no network; AI tasks are mocked)
cd backend
.venv\Scripts\Activate.ps1
python -m pytest

# Frontend
cd frontend
npx tsc --noEmit          # typecheck
node --test               # Node test suite
npm run build             # production build
npm run test:e2e          # Playwright suite (own isolated backend + ephemeral DB)
```

See [Build and Release](BUILD_AND_RELEASE.md) for packaging, and [Technical Troubleshooting](TECHNICAL_TROUBLESHOOTING.md) for diagnosing problems.
