# Privacy — Academic Compliance Auditor

ACA is a local-first application: your documents and audit results stay on your machine.

## Does ACA keep my original DOCX?

**No.** Your original DOCX file is processed in memory and is never saved to disk as a document file. The file is read once for the audit (formatting checks and section extraction), then discarded. To audit the same document again, you upload it again.

ACA does keep *derived* information from the audit: findings, locations, expected and actual values, paragraph text used as evidence, section metadata, your formatting profile snapshot, citation suggestions, and document statistics. In ACA v1.0.0, page-rendered preview via LibreOffice conversion is disabled to ensure zero temporary document copies are written to disk; extracted-text preview is the active preview mode. Generated PDF audit reports and explicitly downloaded corrected DOCX copies are separate, user-requested outputs.

## What information is stored locally?

- Your audit history: scores, findings, citation issues, paragraph evidence, profile snapshots, and document statistics.
- In-memory extracted-text preview (stored as paragraph blocks in your local database). Generated page-preview PDFs are unavailable in v1.0.0 to prevent temporary document writes.
- Automatic database backups created before upgrades.
- Diagnostic logs (start-up, port selection, health checks, safe error categories — never document text).
- Browser storage: your saved custom profiles, current profile selection, an unsaved profile draft if you close the editor mid-edit, and whether you dismissed the first-run guidance.

## Where is local data stored?

Everything is stored under your Windows user profile:

```
%LOCALAPPDATA%\AcademicComplianceAuditor\
```

Inside: `audit.db` (audit history database), `backups\` (verified backups, three newest retained), `rendered-previews\` (generated page previews), `logs\` (diagnostic logs), and temporary files while running. See [Installation](INSTALLATION.md) for details.

## Does ACA send information to the internet?

**Core audits never send your document or findings anywhere.** Deterministic formatting and citation checks run entirely offline on your machine. ACA is bound to your computer only (`127.0.0.1`) and is not reachable from other machines.

ACA bundles a synthetic sample thesis (`sample-thesis.docx`) generated with `python-docx`. Selecting the sample loads it directly from local bundled assets entirely offline without network access; the sample contains only synthetic academic text and planted formatting variations, and contains no Owner or user document data.

Internet access happens only when you explicitly choose an optional action:

- Downloading an optional component's installer from the official website (you click the link; ACA never downloads the installer).
- Downloading the optional **Citation Guidance Model**. After you confirm it in the app, ACA's Backend asks the Ollama service running on your own computer (`127.0.0.1`) to fetch the model. **ACA itself never contacts the model registry** — the download traffic belongs to Ollama, on your machine. You can also copy the `ollama pull` command and run it yourself instead.
- Local AI Citation Guidance, as described below.

Starting a model download sends only the model name and download flags to your local Ollama service. No document, finding, citation, prompt, or identifier is sent, and the request never goes anywhere except your own computer.

## What happens when the citation-guidance model is downloaded?

The download is performed by your local Ollama service, not by ACA. ACA's Backend sends a single request to `127.0.0.1` naming the configured model, and progress state (status text and byte counts) is held in memory only: it is never written to the database, to Audit History, to a log, or to disk. Nothing about your documents is involved, and closing ACA discards the progress display.

## What happens when Local AI is used?

Local AI citation guidance uses the Ollama service installed on your own machine. Local AI is optional and can be disabled completely by setting `LOCAL_AI_ENABLED=false` in the backend configuration. When disabled, zero citation snippets are extracted or held in memory for AI, no background guidance task is dispatched, and no HTTP requests are made.

When enabled, ACA strictly restricts all AI guidance requests to verified loopback origins (`127.0.0.1`, `localhost`, or `[::1]`) on plain HTTP without user credentials, subpaths, queries, or fragments. HTTP redirects are rejected (`follow_redirects=False`) to prevent any redirection off loopback. Any non-loopback, LAN, or remote host configuration fails closed: citation snippets are never transmitted, guidance becomes unavailable, and deterministic audit scores and findings complete unaffected.

When an audit has confirmed citation findings and a verified loopback host is configured, ACA sends only the relevant citation snippets and finding context to your local Ollama service — never the full document as a file. Reference List entries and bibliography text are never sent to the model, and the citation comparison itself runs without it. Results stay on your machine.

No cloud AI provider is included in ACA. There is no external AI API key to configure, no provider selection, and no cloud opt-in; no document text, citation context, prompt, or finding is ever transmitted to a third-party AI service. Local AI requests go only to your own verified loopback Ollama service.
## What happens when I delete an audit?

Deleting an audit from History or the Audit Workspace permanently removes that audit's records, findings, citation issues, and document blocks. Deletion cannot be undone from within ACA.

One caveat: automatic database backups (kept in `backups\`) may still contain an older copy of the database that includes the deleted audit. Treat the `backups\` folder as sensitive — it is not automatically purged when you delete an audit.

## What remains after uninstalling?

Uninstalling ACA removes the program files and shortcuts, but **preserves your local data by default** — your audit history, backups, previews, and logs remain in `%LOCALAPPDATA%\AcademicComplianceAuditor\`. This protects your history if you reinstall later.

Browser storage (custom profiles, guidance dismissal) remains in your browser until you clear that site's data or your browser storage.

## How can I permanently remove local data?

1. Uninstall ACA (see [Installation](INSTALLATION.md)).
2. Delete the folder `%LOCALAPPDATA%\AcademicComplianceAuditor\`.
3. Clear ACA's browser storage via your browser's site-data settings.

Back the folder up first if you might need your audit history later — deleting it is permanent.
