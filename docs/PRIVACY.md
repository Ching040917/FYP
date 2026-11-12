# Privacy — Academic Compliance Auditor

ACA is a local-first application: your documents and audit results stay on your machine.

## Does ACA keep my original DOCX?

**ACA does not retain the original DOCX as a source file.** Upload validation, parsing and audit checks use in-memory bytes. If local LibreOffice is available, ACA then creates one short-lived DOCX copy under a random name in an operating-system temporary directory secured to the current user only. The isolated LibreOffice profile, conversion output and scratch files stay in that directory. Conversion must remove the directory before ACA accepts its rendered PDF. The original file on your computer is never modified. To audit the same document again, upload it again.

ACA does keep *derived* information from the audit: findings, locations, expected and actual values, paragraph text used as evidence, section metadata, your formatting profile snapshot, citation suggestions, document statistics, and a successfully rendered PDF preview with physical-page mapping. Conversion, privacy or cleanup failures make page preview unavailable without blocking the audit; extracted-text evidence remains available. Generated PDF audit reports and explicitly downloaded corrected DOCX copies are separate, user-requested outputs. A corrected DOCX copy is written to temporary local storage before download and deleted on a best-effort basis when you download it or after its 15-minute one-use link expires; cleanup is opportunistic, so a copy may remain briefly until the next cleanup run.

Temporary conversion copies are deleted on ordinary success, conversion failure, timeout, and supported cancellation/interruption paths. A forced application termination, power loss, operating-system fault or locked file can prevent cleanup. ACA never treats an observed cleanup failure as successful conversion. This is deletion, not guaranteed forensic erasure: temporary data may survive in filesystem recovery data, paging, or device backups. Such copies are not saved in Audit History; treat the current user's temporary storage as sensitive after an abnormal shutdown.

## What information is stored locally?

- Your audit history: scores, findings, citation issues, paragraph evidence, profile snapshots, and document statistics.
- Extracted-text paragraph blocks in the local database, and successfully generated page-preview PDFs in `rendered-previews\`. Neither is the original DOCX.
- Automatic database backups created before upgrades.
- Diagnostic logs (start-up, port selection, health checks, safe error categories — never document text).
- Browser storage: your saved custom profiles, current profile selection, an unsaved profile draft if you close the editor mid-edit, and whether you dismissed the first-run guidance.

## Where is local data stored?

Everything is stored under your Windows user profile:

```
%LOCALAPPDATA%\AcademicComplianceAuditor\
```

Inside: `audit.db` (audit history database), `backups\` (verified backups, up to three backup identities retained, including the current upgrade backup and the newest remaining verified backups), `rendered-previews\` (generated page previews), `logs\` (diagnostic logs), and temporary files while running. See [Installation](INSTALLATION.md) for details.

## Does ACA send information to the internet?

**Core audits never send your document or findings anywhere.** Deterministic formatting and citation checks run entirely offline on your machine. ACA is bound to your computer only (`127.0.0.1`) and is not reachable from other machines.

ACA bundles a synthetic sample thesis (`sample-thesis.docx`) generated with `python-docx`. The sample action loads this bundled file through the app's loopback-only server and automatically audits it using your selected profile, without Internet access. It contains only synthetic academic text and planted formatting variations, not Owner or user document data. It uses the same private temporary local-rendering path as an uploaded DOCX.

Internet access happens only when you explicitly choose an optional action:

- Downloading an optional component's installer from the official website (you click the link; ACA never downloads the installer).
- Downloading the optional **Citation Guidance Model**. After you confirm it in the app, ACA's Backend asks the Ollama service running on your own computer (`127.0.0.1`) to fetch the model. **ACA itself never contacts the model registry** — the download traffic belongs to Ollama, on your machine. You can also copy the `ollama pull` command and run it yourself instead.
- Local AI Citation Guidance, as described below.

Starting a model download sends only the model name and download flags to your local Ollama service. No document, finding, citation, prompt, or identifier is sent, and the request never goes anywhere except your own computer.

## What happens when the citation-guidance model is downloaded?

The download is performed by the Ollama service running on your own computer (`127.0.0.1`), not by ACA. After you explicitly confirm the download, ACA coordinates with your local Ollama service through loopback requests: verifying whether the model is already installed, initiating the download pull, and verifying completion.

Download progress is held in memory for the active user interface display; closing ACA discards the in-memory progress display. Progress is never written to the database, to Audit History, or to user document storage. Application diagnostic logs may record download state transitions and byte-count progress metrics for troubleshooting. These log entries contain operational telemetry only: no document content, uploaded document text, citation text, model prompts, model responses, or consent tokens are ever logged. Nothing about your documents is involved.

## What happens when Local AI is used?

Local AI citation guidance uses the Ollama service installed on your own machine. Local AI is optional and can be disabled completely by setting `LOCAL_AI_ENABLED=false` in the backend configuration. When disabled, zero citation snippets are extracted or held in memory for AI, no background guidance task is dispatched, and no HTTP requests are made.

When enabled, ACA strictly restricts all AI guidance requests to verified loopback origins (`127.0.0.1`, `localhost`, or `[::1]`) on plain HTTP without user credentials, subpaths, queries, or fragments. HTTP redirects are rejected (`follow_redirects=False`) to prevent any redirection off loopback. Any non-loopback, LAN, or remote host configuration fails closed: citation snippets are never transmitted, guidance becomes unavailable, and deterministic audit scores and findings complete unaffected.

When an audit has confirmed eligible citation findings and a verified loopback host is configured, ACA sends only the existing minimum in-text citation snippet (the finding's actual value) and finding context to your local Ollama service — never the uploaded DOCX file, the full document body, a rendered PDF, or Reference List/bibliography text. The citation comparison itself runs without the model. This existing snippet guidance is optional; improved Local AI visibility does not expand eligibility or the data sent. Results stay on your machine.

No cloud AI provider is included in ACA. There is no external AI API key to configure, no provider selection, and no cloud opt-in; no document text, citation context, prompt, or finding is ever transmitted to a third-party AI service. Local AI requests go only to your own verified loopback Ollama service.
## What happens when I delete an audit?

Deleting an audit from History or the Audit Workspace permanently removes that audit's records, findings, citation issues, and document blocks, and attempts to delete its stored rendered PDF. A missing or locked PDF does not block audit deletion; a locked preview may remain in local storage. Deletion cannot be undone from within ACA.

One caveat: automatic database backups (kept in `backups\`) may still contain an older copy of the database that includes the deleted audit. Treat the `backups\` folder as sensitive — it is not automatically purged when you delete an audit.

## What remains after uninstalling?

Uninstalling ACA removes the program files and shortcuts, but **preserves your local data by default** — your audit history, backups, previews, and logs remain in `%LOCALAPPDATA%\AcademicComplianceAuditor\`. This protects your history if you reinstall later.

Browser storage (custom profiles, guidance dismissal) remains in your browser until you clear that site's data or your browser storage.

## How can I permanently remove local data?

1. Uninstall ACA (see [Installation](INSTALLATION.md)).
2. Delete the folder `%LOCALAPPDATA%\AcademicComplianceAuditor\`.
3. Clear ACA's browser storage via your browser's site-data settings.

Back the folder up first if you might need your audit history later — deleting it is permanent.
