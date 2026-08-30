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

## Browser does not open

### What it means

ACA itself is running, but your web browser did not open automatically.

### What to do

1. Open your web browser yourself and go to the Dashboard address shown in the ACA launcher window (it looks like `http://127.0.0.1:<port>/dashboard`).
2. ACA uses the browser Windows has set as default. If no default browser is configured, set one in **Windows Settings > Apps > Default apps**, then start ACA again.

The application keeps running while you do this — nothing is lost.

## Windows displays a security warning

### What it means

The ACA installer is not digitally signed, so Windows SmartScreen may show *Unknown publisher* or a similar warning when you run it. This is expected for the current release and does not mean the file is unsafe.

### What to do

1. Confirm you obtained the installer from the project owner or your approved evaluation channel (see [Installation](INSTALLATION.md)).
2. If you verified a supplied SHA-256 checksum, the file is intact.
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

The optional LibreOffice integration is not installed, so rendered-page previews and original-document page locations are not available. Extracted-text evidence still works, and audits are unaffected.

### What to do

1. In the Dashboard's **System readiness** card, choose **Download LibreOffice** — it opens the official LibreOffice website.
2. Install LibreOffice yourself (ACA never installs third-party software for you).
3. Click **Check again** in the readiness card — no restart needed.

## Page preview is unavailable

### What it means

A page preview could not be generated for this audit — for example, LibreOffice was missing at audit time, or the conversion failed.

### What to do

1. Findings still link to the exact paragraph in the extracted text view — use that evidence instead.
2. Install LibreOffice (see above), then run a new audit — new audits gain page previews automatically.

## Ollama is unavailable

### What it means

The optional local AI service is not installed or not running, so local AI citation guidance is unavailable. Deterministic checks are unaffected.

### What to do

1. In the **System readiness** card, choose **Download Ollama** — it opens the official Ollama website.
2. Install Ollama yourself and start it.
3. Click **Check again**. If you continue without Ollama, everything else keeps working.

## Local AI model is missing

### What it means

Ollama is installed and running, but the AI model ACA uses has not been downloaded yet.

### What to do

1. In the **System readiness** card, find the model entry and choose **Copy installation command**.
2. Paste the copied command into a terminal (Command Prompt or PowerShell) and run it yourself. The model download needs internet access, may take time, and needs noticeable disk space.
3. When the download finishes, click **Check again**.
4. On a low-memory computer you can also simply continue without local AI — deterministic checks are unaffected.

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
