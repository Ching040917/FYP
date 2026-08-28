# Known Limitations — Academic Compliance Auditor

Every limitation below reflects verified behavior of the current source, tests, and packaged release. Nothing on this page describes a planned or future feature.

## Platform

- Windows 10/11 desktop local execution only.
- Minimum supported desktop width: 768 px. 1280 px or wider is recommended.
- Mobile local execution is unsupported.
- ACA binds only to `127.0.0.1` (loopback). No LAN or remote access.

## Packaged Windows release

- The one-folder package (`run-frozen.exe` + `_internal`) is **unsigned** unless signing is configured in the build. Windows SmartScreen or antivirus may warn on first launch; no specific allowance is documented.
- No automatic updater or code signing is included.
- The Windows installer (Setup EXE) uninstalls cleanly but **always preserves**
  user data under `%LOCALAPPDATA%\AcademicComplianceAuditor`. There is no
  optional data-deletion checkbox during uninstall because Inno Setup provides
  no reliable Pascal Script API to read an uninstall-task selection. To fully
  remove local data, delete that folder manually after uninstalling.
- The complete one-folder distribution must remain intact — `run-frozen.exe` and `_internal` must stay together. Moving or renaming either breaks ACA.
- Only one Backend instance per machine is supported. Multiple Backend instances sharing the same database are unsupported and are prevented by the Launcher mutex.
- The Backend never listens outside loopback; no LAN exposure exists by design.

## Optional components

- **LibreOffice** is optional but required for the rendered-page Preview. Without it, audits still complete and Extracted Text evidence remains available.
- **Ollama** with the configured model `qwen3.5:4b` is optional and enables Local AI-assisted citation review. Deterministic checks continue without AI.
- **Cloud AI (Gemini)** is explicit opt-in per Audit. It requires a user-provided `GEMINI_API_KEY`; none is bundled. Without it, deterministic checks continue independently.

## Audit scope

- Deterministic checks report only the checks ACA supports. **ACA does not guarantee institutional acceptance or academic compliance** — it produces findings for review.
- **APA 7 is the supported citation style.** Other citation systems are unsupported.
- Role classification may be uncertain; role-based exemptions apply conservatively when a paragraph cannot be classified confidently.
- Genuinely unresolved formatting values are reported as unavailable rather than fabricated as `0` or defaults.

## Historical Audits and database states

- Legacy Audits created at older Alembic revisions may show **Unavailable** for score, statistics, preview metadata, or profile snapshot. They are preserved as-is and are never re-scored automatically.
- PDF Export returns an unavailable response when a valid `weighted_score` is absent.
- Databases that are unstamped, corrupt, unknown-revision, future-revision, multi-head, or ambiguous are refused without modification.
- There is **no automatic restoration from database backups** after a failed migration. Verified backups under `backups\` are preserved for diagnosis and later explicit restore.
- Three newest verified backups are retained; older ones are pruned only after successful upgrade and post-upgrade verification.

## Browser storage

- Custom Profiles, unsaved drafts, audit completion snapshots, and first-run guidance dismissal live in browser localStorage/sessionStorage. A corrupted store may require recovery; built-in profiles always remain available.

## Data retention

- Original DOCX files are not retained — they are processed in memory and discarded.
- Derived Audit data (findings, paragraph blocks, section metadata, profile snapshots, rendered previews) is stored locally under `%LOCALAPPDATA%\AcademicComplianceAuditor`. See [Privacy](PRIVACY.md).
