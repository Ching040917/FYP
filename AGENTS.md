# AGENTS.md — Academic Compliance Auditor

## Quick Start

```bash
# Backend (FastAPI, Python 3.11+)
cd backend
python -m venv .venv && .venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Ensure .env exists (see .env.example) — DATABASE_URL, DEPLOY_MODE, OLLAMA_HOST

# Frontend (React + Vite)
cd frontend
npm install
npm run dev          # :5173, proxies /api → :8000
```

## Development startup (verified workflow)

Three processes must be running in three separate terminals. The backend
and frontend terminals must stay open — closing either one stops the app.

**Terminal 1 — Ollama (verify, do not restart if already running):**

```powershell
ollama list            # must show qwen3.5:4b installed
# Ollama runs as a background service on 127.0.0.1:11434.
# If "connection refused": start Ollama from the Start menu, wait, re-check.
```

**Terminal 2 — FastAPI backend (from `backend/`):**

```powershell
python -m uvicorn app.main:app --reload
# Starts on http://127.0.0.1:8000
# Verify: http://127.0.0.1:8000/health → {"status":"healthy",...}
```

If `uvicorn` is not on PATH, install dependencies first (`pip install -r
requirements.txt`) or use the venv (`python -m venv .venv` once, then
`.venv\Scripts\Activate.ps1` before the uvicorn command).

**Terminal 3 — Vite frontend (from `frontend/`):**

```powershell
npm run dev
# Starts on http://localhost:5173 — open this URL in the browser.
# Vite proxies /api → http://127.0.0.1:8000 (vite.config.ts).
```

**Troubleshooting**

- `[vite] http proxy error ... ECONNREFUSED` on `/api/...`: the backend is
  not running (or crashed). Start Terminal 2 and check `/health`.
- The proxy targets `127.0.0.1:8000`, not `localhost`, because Node
  resolves `localhost` to `::1` first on Windows while uvicorn binds
  `127.0.0.1` only — never "fix" this by reverting the proxy target.
- Both terminals (2 and 3) must remain running for the app to work.

## Commands

```bash
# Backend tests (in-memory SQLite, no network — AI task is mocked in conftest)
cd backend && pytest                              # all
cd backend && pytest tests/test_edge_cases.py     # single file
cd backend && pytest -k "test_malformed"          # single test

# Backend lint
cd backend && python -m py_compile app/**/*.py   # quick syntax check

# Frontend
cd frontend && npx tsc --noEmit                  # typecheck
cd frontend && npm run build                     # production build
```

## Architecture

```
React frontend (:5173) ──HTTP──► FastAPI backend (:8000) ──reads──► Target .docx
                                    │
                    ┌───────────────┴──────────────┐
                    ▼                               ▼
          Layout Rules Engine                AI Citation Engine
          (python-docx, deterministic)       Ollama (qwen3.5:4b) ← default
          <0.5s, synchronous                  Gemini 1.5 Flash ← UI-gated opt-in
```

**Key flow** (`POST /api/audit`):
1. Validate `.docx` extension + 10 MB cap → 400 on violation
2. Run `run_static_rules_engine` synchronously → layout violations + score
3. Run `async_ai_citation_task` synchronously (not BackgroundTasks anymore) → citation issues
4. Both results returned in single response

**Dual-engine rule**: Cloud path is **disabled by default** (`DEPLOY_MODE=LOCAL`). The `cloud` query param on `/api/audit` flips it for that request only. Never auto-enable cloud.

**AI output boundary**: `parse_ai_json` + `_sanitize_issues` is the defensive layer. Drops unknown `issue_type` values, confidence < 0.6, and snippets not found in source. Never let AI crash the request.

## Hard Constraints (from PRD.md)

- **Read-only.** Never rewrite the user's `.docx`.
- **`.docx` only.** No PDF, no LaTeX, no grammar, no plagiarism.
- **Files in memory only.** Never write back to disk.
- **Cloud mode is opt-in.** Must come from explicit UI toggle + `cloud=true` query param.

## Config

All env vars in `backend/.env` (copy from `.env.example`):

| Var | Default | Notes |
|-----|---------|-------|
| `DEPLOY_MODE` | `LOCAL` | `LOCAL` or `CLOUD` |
| `MAX_FILE_SIZE` | `10485760` | 10 MB in bytes |
| `GEMINI_API_KEY` | — | Required only for CLOUD |
| `OLLAMA_HOST` | `http://localhost:11434` | |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Set in `.env`, not `.env.example` |
| `DATABASE_URL` | `sqlite:///./audit.db` | SQLite; in-memory in tests |

