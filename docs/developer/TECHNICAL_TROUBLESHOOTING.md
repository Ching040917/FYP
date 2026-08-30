# Technical Troubleshooting — Academic Compliance Auditor

This guide is for developers and evaluators. Ordinary-user problems are covered in [Troubleshooting](../TROUBLESHOOTING.md) — send users there first.

**Safety rule for all database work:** never attempt destructive recovery (deleting, replacing, stamping, or restoring databases) without a verified backup first. The packaged launcher already refuses unsupported states without modification; do not work around that refusal destructively.

---

## Packaged-user issues

These occur on an end user's machine. The safe actions below are what you may guide a user to do; anything beyond them requires collecting the launcher log for diagnosis.

### Source database revision mismatch

**Symptom (source mode):** backend fails to start with migration errors after switching branches.

**Cause:** `backend/audit.db` is stamped at an older revision than the code's migration head (`90fc17718e11`).

**Packaged-user action:** none — the launcher handles upgrades automatically. Never ask a user to run Alembic.

**Developer action:** with the backend stopped, run `python -m alembic upgrade head` from `backend/`. If the source database is disposable, deleting `backend/audit.db` is acceptable (it is git-ignored developer data) — but never apply this to packaged user data.

### Unsupported or corrupt databases (packaged)

**Symptom:** ACA refuses to start with one of these messages:

- *This database is not supported. Please contact support.* — tables exist but `alembic_version` is absent (unstamped legacy schema).
- *This database cannot be upgraded automatically.* — unknown or future revision.
- *Database file is corrupt. Please contact support.* — integrity check failed.
- *The database upgrade did not complete. Your backup was preserved. ACA cannot start until the database is recovered.* — backup, migration, or post-upgrade verification failed.

**Diagnosis (evaluator, with the user's consent):** inspect a **copy** of the database, never the original:

```sql
PRAGMA integrity_check;      -- expect: ok
PRAGMA foreign_key_check;    -- expect: no rows
SELECT version_num FROM alembic_version;  -- expect exactly one row
```

- Multiple rows in `alembic_version` = multiple heads (branch ambiguity) — ACA refuses these.
- Missing table = unstamped.

**Action:** the database is left unchanged. Preserve `audit.db` and `backups\` for diagnosis. Restoration from backup is an explicit manual workflow only — verify any candidate backup the same way (non-empty, `integrity_check` ok, foreign keys clean, revision stamp retained) before use, and work on a copy first.

### Backup validation and retention

- Verified backups live at `%LOCALAPPDATA%\AcademicComplianceAuditor\backups\audit.db.r<source>_to_<head>.<timestamp>-<rand>.bak`.
- Created via `sqlite3.Connection.backup()` — never by copying WAL/SHM/journal files.
- Retention: three newest verified backups; unrelated files in `backups\` are ignored; no existing backup is ever deleted on failure.
- A "backup preserved" state means migration verification failed after a verified backup was taken — the pre-upgrade database is intact.

---

## Source-mode issues

### Vite or backend startup problems

- **Backend port busy:** another process holds `127.0.0.1:8000`. Identify it: `Get-NetTCPConnection -LocalPort 8000 -State Listen | Select OwningProcess`, then `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` to see the command line. Stop only processes you own.
- **Vite port busy / fallback:** Vite silently moves to 5174 when 5173 is occupied. The proxy config expects 5173. Kill the stale Vite (`node.exe` running `vite.js`) and restart `npm run dev`.
- **`[vite] http proxy error ECONNREFUSED`:** the backend is not running. Start it and check `GET http://127.0.0.1:8000/health` returns `{"status":"healthy"}`.
- **Page loads but no data:** confirm both terminals are running; the frontend (5173) depends on the backend (8000) through the proxy.

### Vite started from the wrong directory

**Symptom:** `http://localhost:5173/` returns 404 while the port is listening.

**Cause:** Vite was launched from the repository root instead of `frontend/`, so it serves a directory with no `index.html`.

**Diagnosis:** the listener is a `node.exe` running `...\frontend\node_modules\vite\bin\vite.js` — check the process's working directory (its command line alone does not reveal it).

**Action:** stop that process and restart Vite with `npm run dev` from `frontend/`.

### Source versus packaged database mismatch

**Symptom:** audits appear in source mode but not in the packaged app (or vice versa).

**Cause:** two separate databases by design — `backend\audit.db` (source) and `%LOCALAPPDATA%\AcademicComplianceAuditor\audit.db` (packaged). Also check the browser: the packaged app and dev server run on different ports.

### Ports and process ownership

- Packaged ACA binds `127.0.0.1` on ports 8010–8015 only; the source backend uses 8000; Vite uses 5173 (fallback 5174).
- Identify listeners with `Get-NetTCPConnection -State Listen` plus `Get-CimInstance Win32_Process`. Stop only processes you started; never kill Ollama, LibreOffice, browsers, or unrelated services to free a port.
- The packaged launcher holds a Windows mutex (`Local\AcademicComplianceAuditor`) and writes `instance.json` (version, pid, port) while running.

### Launcher behavior (packaged)

- **Single instance:** a second launch validates the existing instance (pid, executable path, `GET /health`) and reuses it; the second launcher exits.
- **Stale `instance.json`:** metadata is validated against the mutex. Stale metadata with no mutex is removed and a fresh instance starts; invalid metadata with a live mutex shows a safe "already running" message.
- **Job Object:** the launcher's backend child runs under a Windows Job Object with `KILL_ON_JOB_CLOSE` — a force-terminated launcher kills its owned backend only. It never terminates other processes.
- **Browser opening:** occurs only after `GET /health` returns healthy; uses Python stdlib `webbrowser.open` (the OS default browser; Edge only if Edge is the Windows default). Failure is logged as `browser_open_failed` and never stops the backend. `ACA_DISABLE_BROWSER=1` and `ACA_BROWSER_RECORD_FILE=<path>` exist as test hooks for automated validation.
- **Launcher log:** `logs\launcher.log`, rotating 1 MB × 5. Contains lifecycle events, port, health timing, mutex/browser results, and safe error categories (`port_unavailable`, `health_timeout`, `missing_frontend_resources`, `browser_open_failed`) — never document text, filenames, profile payloads, API keys, or provider payloads.

### Preview storage

- Packaged preview PDFs: `%LOCALAPPDATA%\AcademicComplianceAuditor\rendered-previews\`. Source mode: `PREVIEW_STORAGE_DIR` if set, else the same LocalAppData location.
- Safe error categories on conversion failure: `libreoffice_missing`, `timeout`, `conversion_failed`, `persistence_failed`. Audits still complete with extracted-text evidence; a missing preview file serves HTTP 410.
- Conversion runs through `soffice.com`/`soffice.exe` at standard install paths or `SOFFICE_EXECUTABLE`.

### Technical logs and API diagnosis

- Backend console output (source mode) and the launcher log are the first two places to look; both are safe to read (no document content).
- `GET /health` — liveness (`{"status":"healthy"}`).
- `GET /api/readiness` — per-component states (`ready`, `unavailable`, `unknown`, `optional`, `misconfigured`); the payload is presentation-safe (no Ollama host/port, executable paths, or model identifiers beyond "Configured model: <name>").
- Unknown API paths return JSON 404 (never the SPA shell). Audits have server-generated identifiers; evidence previews are served from the local storage root with hash/size/page-count validation.
