# Troubleshooting — Academic Compliance Auditor

Each entry follows: the problem, what it means, and what to do. For deeper technical diagnosis (developer/evaluator level), see [Technical Troubleshooting](developer/TECHNICAL_TROUBLESHOOTING.md).

## ACA does not open

### What it means

The application did not start, or it closed immediately after launch.

### What to do

1. Wait about a minute on first launch — the first start creates ACA's local data and can take longer.
2. Start ACA again from the Start Menu. Starting ACA twice while it is already running is safe — the second start simply focuses the running instance.
3. Restart the computer if the problem persists, then try again.
4. If ACA still will not open, contact the project owner. No information you need to fix this is stored outside your machine.

## ACA found an unsafe database state

### What it means

ACA stopped startup because it found incomplete or unsafe database recovery files in your application data folder. This protects the data you already have: ACA did **not** create a replacement empty database, and it did not change or remove anything.

ACA also shows this message when a completed database upgrade could not be verified; the database and the automatic backup in `backups\` stay in place and startup stops until the problem is resolved.

### What to do

1. Technical details are recorded in launcher.log. If startup is stopped, ACA displays a short error dialog with safe recovery guidance.
2. Open your application data folder as described in project documentation.
3. Keep the whole folder as it is. Do not delete, rename or separate `audit.db`, `audit.db-wal`, `audit.db-shm` or `audit.db-journal`, and do not edit any of them by hand.
4. Make a copy of the complete folder somewhere safe before you try any recovery step.
5. Keep the `logs` folder for support or project-owner review.
6. Follow only the documented recovery procedure from the project owner. Do not use unlisted SQLite commands.

Diagnostic information for support is in the `logs` folder inside the same application data folder.
## ACA cannot safely access its data folder

### What it means

ACA could not access or create its local application data folder (under `%LOCALAPPDATA%\AcademicComplianceAuditor`). Startup stopped to protect your data rather than creating temporary replacement data in an ephemeral location, and existing data is not silently replaced.

### What to do

1. Ensure that your Windows user profile folder is accessible and that you have normal read and write permissions to `%LOCALAPPDATA%`.
2. Check that `%LOCALAPPDATA%\AcademicComplianceAuditor` is not locked by another program and has not been replaced by a regular file or link.
3. Restart your computer and start ACA again from the Start Menu.
4. If startup continues to fail, contact support or your project evaluator.

## Browser does not open

### What it means

ACA itself is running, but your web browser did not open automatically.

### What to do

1. Open your web browser yourself and go to the Dashboard address shown in the startup notice or recorded in `logs/launcher.log` (it looks like `http://127.0.0.1:<port>/dashboard`).
2. ACA uses the browser Windows has set as default. If no default browser is configured, set one in **Windows Settings > Apps > Default apps**, then start ACA again.

The application keeps running while you do this — nothing is lost.

## Windows displays a security warning

### What it means

The ACA installer is not digitally signed, so Windows SmartScreen may show *Unknown publisher* or a similar warning when you run it. This is expected for the current release and does not mean the file is unsafe.

### What to do

1. Obtain ACA only through an authorized release channel. Every official installer release is published with its SHA-256 checksum; verify it before running the installer (see [Installation](INSTALLATION.md)).
2. Do not run an installer whose checksum you cannot verify. A matching checksum shows your copy is the published build; it is not a security guarantee on its own.
3. On the SmartScreen dialog, choose **More info**, then **Run anyway**.
4. Antivirus software may also ask about the file the first time. If you trust the source, allow it.

Do not disable Windows SmartScreen or your antivirus to install ACA.

## System Readiness cannot be checked

### What it means

ACA could not finish its readiness check — for example, an optional component did not respond in time.

### What to do

1. Click **Refresh** (or **Check again** in the details view) and wait a few seconds.
2. If it still fails, restart ACA and check again.
3. This does not block audits: deterministic checks run regardless, and optional features simply show as unavailable.

## Audit does not start

### What it means

The audit could not begin — usually because of the uploaded file.

### What to do

1. Make sure the file is a `.docx` document (not `.doc`, `.pdf`, or `.odt`).
2. Check the file is 10 MB or smaller.
3. Try **Try with the sample thesis** — if the sample works, the issue is with the specific file.
4. If the document came from an older Word version, open it in Word and re-save it as `.docx`, then upload again.

## Audit remains in processing

### What it means

The audit is still running, or ACA was closed before it could finish.

### What to do

1. Wait for the audit to complete — large documents take longer.
2. If ACA was closed or the computer restarted mid-audit, the audit is marked as *interrupted* on next start. It cannot be resumed or exported — upload the document again.

## DOCX upload is rejected

### What it means

The file did not meet ACA's upload requirements.

### What to do

1. Confirm the file is a `.docx` up to 10 MB.
2. Check the error message — it states which requirement was not met.
3. Reduce the file size (remove large embedded images) or split the document, then upload again.
4. No partial audit is created from a rejected upload, so nothing needs cleaning up.

