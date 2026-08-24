# Troubleshooting — Academic Compliance Auditor

Each entry is symptom → cause → safe action. No command exposes credentials, document text, or absolute packaged database paths.

## 1. ACA does not open

**Cause:** Missing `_internal` or `frontend-dist`, port conflict, or database initialization failure.

**Action:** Keep the entire one-folder distribution together, close other ACA windows, and try again. Check `logs\launcher.log` for a safe category. For source mode, verify `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` starts.

## 2. Browser does not open automatically

**Cause:** Default browser association missing or blocked.

**Action:** ACA is running at `http://127.0.0.1:<port>/dashboard` (shown in the Launcher console and log). Open that URL manually. The Backend keeps running.

## 3. Port 8010 is occupied

**Cause:** Preferred port in use.

**Action:** The Launcher tries `8010–8015` on `127.0.0.1` (loopback only) and opens the first healthy port. If all six are busy, it reports that all ports are in use — close the application using the port and retry.

## 4. Second launch behavior

**Cause:** ACA is already running.

**Action:** A second launch verifies the existing instance (`pid`, executable, `GET /health`). If healthy, it opens the existing Dashboard and exits without starting another Backend. Closing the second window does not stop the first.

## 5. `System readiness could not be checked`

**Cause:** Readiness probe timed out or optional service unreachable.

**Action:** Use the Dashboard refresh action. This state does not block deterministic audits; optional features appear as unavailable.

## 6. Database requires attention

**Cause:** Packaged `audit.db` is at an older known revision.

