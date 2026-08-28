# Installing Academic Compliance Auditor

This guide covers two distinct audiences. Choose the one that matches how you obtained ACA.

- **Option 1** — ordinary Windows users running the packaged release (no Python or Node.js required).
- **Option 2** — developers and evaluators running ACA from source (requires Python and Node.js).

---

## Option 1: Packaged Windows release

### What you receive

The verified packaged release is distributed as a single **Windows installer**:
`AcademicComplianceAuditor-Setup-<version>.exe` (a Setup EXE produced by Inno
Setup 6). The installer packages the complete PyInstaller one-folder runtime
(`run-frozen.exe` plus the full `_internal` directory) and installs it per-user
with no administrator rights.

For reference, the underlying one-folder distribution is produced by PyInstaller:

```
backend/dist/run-frozen/
  run-frozen.exe
  _internal/
    frontend-dist/
    alembic/
    ...
```

Keep the entire installed application folder together. `run-frozen.exe` must
stay alongside `_internal`; moving or renaming either will break the
application. Do not treat `frontend/dist` tracked in the repository as the
release bundle — the bundle is only `backend/dist/run-frozen`.

The installer (and the packaged application) are **unsigned** unless signing is
configured in the build. Windows may show a SmartScreen or security warning on
first launch. This is expected for unsigned builds.

### How to install and run

1. Obtain the verified Setup EXE through your distribution channel.
2. Double-click `AcademicComplianceAuditor-Setup-<version>.exe`.
3. Accept the defaults (per-user installation, no administrator rights).
4. Choose whether to create an optional desktop shortcut (the Start Menu
   shortcut "Academic Compliance Auditor" is always created).
5. The Finish page can launch ACA immediately. Alternatively launch ACA from
   the Start Menu shortcut.
6. ACA binds only to `127.0.0.1` (loopback). It tries `8010` first, then
   `8011–8015` if the preferred port is occupied.
7. The Launcher waits for `GET http://127.0.0.1:<port>/health` to return
   `{"status":"healthy"}`.
8. After health succeeds, your default browser opens to
   `http://127.0.0.1:<port>/dashboard`.
9. A second launch while ACA is running does not start another Backend — it
   reuses the healthy instance after verifying process, executable, and health,
   then opens the existing Dashboard.
10. Closing the Launcher window stops only the owned Backend (Windows Job
    Object with `KILL_ON_JOB_CLOSE`). It never stops Ollama, LibreOffice,
    browsers, or unrelated Python or Node processes.

Python and Node.js are **not** runtime prerequisites for the packaged release.
ACA runs from its bundled dependencies.

### Install, upgrade, and uninstall behavior

- **Install location:** `%LOCALAPPDATA%\Programs\AcademicComplianceAuditor`
  (per-user; no administrator rights required). Mutable user data is never
  installed into the program folder.
- **Upgrade:** re-running the Setup EXE over an existing installation updates
  program files in place and preserves all user data under
  `%LOCALAPPDATA%\AcademicComplianceAuditor` (audit history, database, backups,
  previews, logs). The database lifecycle (verified backup before migration,
  Alembic upgrade to the bundled head) remains handled by the Launcher.
- **Uninstall:** uninstalling removes program files and shortcuts and the
  Installed-apps entry. User data under `%LOCALAPPDATA%\AcademicComplianceAuditor`
  is **always preserved** by the uninstaller — no optional data-deletion
  checkbox is offered because Inno Setup provides no reliable way to read such
  an option from its Pascal Script. To fully remove local data after uninstall,
  delete the `%LOCALAPPDATA%\AcademicComplianceAuditor` folder yourself.
- **Reproducibility:** the installer is built by `scripts/build-installer.ps1`
  from `installer/AcademicComplianceAuditor.iss`. See "Reproducible packaging
  workflow" below for the full controlled build.

### Local data

All mutable data lives outside the bundle, under:

```
%LOCALAPPDATA%\AcademicComplianceAuditor\
  audit.db                 # production packaged database
  backups\                 # verified SQLite backups (see below)
  rendered-previews\      # generated PDF previews
  logs\launcher.log        # rotating launcher log (1 MB × 5)
  instance.json            # present only while ACA is running (version, pid, port)
  tmp\                     # temporary runtime files
```

Technical notes:

- Source DOCX files are processed in memory and are **never retained** as files by ACA.
- Uninstalling or deleting the application folder does **not** automatically delete local Audit history under `%LOCALAPPDATA%\AcademicComplianceAuditor`. Back up that folder before manual removal if you need to keep your history.
- No log file contains document text, uploaded filenames, profile payloads, API keys, or provider payloads.

