# Privacy — Academic Compliance Auditor

ACA is a local-first application: your documents and audit results stay on your machine.

## Does ACA keep my original DOCX?

**No.** Your original DOCX file is processed in memory and is never saved to disk as a document file. The file is read once for the audit (formatting checks, section extraction, and optional page conversion), then discarded. To audit the same document again, you upload it again.

ACA does keep *derived* information from the audit: findings, locations, expected and actual values, paragraph text used as evidence, section metadata, your formatting profile snapshot, citation suggestions, document statistics, and a generated page-preview PDF when available.

## What information is stored locally?

- Your audit history: scores, findings, citation issues, paragraph evidence, profile snapshots, and document statistics.
- Generated page-preview PDFs (when LibreOffice is available).
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

Internet access happens only when you explicitly choose an optional action:

- Downloading an optional component's installer from the official website (you click the link; ACA never downloads anything by itself).
- Downloading the local AI model with the command ACA copies for you (you run it; ACA never runs it for you).
- Local AI and Cloud AI, as described below.

## What happens when Local AI is used?

Local AI citation guidance uses the Ollama service installed on your own machine. When an audit has confirmed citation findings, ACA sends only the relevant citation snippets and finding context to your local Ollama service — never the full document as a file. Results stay on your machine.

## What happens when Cloud AI is enabled?

Cloud AI is **off by default** and requires two explicit actions from you: turning it on for that specific audit and providing your own API key (none is bundled with ACA). When you enable it for an audit, the citation-review context for confirmed findings may be sent to the cloud provider you configured. Deterministic checks continue independently either way. No API keys or provider request/response payloads are written to ACA's logs.

## What happens when I delete an audit?

Deleting an audit from History or the Audit Workspace permanently removes that audit's records, findings, citation issues, and generated page preview. Deletion cannot be undone from within ACA.

One caveat: automatic database backups (kept in `backups\`) may still contain an older copy of the database that includes the deleted audit. Treat the `backups\` folder as sensitive — it is not automatically purged when you delete an audit.

## What remains after uninstalling?

Uninstalling ACA removes the program files and shortcuts, but **preserves your local data by default** — your audit history, backups, previews, and logs remain in `%LOCALAPPDATA%\AcademicComplianceAuditor\`. This protects your history if you reinstall later.

Browser storage (custom profiles, guidance dismissal) remains in your browser until you clear that site's data or your browser storage.

## How can I permanently remove local data?

1. Uninstall ACA (see [Installation](INSTALLATION.md)).
2. Delete the folder `%LOCALAPPDATA%\AcademicComplianceAuditor\`.
3. Clear ACA's browser storage via your browser's site-data settings.

Back the folder up first if you might need your audit history later — deleting it is permanent.