**Action:** The Launcher automatically creates a verified backup (`backups\`), runs `alembic upgrade head`, verifies `integrity_check`, `foreign_key_check`, head match, and required tables and columns, then starts. For the packaged release, do **not** run `python -m alembic upgrade head` yourself. For source development, see `docs/INSTALLATION.md` — upgrade manually with that command while the Backend is stopped.

## 7. Database upgrade fails

**Cause:** Migration threw, backup verification failed, or post-upgrade verification failed.

**Action:** ACA refuses to start and preserves the verified pre-upgrade backup. Message: *The database upgrade did not complete. Your backup was preserved. ACA cannot start until the database is recovered.* Preserve `backups\` and `audit.db` for diagnosis. Do not delete sidecars or downgrade automatically.

## 8. Verified database backup location

**Location:** `%LOCALAPPDATA%\AcademicComplianceAuditor\backups\audit.db.r<source>_to_<head>.<timestamp>-<rand>.bak`

**Verification:** `PRAGMA integrity_check == ok`, `PRAGMA foreign_key_check` returns no rows, backup retains the source revision, and the file is non-empty. Only verified backups are retained.

## 9. Unsupported unstamped database

**Cause:** Tables exist but `alembic_version` is absent (legacy schema).

**Action:** ACA reports that this database is not supported and refuses to start without modification. Do not stamp or manually add columns. Use a later explicit import workflow if provided or contact support. The database is left unchanged.

## 10. Corrupt or future-version database

**Cause:** `PRAGMA integrity_check` fails, unknown revision, future head, multiple heads, or branch ambiguity.

**Action:** ACA reports the database is corrupt or from a newer version and refuses to start. Do not delete or replace the file automatically.

## 11. History cannot load

**Cause:** `GET /api/audits` returns 500, often due to a legacy audit with `NULL weighted_score` on an older frontend bundle, or a database that failed verification.

**Action:** Fresh packaged databases and upgraded databases with the current head return `200` with `weighted_score: null` displayed as **Unavailable**. If History fails after an upgrade, verify the Launcher created a fresh database via `alembic upgrade head` and that the frontend bundle is the freshly built `index-*.js` (packaging script rebuilds Frontend every run).

## 12. Audit is stuck at Processing

**Cause:** Previous Backend terminated before marking the audit complete.

**Action:** On next startup, stale-Audit recovery transitions `processing` rows created before the new process started to `interrupted` (`application_restart`) in one transaction. The audit then shows as interrupted.

## 13. Interrupted Audit

**Cause:** Previous process died mid-audit.

**Action:** The audit is terminal `interrupted` with unavailable preview metadata. It cannot be exported or resumed. Upload the document again.

## 14. LibreOffice unavailable

**Cause:** LibreOffice not installed or not found at `C:\Program Files\LibreOffice\...` or `C:\Program Files (x86)\LibreOffice\...` nor via `SOFFICE_EXECUTABLE`.

**Action:** Install LibreOffice or set `SOFFICE_EXECUTABLE`. Without it, audits still complete; rendered-page preview shows as unavailable.

## 15. Rendered Preview unavailable

**Cause:** Conversion timeout, invalid PDF, or storage failure.

**Action:** The audit still completes with `rendered_preview_status: UNAVAILABLE` and a safe error category (`libreoffice_missing`, `timeout`, `conversion_failed`, `persistence_failed`). No findings are lost.

## 16. Extracted Text fallback

**Cause:** Rendered preview failed or file was later removed.

**Action:** Findings still link to the exact paragraph in the extracted text viewer. A missing preview returns `410` with the message that extracted text remains available.

## 17. Ollama unavailable

**Cause:** Ollama service not running at `http://localhost:11434`.

**Action:** Start Ollama or install it. Deterministic checks are unaffected. Readiness shows `ollama: unavailable`.

## 18. Configured model missing

**Cause:** Model `qwen3.5:4b` not installed.

**Action:** Run `ollama pull qwen3.5:4b` and verify `ollama list` shows it. Readiness shows `local_model: unavailable` until installed.

## 19. Cloud AI unavailable

**Cause:** Cloud toggle is off (default) or `GEMINI_API_KEY` not set.

**Action:** Cloud AI is explicit opt-in per audit. Without a user-provided key, it is unavailable and deterministic checks continue. When available, only citation-review context is sent.

## 20. Audit upload failure

**Cause:** Wrong file type, file too large, or network error.

**Action:** ACA accepts only `.docx` up to 10 MB. Check the error message, retry with a supported file, or use the bundled sample thesis.

## 21. File exceeds size limit

**Cause:** File larger than 10 MB.

**Action:** Reduce the file size or split the document. ACA rejects the upload with a safe size error; no partial audit is created.

## 22. Custom Profile validation failure

**Cause:** Invalid profile JSON, missing required fields, or unknown profile id.

**Action:** The editor shows per-field friendly messages (field path and message), never raw Python paths or stack traces. Fix the highlighted fields and validate again.

## 23. Custom Profile conflict from another tab

**Cause:** Another tab saved a newer revision.

**Action:** The selector merges external changes; a stale write is refused with a revision guard. Reload the selector and retry with the latest revision.

## 24. Corrupted Custom Profile storage

**Cause:** localStorage contains corrupted or future-version JSON, or storage is unavailable.

**Action:** ACA discards the corrupted store, restores built-ins, and continues. Built-ins remain available even when the custom list is empty or storage is unavailable.

## 25. PDF Export unavailable

**Cause:** Audit is `processing` or `interrupted` (no score), or `failed` with no findings.

**Action:** The endpoint returns `409` with a friendly unavailable message and never fabricates a score. Complete a new audit to export.

## 26. Legacy Audit score shows `Unavailable`

**Cause:** Audits created at older revisions had no computed `weighted_score` (`NULL`).

**Action:** History and detail pages preserve `null` and display **Unavailable** (never `0` or `0/100`), do not re-score, and do not update the historical row. PDF export for such audits returns `409`.

## 27. Windows security or antivirus warning for an unsigned executable

**Cause:** The one-folder release is unsigned unless signing is configured.

**Action:** Windows SmartScreen or antivirus may warn on first launch. Verify you obtained the release through your distribution channel, keep the folder together, and allow the executable if you trust the source. No special antivirus allowance is documented.

## 28. Clean shutdown and stale instance recovery

**Cause:** Launcher was force-terminated or the system shut down.

**Action:** The Launcher holds a Windows Job Object (`KILL_ON_JOB_CLOSE`) so a forced Launcher termination kills the owned Backend. A stale `instance.json` is validated (`pid`, executable match, `GET /health`) before reuse; invalid metadata with a held mutex shows a safe already-running message, while stale metadata with no mutex is removed and a new instance starts.

## 29. Where logs and user data are stored

- **Packaged:** `%LOCALAPPDATA%\AcademicComplianceAuditor\audit.db`, `backups\`, `rendered-previews\`, `logs\launcher.log`, `instance.json` (while running), `tmp\`.
- **Source:** `backend\audit.db`, preview storage via `PREVIEW_STORAGE_DIR` or `%LOCALAPPDATA%\AcademicComplianceAuditor\rendered-previews`.
- **Launcher log** is rotating `1 MB × 5` and contains only lifecycle, port, health timing, mutex, browser result, and safe error categories — never document text, filenames, profile payloads, API keys, or provider payloads.
- **Backups** are verified before migration; three newest verified backups are retained, unrelated files are ignored, and failed migrations preserve all existing backups.

For source-development database issues, see `docs/INSTALLATION.md` — do not delete `backend\audit.db` to fix a migration mismatch; run `python -m alembic upgrade head` while the Backend is stopped.
