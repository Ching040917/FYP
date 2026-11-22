# Release Checklist — Academic Compliance Auditor

This checklist records the full Windows release-acceptance scope. Verify each claim against the current source, tests or frozen build; do not mark unverified items as passed.

**Academic-evaluation exception (2026-11-22):** The Owner authorizes the verified unsigned Windows installer as a GitHub prerelease for non-commercial academic demonstration and evaluation. This is not production-ready or full clean-machine acceptance; uncompleted checklist items remain open. Publish the exact asset and its SHA-256, and disclose the unsigned/SmartScreen warning and validation limits. See [Release Governance and Residual Disclosures](../developer/BUILD_AND_RELEASE.md#release-governance-and-residual-disclosures) for scope and signing guidance.

## Repository

- [ ] `main` branch is clean (no modified tracked files, no untracked build artifacts).
- [ ] Local `main` equals `origin/main`.
- [ ] No secrets, `.env`, databases (`*.db`), logs, backups, or generated bundles are tracked.
- [ ] README and documentation internal links are valid.
- [ ] Root `LICENSE` exists and records the ACA proprietary distribution terms.
- [ ] README and THIRD_PARTY_NOTICES.md are consistent with `LICENSE`.
- [ ] THIRD_PARTY_NOTICES.md records third-party rights only; complete per-component notice coverage and in-package delivery remain separately required (B-LIC-03, B-LIC-04).
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
- [ ] No cloud AI control, API-key field, or provider label exists anywhere in the UI.

## Release artifact

- [ ] Version recorded (expected: 1.0.0).
- [ ] Installer filename matches the verified artifact. The standard build output is `AcademicComplianceAuditor-Setup-1.0.0.exe`; the approved academic-evaluation asset is `ACA-FYP-UX-Updated-Private-Evaluation-Setup.exe`.
- [ ] SHA-256 checksum computed and published with the specific verified installer; never reuse the checksum for a rebuild.
- [ ] Clean Windows VM validation performed (no dev tools installed).
- [ ] Unsigned-installer disclosure present in README, INSTALLATION and `LICENSE`, and stated factually.
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
- [ ] `release-output/` is gitignored; no Setup EXE is committed. Only the exact verified installer is uploaded for the approved academic-evaluation prerelease.
- [ ] Manual end-user checklist maintained (`docs/evaluation/END_USER_INSTALLATION_TEST.md`).

## Not implemented (do not claim)

- Code signing in the current build. The dated exception above applies only to the academic-evaluation prerelease.
- Automatic updater.
- A published download URL or GitHub Release did not exist at the original checklist baseline. See the [README](../../README.md#download-academic-evaluation-build) for current availability.
- Multi-user or LAN deployment.
- Mobile execution.