## Test Quirks

- `conftest.py` overrides `get_db` with an in-memory SQLite engine per test.
- `mock_ai_task` fixture patches `async_ai_citation_task` to return a completed-empty `AiCitationResult` - no network in tests.
- `mock_init_db` prevents startup from writing to `./audit.db`.
- Use `client_with_small_cap` fixture (with `small_file_cap`) for oversize tests — never `client` directly.
- `make_docx_bytes()` factory builds valid docx in-memory via `python-docx`.

## Scoring

- `base_score = 100`, deduct per violation.
- `MAJOR` violations (margins, heading hierarchy) weight heavier than `MINOR` (typography).
- Detailed breakdown in `app/services/scoring.py` → `calculate_weighted_score_detailed()`.
- Frontend mirror of scoring in `frontend/src/lib/audit/scoring.ts`.

## Evidence-Linked Document Preview (Builds 8B–8E)

Purpose: on the audit page, map each finding to the extracted paragraph in the
source document. Read-only, paragraph-level scope only.

- **New audits only**: `document_blocks` is persisted at POST time. Audits
  created before the column existed return `blocks: null` and the UI shows
  "Preview unavailable — this audit predates document preview support."
- **Local persistence**: extracted paragraph text is stored in
  `audit_records.document_blocks` (JSON column on the local SQLite database)
  so previews can be reopened from history. The original `.docx` is never
  stored or modified — files are processed in memory only. The UI states this
  disclosure next to the preview.
- **Endpoint**: `GET /api/audit/{id}/document-blocks` →
  `{"audit_id": str, "blocks": DocumentBlock[] | null}`. Deleting an audit
  removes its blocks with it (column on the parent row).
- **Block contract**: `{order, type, index, text, style_name, heading_level}`.
  `index` is the zero-based paragraph identity (equals
  `violation.location.paragraph_index`); `order` controls ordering only;
  `heading_level` is 1–6 or null.
- **Index conventions**: backend `index` is zero-based; the UI displays
  "Paragraph N" one-based (`index + 1`). Backend index 9 → "Paragraph 10".
- **Explicit exclusions** (do not extend without a build spec): exact
  pagination, images, tables, editing, rewriting, and pixel-perfect Word
  rendering.

## Frontend Routes

| Path | Component |
|------|-----------|
| `/` | `Landing` (marketing + embedded dashboard) |
| `/dashboard` | `Dashboard` (upload + results) |
| `/history` | `HistoryPage` |
| `/audit/:auditId` | `AuditPage` (detail + polling) |

`DashboardContent` is reused on both `/dashboard` and `/` — don't duplicate upload logic.

## Design System

Source of truth: `stitch_academic_compliance_auditor/.../DESIGN.md` and the prototype at `.../academic_compliance_auditor_dashboard/code.html`.

- Dark mode, deep-space palette: Indigo primary `#c0c1ff`, Emerald success `#4edea3`, Rose error `#ffb4ab`.
- `darkMode: "class"` in `tailwind.config.js` — toggle via class on `<html>`.
- Tonal layering, not shadows. Cards = `surface-container` with 1px `outline-variant` border.
- Font: Inter (UI), JetBrains Mono (IDs, reference codes).
- Logo: 24×24 SVG shield at `academic_compliance_auditor_logo/code.html`.

## Known Limitations

- `python-docx` does not fully capture Word font inheritance and run-level overrides. Global styles + paragraph-level checks only. Inline run overrides may slip past.
- AI models can hallucinate or return malformed JSON. The `parse_ai_json` fallback + `_sanitize_issues` guard is the first-class boundary, not a corner case.

## Files of Interest

| File | Purpose |
|------|---------|
| `backend/app/services/layout_engine.py` | All static layout checks |
| `backend/app/services/document_parser.py` | `extract_document_blocks` — structured preview blocks |
| `backend/app/services/ai_citation.py` | AI prompt, parser, sanitizer |
| `backend/app/services/scoring.py` | Weighted score calculation |
| `backend/app/api/routes.py` | FastAPI endpoints (incl. `GET /audit/{id}/document-blocks`) |
| `backend/tests/conftest.py` | Test fixtures (docx factory, in-memory DB) |
| `backend/tests/test_document_blocks_api.py` | Blocks persistence, contract, deletion, migration tests |
| `frontend/src/services/api.ts` | HTTP client wrapper |
| `frontend/src/components/audit/document-preview.tsx` | Preview UI: mapping, highlighting, states, disclosure |
| `frontend/src/lib/audit/` | Frontend scoring/stats mirroring backend |