### Database lifecycle

**Fresh installation:** When `audit.db` does not exist or is zero bytes, the Launcher creates it automatically with `alembic upgrade head` to the bundled head `f6a8d19e2b3f2` and verifies integrity, foreign keys, and required tables and columns before starting the Backend. Readiness then reports `database: Ready`.

**Existing database:** If `audit.db` is at a known older Alembic revision that is an unambiguous ancestor of the bundled head, the Launcher:

1. Verifies integrity and single-revision state.
2. Checks sufficient writable space.
3. Creates a verified backup with `sqlite3.Connection.backup()` — never by manually copying WAL, SHM, or journal files — and verifies the backup is non-empty, `PRAGMA integrity_check` is `ok`, `PRAGMA foreign_key_check` returns no rows, and the backup retains the source revision. The backup is stored as `backups/audit.db.r<source>_to_<head>.<timestamp>-<rand>.bak`.
4. Runs `alembic upgrade head`.
5. Verifies `integrity_check == ok`, `foreign_key_check` empty, exactly one `alembic_version` equal to the bundled head, and required tables (`audit_records`, `violations`, `citation_issues`, `alembic_version`) and columns (`interrupted_at`, `interruption_reason`, `profile_snapshot`) exist.
6. Starts the Backend only after all checks pass.
7. Retains the three newest verified backups; unrelated files in `backups\` are ignored. On any backup, migration, or verification failure, no existing backup is deleted and ACA refuses to start.

**Unsupported states** — unstamped tables without `alembic_version`, corrupt databases, unknown or future revisions, multiple heads, or branch ambiguity — are refused without modification:

- `This database is not supported. Please contact support.` (unstamped)
- `This database cannot be upgraded automatically.` (unknown/future)
- `Database file is corrupt. Please contact support.` (corrupt)
- `The database upgrade did not complete. Your backup was preserved. ACA cannot start until the database is recovered.` (backup/migration/verification failure)

ACA never silently deletes or replaces the database, never deletes SQLite sidecar files manually, never stamps a legacy schema, never downgrades, and never restores a backup automatically. Preserve the `backups\` folder for diagnosis and use a later explicit restore workflow if provided.

Do **not** run `python -m alembic upgrade head` yourself for the packaged release — the Launcher handles all packaged database initialization and verified upgrades.

**Legacy audits with unavailable scores:** Audits created at older revisions that had no computed `weighted_score` remain in history with `weighted_score: null`. They display as **Unavailable** in History (never as `0` or `0/100`), detail pages preserve null values without fabricated findings, modern audits are unaffected, and PDF export for such audits returns `409` with a friendly unavailable message.

### Optional components

**LibreOffice** — enables rendered-page preview. ACA searches `C:\Program Files\LibreOffice\program\soffice.com` (and `.exe`, plus `Program Files (x86)` equivalents) and respects `SOFFICE_EXECUTABLE` if set. Without LibreOffice, audits still complete and extracted-text evidence remains available.

**Ollama** — enables local AI-assisted citation review. Install from `https://ollama.com`, then:

```powershell
ollama pull qwen3.5:4b
ollama list   # must show qwen3.5:4b
```

The configured model is `qwen3.5:4b` (`OLLAMA_HOST=http://localhost:11434`). Without Ollama, deterministic checks are unaffected.

**Cloud AI (Gemini)** — explicit opt-in per audit. It requires a user-provided `GEMINI_API_KEY`; no credential is bundled. Leave the toggle off unless you intend to send citation snippets to the configured provider. No example key value is included in documentation.

### Packaging limitations

- The packaged release and the Setup EXE are unsigned unless signing is actually configured — expect a Windows SmartScreen prompt.
- Keep the entire one-folder distribution together; do not run `run-frozen.exe` in isolation.
- Mobile local execution is unsupported.
- No automatic updater is included yet.
- Antivirus compatibility is not guaranteed; no specific allowance is documented.

---

## Option 2: Developer source setup

*This section is for source development and evaluation, not ordinary end-user installation.*

### Prerequisites

| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Python | 3.11 or 3.12 | `python --version` | 3.12 is the verified Windows release-build version. 3.13 is currently unsupported: the pinned dependency set lacks required Windows wheels for a clean install. |
| Node.js | 18 LTS+ (24.x verified) | `node --version` |
| npm | ships with Node | `npm --version` |

