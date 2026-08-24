# Privacy — Academic Compliance Auditor

ACA is a local-first application. Most processing happens on your machine.

## Original DOCX

Uploaded source DOCX files are processed in memory without being retained as source documents. The file bytes are read once for parsing, layout checks, section extraction, and optional PDF conversion, then discarded. ACA never writes the original DOCX to disk.

ACA may retain derived and structured data from the Audit:

- paragraph blocks used for evidence (ordered, paragraph-only)
- section metadata (section index, paragraph ranges, break type, page size, margins)
- immutable formatting profile snapshot captured at audit creation
- findings (rule, severity, location, message, expected and actual values)
- citation suggestions and document statistics
- rendered preview PDF (when generated)

## Local data

All mutable packaged data lives under:

```
%LOCALAPPDATA%\AcademicComplianceAuditor\
  audit.db                 # SQLite production database
  backups\                 # verified SQLite backups audit.db.r…_to_….bak
  rendered-previews\       # generated PDF previews <audit-id>.pdf
  logs\launcher.log        # rotating launcher log 1 MB × 5
  instance.json            # present only while running
  tmp\                     # temporary runtime files
```

ACA may store locally:

- `audit.db` — audit metadata, findings, citation suggestions, paragraph blocks, section metadata, profile snapshots, preview metadata
- `rendered-previews\<audit-id>.pdf` — derived PDFs, not the original DOCX
- `backups\` — verified SQLite backups retained per upgrade (three newest)
- `logs\launcher.log` — lifecycle, port, health timing, mutex, browser result, safe shutdown reason, safe error categories
- `instance.json` — version, pid, port while running
- Browser storage (see below)

Source DOCX bytes, original filenames beyond `audit.filename` metadata, and absolute document paths are never persisted as files.

## Browser storage

ACA uses browser storage for verified purposes only:

- **Custom Profile localStorage** — validated custom profiles and current selection (`profile_id`/`version`), filtered to built-ins and valid custom profiles only. Corrupted or future-version stores are discarded; built-ins remain available.
- **Audit completion sessionStorage** — the most recent successful audit's completion snapshot (`audit_id`, score, counts, timestamp) via `createSessionStorageAdapter`. It survives same-tab navigation and refresh, is cleared on View audit or Dismiss, and never restores a stale predecessor after failure.
- **Unsaved Profile draft recovery** — an in-progress custom profile draft is recovered when the editor reloads after an accidental close. A malformed draft is removed.
- **First-run guidance dismissal** — versioned localStorage flag set by `saveGuidanceDismissed`; `createBrowserGuidanceAdapter` and `createMemoryGuidanceAdapter` manage it, with corrupted records removed. Use **Show setup guidance** to reopen.

Raw storage payloads are not included in this document and are never logged.

## Local AI

Local AI uses the configured local Ollama service (`OLLAMA_HOST`, model `qwen3.5:4b`). Deterministic checks do not require Local AI; model availability is shown through Dashboard readiness. Only source-proven citation snippets and finding context are sent to the local service, not the full document as a stored file. ACA does not make stronger privacy claims than this deterministic-plus-snippet behavior.

## Cloud AI

Cloud AI is explicit opt-in per audit (default off). ACA never enables Cloud AI automatically. Credentials are user-provided via `GEMINI_API_KEY` (or cloud toggle) and are not bundled with the application. When you enable Cloud AI for an audit, citation-review context for confirmed findings may be sent to the configured cloud provider. Deterministic layout checks continue independently of Cloud availability, and the existing local-fallback behavior may apply when local Ollama is unavailable. No API keys or provider payloads are written to launcher logs.

## Deletion and backups

Deleting an audit via History or the Audit Workspace removes the audit row and its child violations and citation issues (cascade delete), and removes its rendered preview file best-effort. Deletion does not automatically purge database backups — `backups\` may still contain earlier `audit.db` copies that include the deleted audit's record. Treat backups as sensitive.

Uninstalling or deleting the application folder does **not** automatically remove `%LOCALAPPDATA%\AcademicComplianceAuditor`. Manage `audit.db`, `backups\`, `rendered-previews\`, `logs\`, and browser storage separately if you need to fully remove local data. Back up local data before manual removal if you need to keep Audit History.

## Logs

Launcher logs under `logs\launcher.log` contain lifecycle, selected port, health duration, mutex result, browser result, safe shutdown reason, and safe error categories (for example, `port_unavailable`, `health_timeout`, `missing_frontend_resources`). They do not contain document text, uploaded filenames, profile payloads, API keys, or Cloud provider request and response payloads. Browser console logs for audit processing contain only audit ID and safe categories, never document content.
