# User Guide — Academic Compliance Auditor

This guide is for ordinary Windows desktop users running the packaged release. For developer setup, see [Installation Guide](INSTALLATION.md).

## 1. Starting ACA

Double-click `run-frozen.exe` in the extracted one-folder release. Keep `run-frozen.exe` and `_internal` together. ACA binds only to `127.0.0.1` (`8010` then `8011–8015` if needed), waits for health, then opens `http://127.0.0.1:<port>/dashboard`. A second launch reuses the healthy instance; closing the Launcher stops only the owned Backend.

## 2. Dashboard and System Readiness

The Dashboard shows **Audit Dashboard** with an editorial header, a left intake column and a right result column. The **System Readiness** card (from `ReadinessCard`) reports whether ACA and optional components are ready. Use its refresh action when you install or remove an optional component.

## 3. Required versus optional components

Required: deterministic formatting checks. Optional: LibreOffice (rendered-page preview), Ollama `qwen3.5:4b` (local AI), Cloud AI (explicit opt-in). Missing optional components show a degraded readiness state but do not block audits.

## 4. Uploading a DOCX document

In the left intake panel, use the upload dropzone (`upload-dropzone`). Drag a `.docx` or browse to select one. Documents are processed locally by default.

## 5. Maximum supported upload size

10 MB (`MAX_FILE_SIZE=10485760`). Larger files are rejected with a safe error.

## 6. Selecting a Formatting Profile

Above the upload card, select one of:

- **SUC Academic Report** (recommended default)
- **APA 7 Student Paper**
- **Custom Formatting Profiles** (your saved profiles, listed by name)

Selection persists in browser storage.

## 7. Custom Formatting Profiles

**Creating:** In the profile selector, create a custom profile — set font, spacing, margins, and citation style. Use the in-app **Validate** action; only a backend-confirmed valid profile can be saved.

**Editing:** Open a saved custom profile, edit fields, and validate again before saving. The editor shows per-field friendly messages, never raw Python paths.

**Saving:** Saving writes a validated profile to browser localStorage with versioned identity (`profile_id`, `profile_version`). The saved profile appears in the selector.

**Recovering:** If you close the tab mid-edit, an unsaved draft is recovered on return when the editor reloads (draft recovery from localStorage). A corrupted or future-version store is discarded and built-ins remain available.

**Deleting:** Delete a custom profile from the selector or editor. Deleting the currently selected custom profile resets the selection to the SUC built-in.

**Conflict from another tab:** A profile created in another tab appears after the selector merges external changes. Version conflicts use a revision guard — a stale write is refused and you are prompted to reload.

## 8. Disabled requirements and `Not checked`

Some profile requirements can be `null` (for example, margins `left_in: null`). Disabled requirements show as **Not checked** and do not produce findings. This is not a pass — it means the check is not applicable for that profile.

## 9. Local AI when Cloud AI is Off

When Cloud AI is Off (default), local AI via Ollama may still run if installed. Deterministic checks always run. `qwen3.5:4b` availability is shown in readiness. Local AI receives only citation snippets, not the full document.

## 10. Cloud AI opt-in

Cloud AI (Gemini) is off by default. It runs only when you explicitly enable it for that audit. Credentials are user-provided (`GEMINI_API_KEY`), never bundled. When enabled, citation-review context may be sent to the configured provider; deterministic checks continue independently. If local Ollama is unavailable, Cloud may fall back to local per build logic.

## 11. Running an Audit

Select a profile, upload a `.docx`, optionally toggle Cloud AI, then run the audit. Results appear in the right column as a compliance summary. The full evidence report is not duplicated on the Dashboard — it opens in the Audit Workspace.

## 12. Understanding results

- **Score** — weighted compliance score out of 100 (major findings deduct more than minor). Unavailable for historical audits with no computed score.
- **Major and Minor findings** — counts and per-category breakdown.
- **Expected and Actual values** — the profile requirement versus what was found in the document.
- **Rendered-page evidence** — a PDF preview of the document pages, generated via LibreOffice when available.
- **Extracted Text fallback** — when rendered preview is unavailable, findings still link to the exact paragraph in the extracted text viewer.
- **Location unavailable** — some findings have no precise paragraph mapping; they are still listed with their rule and message.

ACA does not guarantee academic compliance; it reports the checks it supports.

## 13. Opening the exact completed Audit

After a successful audit, use **View audit** in the completion panel or Dashboard summary. The exact stored `audit_id` is used (`/audit/<id>`), never a recomputed one.

## 14. History

History (`/history`) lists past audits with score, status, and date. Use it to reopen any audit. History is local — it reads `audit.db` under `%LOCALAPPDATA%\AcademicComplianceAuditor`.

## 15. PDF Export

In the Audit Workspace, export the audit report as PDF. Export is deterministic and offline — it reads persisted findings only. If no score is available, export returns an unavailable response instead of a fabricated score.

## 16. Interrupted Audits

If the Backend restarts while an audit is `processing` and the record was created before the new process started, it transitions to `interrupted` with reason `application_restart` and unavailable preview metadata. Interrupted audits cannot be exported.

## 17. Uploading the document again

Use **Upload again** to return to the Dashboard with a fresh dropzone. The original DOCX is never retained; you must re-upload the file.

## 18. Deleting an Audit

Delete an audit from History or the Audit Workspace. This removes the audit row and its child violations and citation issues (cascade), and removes its rendered preview file best-effort. Deletion is permanent.

## 19. First-run guidance and reopening setup guidance

On first visit, a guidance panel explains supported checks and how to start. Dismiss it with **Dismiss** — the dismissal is stored in versioned localStorage. Use **Show setup guidance** in the readiness card details to reopen it.

## Platform notes

Windows 10/11 desktop, 768 px minimum supported width, 1280 px or wider recommended. Mobile local execution is unsupported.