Optional: LibreOffice and Ollama as described above. Without them, deterministic checks still run.

### Backend setup

From the repository root in Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
# If blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
copy .env.example .env
python -m alembic upgrade head
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Keep this terminal open. On startup ACA applies stale-Audit recovery and serves `http://127.0.0.1:8000`.

Environment file defaults:

- `DEPLOY_MODE=LOCAL`
- `DATABASE_URL=sqlite:///./audit.db` (source development database at `backend\audit.db`, ignored by Git)
- `OLLAMA_HOST=http://localhost:11434`
- `OLLAMA_MODEL=qwen3.5:4b`
- `GEMINI_API_KEY=` — required only if you explicitly enable cloud AI review per audit. Never commit this value.

### Frontend setup

Open a second terminal from the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Keep this terminal open. The app is served at `http://localhost:5173` (Vite proxies `/api` to `127.0.0.1:8000`). For a production build:

```powershell
npm run build
npm run preview
```

### Verify source installation

With both terminals running:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
# Expected: status = healthy

Invoke-RestMethod http://127.0.0.1:8000/api/readiness
# Expected: overall = ready (or degraded when optional components are absent)
```

Then open `http://localhost:5173` — the Dashboard readiness card should show **Ready to audit documents**. Use **Try with the sample thesis** or upload your own `.docx` (up to 10 MB) and inspect findings, evidence, and History.

### Reproducible packaging workflow

**Packaging requires Python 3.12.** The build runs **only** through the repository-controlled `backend/.venv` interpreter — never a global Python, never a PATH-resolved `pyinstaller`, and never Python 3.13. `frontend/dist` build artifacts are never committed.

Prepare the controlled packaging environment once (Python 3.12 must be the interpreter that created `.venv`):

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements-dev.txt   # owns the exact PyInstaller pin
```

Then produce a verified one-folder release from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/build-packaging-poc.ps1
```

The script:

1. Verifies the controlled interpreter exists and is Python 3.12.x, and that the repository-owned `PyInstaller==6.22.2` pin is importable — failing **before** any build output is touched if any prerequisite is missing or mismatched.
2. Always rebuilds the Frontend (`npm ci` + `npm run build`).
3. Verifies required route markers (`/dashboard`, `/history`, `/profiles/custom`, `System readiness`), staleness, and source-to-bundled frontend hash parity.
4. Runs PyInstaller (`ACA.spec`) via `backend/.venv/Scripts/python.exe -m PyInstaller` — no global PATH fallback.
5. Rejects the bundle if it contains any prohibited package (`numpy`, `pandas`, `scipy`, `matplotlib`, `pyarrow`, `ollama`), checked against `_internal` directories and PyInstaller TOC files.
6. Rejects the bundle if it exceeds the size ceiling (250 MB) — a clean Python 3.12 build is ~189 MB; larger output signals dependency contamination.
7. Runs an isolated frozen smoke suite (127.0.0.1 binding, port selection, SPA direct routes, health, database init, process cleanup) against a temporary data root.

`backend/dist` and `backend/build` remain ignored. `frontend/dist` is left in place after a build so you can inspect the exact frontend the bundle shipped; it is ignored and never committed.

### Reproducible installer workflow

Requires **Inno Setup 6** (version `6.7.3` is the verified pin) with its
command-line compiler `ISCC.exe`. It is not auto-installed — obtain it from
jrsoftware.org or `winget install --id JRSoftware.InnoSetup`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

The script:

1. Locates `ISCC.exe` safely (PATH, `%LOCALAPPDATA%\Programs\Inno Setup*`,
   `Program Files`) and verifies the installed version matches the pin.
2. Verifies the controlled `backend/.venv` Python 3.12 interpreter and the
   repository-owned PyInstaller pin, then validates (or builds) the clean
   one-folder runtime with the repository-owned contamination and size checks.
3. Compiles `installer/AcademicComplianceAuditor.iss` with
   `/DAppVersion=1.0.0`.
4. Validates the output (non-zero size, PE `MZ` header, required runtime files)
   and computes SHA-256.
5. Writes `release-output/AcademicComplianceAuditor-Setup-<version>.exe`
   (the `release-output/` directory is gitignored; the Setup EXE is never
   committed and never published from this repository).

Focused source-contract checks live in `installer/installer-contract-tests.ps1`.

### Stopping source mode

Press `Ctrl+C` in each terminal. Source audits live in `backend\audit.db` (ignored); packaged audits live separately under `%LOCALAPPDATA%\AcademicComplianceAuditor\audit.db`.
