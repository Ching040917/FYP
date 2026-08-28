# Release Checklist — Academic Compliance Auditor

Complete every section before publishing a packaged Windows release. Each checkbox must be verified against the current source, tests, or a frozen build — never assumed.

## Repository

- [ ] `main` branch is clean (no modified tracked files, no untracked build artifacts).
- [ ] Local `main` equals `origin/main`.
- [ ] No secrets, `.env`, databases (`*.db`), logs, backups, or generated bundles are tracked.
- [ ] README and documentation internal links are valid.
- [ ] ACA license decision is recorded (see README License status).
- [ ] THIRD_PARTY_NOTICES.md completed before public distribution.
- [ ] Sample-document provenance confirmed (project-created synthetic DOCX; see git history for `frontend/public/samples/sample-thesis.docx`).

## Validation

- [ ] Complete Backend suite passes with zero failures.
- [ ] Complete Frontend suite passes.
- [ ] TypeScript check passes (`npx tsc --noEmit`).
- [ ] Production Frontend build succeeds (`npm run build`).
- [ ] PyInstaller one-folder build succeeds via `backend/.venv` Python 3.12 (`build-packaging-poc.ps1`), never global/PATH PyInstaller.
- [ ] Build log confirms Python 3.12.x and the repository-owned `PyInstaller==6.22.2` pin.
- [ ] Required Frontend route markers present in bundled JS (`/dashboard`, `/history`, `/profiles/custom`, `System readiness`).
- [ ] Source and bundled asset hashes match.
- [ ] Bundle contains no prohibited packages (`numpy`, `pandas`, `scipy`, `matplotlib`, `pyarrow`, `ollama`).
- [ ] Bundle size within the 250 MB ceiling (clean ~189 MB) and file count reported.
- [ ] `frontend/dist` is ignored and untracked (never committed; not restored/cleaned by the build script).
- [ ] `git diff --check` clean.

## Frozen package

- [ ] No runtime Python or Node.js required.
- [ ] Health endpoint returns `200 {"status":"healthy"}`.
- [ ] Readiness reports expected component states.
- [ ] Dashboard, History, Profiles, and Audit direct-route refresh all return 200 HTML shell.
- [ ] Unknown API path returns JSON 404 (never `index.html`).
- [ ] First launch completes: health → browser opens Dashboard.
- [ ] Second launch reuses healthy instance (no second Backend).
- [ ] Preferred port works; fallback ports `8011–8015` work when preferred port occupied.
- [ ] Browser opens only after health succeeds.
- [ ] Single-instance reuse verified via mutex + instance metadata + health.
- [ ] Job Object orphan cleanup verified — force-killing Launcher kills owned Backend.
- [ ] No bundle-directory writes after launch.

## Database

- [ ] Fresh database initialized automatically via Alembic upgrade head.
- [ ] Current-head reuse verified without re-migration.
- [ ] Known old-head backup created and verified before migration.
- [ ] Backup integrity, foreign-key, and source-revision checks pass.
- [ ] Migration failure refuses startup and preserves backup.
- [ ] Retention keeps three newest verified backups.
- [ ] Legacy NULL scores display **Unavailable** in History and detail.
- [ ] Unstamped / corrupt / future / multi-head databases refused without modification.
- [ ] Source `backend/audit.db` excluded from release artifacts.

## User workflow

- [ ] Upload `.docx` (up to 10 MB) succeeds.
- [ ] SUC Academic Report profile applies.
- [ ] APA 7 Student Paper profile applies.
- [ ] Custom Profiles create / edit / save / recover / delete correctly.
- [ ] Findings with Expected/Actual values and evidence render.
- [ ] Extracted Text fallback works when rendered preview unavailable.
- [ ] PDF Export produces a report for scored audits.
- [ ] PDF Export returns unavailable response for unscored legacy audits.
- [ ] History lists past audits with correct score/status/date.
- [ ] Interrupted Audit recovery transitions stale `processing` rows.
- [ ] Readiness card reflects installed optional components.
- [ ] First-run guidance appears on first visit and can be dismissed/reopened.
- [ ] Optional Local AI state reflects Ollama availability.
- [ ] Optional Cloud AI state reflects explicit opt-in only.

## Release artifact

- [ ] Version recorded.
- [ ] Archive name follows convention.
- [ ] SHA-256 checksum computed and published alongside archive.
- [ ] Clean Windows VM validation performed (no dev tools installed).
- [ ] Unsigned-executable SmartScreen warning documented.
- [ ] User-data location `%LOCALAPPDATA%\AcademicComplianceAuditor\` documented.
- [ ] Verified backup location `backups\` documented with retention rule (three newest).
- [ ] Rollback behavior documented (no automatic restore; preserve backups for diagnosis).
- [ ] Uninstall behavior documented (app folder removal does not delete user data).

## Installer

- [ ] Inno Setup 6 compiler available; version matches the pinned `6.7.3`.
- [ ] `installer/AcademicComplianceAuditor.iss` contract tests pass (`installer/installer-contract-tests.ps1`).
- [ ] `scripts/build-installer.ps1` builds `release-output/AcademicComplianceAuditor-Setup-1.0.0.exe` end-to-end.
- [ ] Setup EXE packages the complete clean one-folder runtime (`run-frozen.exe` + `_internal`, never the launcher alone).
- [ ] Per-user install to `%LOCALAPPDATA%\Programs\AcademicComplianceAuditor` with no administrator rights.
- [ ] Start Menu shortcut created; optional desktop shortcut works.
- [ ] Uninstall entry appears in Windows Installed Apps with correct name and version.
- [ ] Install/upgrade preserves `%LOCALAPPDATA%\AcademicComplianceAuditor` user data.
- [ ] Uninstall preserves user data by default (no optional data deletion offered; documented manual cleanup).
- [ ] Setup EXE SHA-256 recorded; unsigned status stated honestly.
- [ ] `release-output/` is gitignored; Setup EXE is not committed or published.
- [ ] Manual end-user checklist maintained (`docs/END_USER_INSTALLATION_TEST.md`).

## Not implemented (do not claim)

- Code signing.
- Automatic updater.
- Public download URL.
- Multi-user or LAN deployment.
- Mobile execution.
