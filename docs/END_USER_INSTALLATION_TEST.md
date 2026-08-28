# End-User Installation Test Checklist — Academic Compliance Auditor

Owner-facing manual test checklist for the Windows Setup EXE
(`AcademicComplianceAuditor-Setup-<version>.exe`). Use an isolated Windows
context (Windows Sandbox, clean VM, or a dedicated non-admin test user). Do
**not** test against a real production ACA database.

For each scenario fill in every column. Do not pre-fill Actual Result or
PASS/FAIL — these are recorded during the manual test, never assumed.

| Field | Description |
|---|---|
| Test ID | Unique identifier, e.g. `EU-01` |
| Environment | Windows version, user type (admin / standard), architecture |
| Precondition | State before the test (clean machine, prior install, etc.) |
| Steps | Numbered actions the tester performs |
| Expected result | The behavior that must be observed |
| Actual result | What the tester actually observed (left blank to fill in) |
| PASS/FAIL | Left blank to fill in |
| Evidence filename | Screenshot / log / session name captured |
| Issue severity | None / Minor / Major / Critical |
| Notes | Anything relevant |

---

## Scenario 1 — Clean Windows installation

- Test ID: `EU-01`
- Environment: Windows 10 or 11, fresh/clean user account, x64
- Precondition: No ACA installed. No Python, Node.js, npm, or source code present. No LibreOffice, no Ollama.
- Steps:
  1. Double-click `AcademicComplianceAuditor-Setup-<version>.exe`.
  2. Read the wizard pages.
  3. Accept defaults (per-user install).
  4. Leave the optional desktop shortcut unchecked (test the default).
  5. Complete installation.
- Expected result: Setup opens, product name "Academic Compliance Auditor" and version shown, no administrator prompt, installation completes, Finish page offers to launch ACA.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 2 — Non-admin installation

- Test ID: `EU-02`
- Environment: Windows 10/11, standard (non-administrator) user
- Precondition: Same as EU-01 but on a non-admin account.
- Steps: Same as EU-01; watch for any UAC / elevation prompt.
- Expected result: Installs to `%LOCALAPPDATA%\Programs\AcademicComplianceAuditor` without requiring administrator rights or a UAC prompt.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 3 — No Python or Node.js

- Test ID: `EU-03`
- Environment: Machine with no Python and no Node.js on PATH
- Precondition: ACA installed (EU-01).
- Steps:
  1. From Start Menu launch "Academic Compliance Auditor".
  2. Observe the launcher.
- Expected result: ACA starts without any "Python not found" / "Node not found" prompt or terminal requirement.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 4 — First launch

- Test ID: `EU-04`
- Environment: Any supported Windows
- Precondition: ACA installed.
- Steps:
  1. Launch ACA from the Start Menu.
  2. Wait for the browser to open.
- Expected result: Browser opens automatically to `http://127.0.0.1:<port>/dashboard` after the backend health check; port is between 8010 and 8015; ACA binds only to 127.0.0.1; runtime directories are created under `%LOCALAPPDATA%\AcademicComplianceAuditor`; the database reaches Alembic head `90fc17718e11`; no terminal command required.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 5 — Deterministic audit without LibreOffice or Ollama

- Test ID: `EU-05`
- Environment: No LibreOffice, no Ollama installed
- Precondition: ACA running (EU-04).
- Steps:
  1. Use "Try with the sample thesis" or upload a `.docx`.
  2. Wait for the audit to complete.
  3. Open History.
- Expected result: Deterministic audit completes, findings appear with score, the audit is saved to history; the Dashboard readiness explains that LibreOffice/Ollama are optional and unavailable; local AI guidance may be unavailable.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 6 — PDF report export

- Test ID: `EU-06`
- Environment: Any; LibreOffice not required
- Precondition: A completed audit exists (EU-05).
- Steps:
  1. Open the audit detail.
  2. Export the PDF report.
- Expected result: PDF report downloads/exports successfully without LibreOffice.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 7 — Finding page unavailable fallback

