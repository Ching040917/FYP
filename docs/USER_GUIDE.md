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

### Optional structural reviews

In a Custom Profile, expand **Header**, **Footer**, or **Page numbers** and
enable its check independently. Each disabled group shows **Not checked**;
enabled groups show **Enabled · Manual review only (unscored)**. Page numbers
also offers **Header**, **Footer**, or **Either** placement (default Either).
Save the profile before selecting it for an audit. Built-in Profiles are
read-only; copy one to create an independent editable Custom Profile.

These requirements concern stored **Normal-pages** definitions in every
document section, including inherited definitions. First-page and even-page
definitions are not checked. Header/Footer content means supported stored
text or a supported field; page numbering requires a genuine PAGE field,
not typed digits. Unsupported objects or malformed fields can prevent a
determination and are reported for review, not as confirmed empty content.

The findings are **Manual review**, never scored. When the section's first
rendered page can be proven, selecting a finding opens that page and shows
**Page-level structural evidence**. No exact Header/Footer highlight is
available, and ACA draws no rectangle. If mapping is unavailable, **Structural
evidence only** shows **Rendered page could not be determined** without
changing the current preview page. A page location does not establish
rendered visibility, field freshness, numbering format or sequence.

The Dashboard separates **Scored checks**, **Manual review only · Unscored**,
**Not checked**, and **Citation style**. Headers, Footers, and Page numbers
each show their own status; enabled page numbers also show placement.
Use **Review full requirements** for the complete grouped inventory in a
scrollable dialog. Opening it does not expand the Dashboard or move the
audit-start controls. Escape or **Close** returns focus to its trigger.
Header, Footer, and Page Number requirements never affect the score.

Inspect and correct these requirements manually in Word; Local AI and
Guided Fixes do not apply. Existing History entries retain their saved
requirements and findings even if you later edit the Custom Profile.

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

### Guided Fixes: verified formatting copies

In a completed Audit Workspace, select candidate font family, font size,
paragraph alignment, line spacing, paragraph spacing, or Reference heading
alignment findings. Reference heading alignment is eligible only when the
saved profile enables that check and the document has one unambiguous,
supported heading; other Reference List findings remain manual. Re-upload
the **exact original DOCX** used for that audit. ACA checks every selected
location and shows the confirmed current and required values before you
approve a change. If a location or requirement cannot be verified safely,
correct that finding manually in Word instead.

Findings that ACA cannot safely correct automatically remain visible under
**Manual correction required** without a selection checkbox; follow their
**Required action** in the audit report. If no findings are candidates, the
selection view explains this and **Review** remains unavailable. The upload
header's **Back to findings** arrow returns to the selection without clearing
it. The pre-Apply review labels the saved-profile destination **Required and
proposed**; nothing has changed until Apply passes verification. At high
browser zoom, scroll within the dialog to reach its safety text and actions.

After you choose **Apply and verify changes**, ACA compares the saved DOCX
package with the original, re-runs deterministic checks with the audit's saved
profile, and rejects any unverified or regressed result. Only a passed review
and re-audit unlocks **Download corrected document**. Download the copy within
15 minutes; the link works once. Review its appearance in Microsoft Word
before submission: even a verified formatting change can alter page layout.
Neither the original DOCX nor its saved Audit History row is changed.
The temporary corrected copy is removed when downloaded or expired. Uploading
it as a new audit creates an independent Audit ID, not a linked History entry.

## 8. Export a PDF Report

Use **Export PDF** in the Audit Workspace to save a PDF report containing your findings, locations, and required actions. Export is offline and deterministic — it reads the stored audit only. Audits without a score (interrupted or very old) cannot be exported.

The report starts with score and finding-count cards. **Attention Required**
shows up to three saved Major findings, then Manual-review findings, in their
saved order. Minor findings are not assigned an invented priority:
**Issue Frequency Summary** counts saved Minor findings by issue type.
These counts are findings, not consolidated occurrence totals.

The next page's **Profile Coverage Matrix** distinguishes scored checks,
unscored manual requirements, and requirements that were not checked.
**Formatting Issue Summary** groups saved Minor findings by rule and required
value, with observed values and proven pages. The complete Findings Registers
retain each saved finding, its Current and Required values, and its location.
Full saved requirements appear once in **Appendix: Full Profile Requirements**;
the report ends with scope, limitations, privacy, and document-safety notes.

Manual-review cards separate the finding, location, expected requirement,
action, and evidence limitation. A proven section page is not an exact
Header/Footer highlight, and an automatic PAGE field does not prove final
rendered numbering. New exports of historical audits use their saved Profile
Snapshot and findings, not today's edited Profile.

## 9. Use Audit History

**History** lists your past audits with score, status, and date. Open any audit to review its findings again. History is stored locally on your machine.

## 10. Delete an Audit

Delete an audit from History or the Audit Workspace. **Deletion is permanent** — a deleted audit cannot be recovered from within ACA. Note that older database backups on disk may still contain a copy of the deleted audit, as explained in [Privacy](PRIVACY.md).

## 11. Set Up Optional Features

Optional components extend ACA but are never required — core audits work without them.

**LibreOffice** (page previews and original-document page locations):

- When LibreOffice is missing, the System readiness card shows **Download LibreOffice**, which opens the official LibreOffice website (`https://www.libreoffice.org/download/`) in your browser. LibreOffice is third-party software with its own terms and privacy policies.
- Install it yourself, then click **Check again** — no restart needed.

**Ollama and its model** (optional **Local AI Citation Guidance**):

Local AI Citation Guidance is an optional feature. It provides suggestions for **APA 7 in-text citation formatting only**. It is not a full academic review, does not rewrite or correct your DOCX, does not verify citation sources or complete reference lists, and does not check grammar or plagiarism. Suggestions may be incomplete or inaccurate — review every suggestion before using it. It is not required for deterministic document auditing, formatting findings, rendered-page preview, Guided Fixes, PDF report export, or Audit History.

- When Ollama is missing, the card shows **Download Ollama**, which opens the official Ollama website (`https://ollama.com/download/windows`). Install and start it yourself.
- When Ollama is running but its Citation Guidance Model is missing, the card shows the exact model needed with a **Download optional model** button. That opens a confirmation dialog — the download starts only if you choose **Start download**. ACA then asks your own Ollama service to fetch the model and shows progress, storage guidance, and the model name in the card. A model that is already installed is confirmed and marked ready without downloading anything again.
- Prefer to do it yourself? **Copy installation command** copies the exact `ollama pull` command for you to run in your own terminal. It stays available at all times.
- The download needs an internet connection, several gigabytes of storage, and may take time. **ACA cannot reliably stop an Ollama model download once it has started**, so there is no Cancel button: closing the progress view may leave Ollama downloading in the background. ACA never stops Ollama to interrupt a download.
- Local AI performance depends on your computer's memory and processor. On a low-memory computer you can simply continue without local AI — deterministic checks are unaffected.
- When the download finishes, ACA confirms the model through Ollama itself and the card updates to **Ready**. **Check again** re-checks at any time.

**ACA never installs third-party software and never runs a local command for you.** The only download it can start is the optional Citation Guidance Model, from your own Ollama service, and only after you confirm it.

## 12. Get Help

- Something not working? See [Troubleshooting](TROUBLESHOOTING.md).
- Questions about your data? See [Privacy](PRIVACY.md).
- What ACA does not support: [Known Limitations](KNOWN_LIMITATIONS.md).
- Installing or updating ACA: [Installation](INSTALLATION.md).
