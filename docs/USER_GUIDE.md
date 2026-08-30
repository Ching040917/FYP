# User Guide — Academic Compliance Auditor

This guide is for ordinary Windows desktop users of the packaged ACA application. For installation help, see [Installation](INSTALLATION.md).

## 1. Start ACA

Open **ACA** from the **Windows Start Menu** (a desktop shortcut also works if you created one during installation). After a short start-up, your web browser opens automatically at the ACA Dashboard. ACA uses the browser Windows has set as default — if Edge is your default browser, Edge opens.

Closing the ACA application window stops ACA. Closing the browser tab alone does not.

## 2. Check System Readiness

The Dashboard's **System readiness** card shows whether ACA and its optional components are ready. Expand **View details** for per-component status, and use **Refresh** or **Check again** after installing or removing an optional component.

## 3. Upload a DOCX Document

In the left intake panel, drag a `.docx` file into the upload area or click to browse. The maximum file size is 10 MB.

No document? Use **Try with the sample thesis** to see ACA work on a bundled example.

Documents are processed locally on your machine. Your original DOCX file is read once for the audit and is not kept as a source file — to audit it again later, upload it again.

## 4. Select a Formatting Profile

Above the upload area, choose one of:

- **SUC Academic Report** (recommended default)
- **APA 7 Student Paper**
- One of your **custom profiles**, if you have created any

You can create custom profiles with your own font, spacing, margins, and citation settings. Each profile is validated in-app before it can be saved, and your selection is remembered for next time.

## 5. Run an Audit

Select a profile, add your document, then start the audit. ACA reports progress while it checks your document.

An audit that could not finish (for example, because the application was closed mid-run) is shown as *interrupted* and cannot be exported — simply upload the document again.

## 6. Understand the Results

Results open in the Audit Workspace:

- **Score** — a weighted compliance score out of 100 for the checks your profile enables. Major findings deduct more than minor ones. Very old audits may show *Unavailable* instead of a score.
- **Findings list** — grouped by category and severity (major findings first).
- **Expected and Actual** — what your profile requires versus what was found in the document.
- **Not checked** — a profile requirement can be switched off (for example, margins); this means the check does not apply, not that it passed.

ACA reports the checks it supports. **It does not guarantee institutional acceptance or complete academic compliance** — treat findings as guidance for your own review.

## 7. View Finding Evidence

Selecting a finding shows its evidence:

- **Location** — the finding's location in plain language, such as a heading, paragraph, figure, or table (never internal numbering).
- **Rendered-page preview** — a page preview of your document with the finding highlighted. This needs the optional LibreOffice integration.
- **Extracted text** — when page preview is unavailable, the finding links to the exact paragraph in the extracted text view instead.

The preview is a locally generated copy of your document; the original Word file is not stored or modified.

## 8. Export a PDF Report

Use **Export PDF** in the Audit Workspace to save a PDF report containing your findings, locations, and required actions. Export is offline and deterministic — it reads the stored audit only. Audits without a score (interrupted or very old) cannot be exported.

## 9. Use Audit History

**History** lists your past audits with score, status, and date. Open any audit to review its findings again. History is stored locally on your machine.

## 10. Delete an Audit

Delete an audit from History or the Audit Workspace. **Deletion is permanent** — a deleted audit cannot be recovered from within ACA. Note that older database backups on disk may still contain a copy of the deleted audit, as explained in [Privacy](PRIVACY.md).

## 11. Set Up Optional Features

Optional components extend ACA but are never required — core audits work without them.

**LibreOffice** (page previews and original-document page locations):

- When LibreOffice is missing, the System readiness card shows **Download LibreOffice**, which opens the official LibreOffice website (`https://www.libreoffice.org/download/`) in your browser. LibreOffice is third-party software with its own terms and privacy policies.
- Install it yourself, then click **Check again** — no restart needed.

**Ollama and its model** (local AI citation guidance):

- When Ollama is missing, the card shows **Download Ollama**, which opens the official Ollama website (`https://ollama.com/download/windows`). Install and start it yourself.
- When Ollama is running but its AI model is missing, the card shows the exact model needed with a **Copy installation command** button. Paste the command into a terminal and run it yourself — the model download needs internet access, may take time, and needs noticeable disk space.
- Local AI performance depends on your computer's processor and memory. On a low-memory computer you can simply continue without local AI — deterministic checks are unaffected.

**ACA never downloads, installs, or runs third-party software by itself** — every download or installation is performed by you.

**Cloud AI** is a separate, explicit opt-in for a single audit. It stays off unless you turn it on for that audit and provide your own API key. When enabled, only the citation snippets relevant to confirmed findings are sent for review.

## 12. Get Help

- Something not working? See [Troubleshooting](TROUBLESHOOTING.md).
- Questions about your data? See [Privacy](PRIVACY.md).
- What ACA does not support: [Known Limitations](KNOWN_LIMITATIONS.md).
- Installing or updating ACA: [Installation](INSTALLATION.md).