- Test ID: `EU-07`
- Environment: No LibreOffice
- Precondition: A completed audit exists (EU-05).
- Steps:
  1. Open a finding in the audit detail.
  2. Inspect the rendered-page evidence area.
- Expected result: When no rendered preview exists, findings without rendered mapping show "Original document page: Unavailable" and extracted-text evidence remains available.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 8 — Restart and history persistence

- Test ID: `EU-08`
- Environment: Any supported Windows
- Precondition: At least one audit exists (EU-05).
- Steps:
  1. Close ACA (close the launcher window).
  2. Relaunch ACA from the Start Menu.
  3. Open History.
- Expected result: The child backend terminates and the port is released on close; after restart the audit history is still present and readable.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 9 — Second-launch reuse

- Test ID: `EU-09`
- Environment: Any supported Windows
- Precondition: ACA is running (EU-04).
- Steps:
  1. Launch ACA again from the Start Menu while it is already running.
- Expected result: The second launch reuses the existing healthy instance (no duplicate backend), opens the existing Dashboard, and the second launcher exits. No duplicate browser tabs are forced by a second backend.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 10 — Uninstall with data preservation

- Test ID: `EU-10`
- Environment: Any supported Windows
- Precondition: ACA installed with audit history (EU-05). A note of the `%LOCALAPPDATA%\AcademicComplianceAuditor` contents is taken first.
- Steps:
  1. Open Settings > Apps > Installed apps.
  2. Find "Academic Compliance Auditor" and uninstall.
  3. Confirm the uninstaller completes.
- Expected result: Program files and Start Menu/desktop shortcuts are removed, the Installed-apps entry is removed, no ACA process remains, and the user-data directory `%LOCALAPPDATA%\AcademicComplianceAuditor` (audit.db, backups, previews, logs) is preserved by default. No unrelated files in `%LOCALAPPDATA%` are touched.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

> Note: ACA intentionally has no optional "delete my data" checkbox at
> uninstall because Inno Setup provides no reliable API to read uninstall-task
> state from its Pascal Script. User data is therefore always preserved by the
> uninstaller. Manual cleanup, if desired after uninstall, is to delete the
> `%LOCALAPPDATA%\AcademicComplianceAuditor` folder yourself.

## Scenario 11 — Reinstall with history preservation

- Test ID: `EU-11`
- Environment: Any supported Windows
- Precondition: EU-10 completed (uninstall preserved user data).
- Steps:
  1. Run the Setup EXE again.
  2. Install and launch ACA.
  3. Open History.
- Expected result: ACA reinstalls cleanly, no duplicate shortcuts or Installed-apps entries, and the preserved audit history is still readable.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 12 — Optional LibreOffice follow-up

- Test ID: `EU-12`
- Environment: LibreOffice installed after ACA
- Precondition: ACA installed; LibreOffice absent at install time.
- Steps:
  1. Install LibreOffice.
  2. Launch ACA and run a new audit.
- Expected result: Readiness reports rendered-page conversion support; findings gain rendered-page evidence where available.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

## Scenario 13 — Optional Ollama / model follow-up

- Test ID: `EU-13`
- Environment: Ollama installed and `qwen3.5:4b` pulled after ACA install
- Precondition: ACA installed; Ollama absent at install time.
- Steps:
  1. Install Ollama and pull `qwen3.5:4b`.
  2. Launch ACA; check readiness; run an audit.
- Expected result: Readiness reports local AI available; local AI citation guidance appears for confirmed citation findings.
- Actual result:
- PASS/FAIL:
- Evidence filename:
- Issue severity:
- Notes:

---

## Environment note

- Test the first-launch scenario (`EU-04`) on a clean machine or VM with no
  dev tools to satisfy "no Python / no Node" (`EU-03`). Do not claim clean
  machine success unless actually executed in an isolated clean environment.
- All data created during these tests is synthetic; never run them against a
  real production ACA database.