## LibreOffice is unavailable

### What it means

The optional LibreOffice integration is not installed. In ACA v1.0.0 fresh rendered-page previews and physical page location mapping are disabled regardless, so extracted-text preview is the active preview mode. Extracted-text evidence works, and audits are unaffected.

### What to do

1. In the Dashboard's **System readiness** card, choose **Download LibreOffice** — it opens the official LibreOffice website.
2. Install LibreOffice yourself (ACA never installs third-party software for you).
3. Click **Check again** in the readiness card — no restart needed.

## Page preview is unavailable

### What it means

In ACA v1.0.0, fresh rendered-page previews and physical page location mapping are disabled so that uploaded DOCX bytes are never written to disk. Only audits that already contain rendered data from an earlier version can display it.

### What to do

1. Findings link to the exact paragraph in the extracted-text view — use that evidence.
2. Nothing needs installing: installing LibreOffice does not enable fresh rendered previews in v1.0.0.

## Ollama is unavailable

### What it means

The optional local AI service is not installed or not running, so local AI citation guidance is unavailable. Deterministic checks are unaffected.

### What to do

1. In the **System readiness** card, choose **Download Ollama** — it opens the official Ollama website.
2. Install Ollama yourself and start it.
3. Click **Check again**. If you continue without Ollama, everything else keeps working.

Ollama must be installed and running before ACA can download the optional Citation Guidance Model — the download is performed by your own Ollama service.

## Local AI model is missing

### What it means

Ollama is installed and running, but the Citation Guidance Model ACA uses for optional Local AI Citation Guidance has not been downloaded yet. This affects APA 7 in-text citation formatting suggestions only — deterministic checks are unaffected.

### What to do

1. In the **System readiness** card, find the model entry and choose **Download optional model**.
2. Confirm with **Start download**. ACA asks your own Ollama service to fetch the model and shows progress in the card. The download needs an internet connection, may take time, and needs noticeable disk space.
3. Prefer to do it yourself? Choose **Copy installation command** and paste the copied command into a terminal (Command Prompt or PowerShell). Both routes work.
4. When the download finishes, ACA confirms the model through Ollama and the entry becomes **Ready**. You can also click **Check again**.
5. If the download fails, the card explains what to check and offers **Try again**.
6. On a low-memory computer you can also simply continue without local AI — deterministic checks are unaffected.

### About stopping a download

There is no Cancel button. **ACA cannot reliably stop an Ollama model download once it has started** — Ollama has no cancel endpoint, and it keeps downloading even if ACA closes the connection. You may close the progress view, but Ollama may continue downloading in the background. ACA never stops the Ollama service to interrupt a download.

## Removing the Local AI model

### What it means

The Citation Guidance Model is stored and managed by Ollama on your computer, not by ACA. ACA v1.0.0 provides no in-app model-delete control.

### What to do

1. Remove the model yourself through Ollama — for example `ollama rm <model>` in your own terminal, or through Ollama's own interface. ACA does not run that command for you.
2. Check first whether other applications or other Windows users on this computer rely on the same model: Ollama model storage may be shared, and deleting a model can affect them.
3. ACA never stops, uninstalls or otherwise controls the Ollama service, and it never deletes models automatically or in the background.

## Where else your data lives

The application data folder is not the only place ACA-related data can exist. Browser storage (saved custom profiles, the current profile selection, an unsaved editor draft, and the first-run guidance dismissal) stays in your browser until you clear that site's data. Any PDF report or corrected DOCX you exported is a separate file wherever you chose to save it. If you installed LibreOffice or Ollama, those programs keep and manage their own data — Ollama model files can be shared with other applications and other Windows users. Deleting the ACA data folder does not remove any of these, and ACA does not delete them for you.

## PDF export is unavailable

### What it means

A PDF report could not be produced for this audit.

### What to do

1. This happens for audits with no score — for example, interrupted audits or very old audits. Run a new audit to get an exportable report.
2. If a completed audit still will not export, restart ACA and try again.

## Audit History does not appear

### What it means

The History page did not load, or a past audit is missing.

### What to do

1. Refresh the page in your browser (F5).
2. Restart ACA and open History again.
3. History is stored locally on your machine — it survives closing ACA and even uninstalling (uninstall preserves your data by default). If History is truly empty after reinstalling on the same Windows account, contact the project owner.

## Find or remove local data

### What it means

All ACA data lives in one local folder — audit history, backups, previews, and logs.

### What to do

1. Press **Win+R**, type `%LOCALAPPDATA%\AcademicComplianceAuditor`, press Enter.
2. Inside: `audit.db` is your audit history; `backups\` holds automatic database backups; `rendered-previews\` holds generated page previews; `logs\` holds diagnostic logs.
3. To remove everything after uninstalling, delete that entire folder. **Back it up first** if you might need your history later — removal is permanent.
4. Deleting individual audits from within ACA is the normal way to remove a single audit's data. See [Privacy](PRIVACY.md) for what each item contains.
