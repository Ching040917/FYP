# Known Limitations — Academic Compliance Auditor

These limitations describe the current release. Nothing here describes a planned or future feature.

## Platform

- ACA runs on **Windows 10/11 desktop and laptop computers only**. Mobile execution is unsupported.
- ACA works entirely on your machine and is not reachable from other computers or networks.

## Installation

- The installer is **unsigned**, so Windows may show an *Unknown publisher* or SmartScreen warning on first run. See [Troubleshooting](TROUBLESHOOTING.md).
- There is **no automatic updater** — you install a newer version by running a newer installer provided by the project owner.

## Optional components

- **Page-rendered preview and LibreOffice:** In ACA v1.0.0, page-rendered preview and physical page location mapping are disabled to preserve ACA's strict in-memory privacy contract: uploaded DOCX bytes are processed purely in memory and are never written to temporary files on disk. Extracted-text preview and paragraph-level evidence linking remain fully available for every audit.
- **Local AI (Ollama)** is optional. It provides suggestions for APA 7 in-text citation formatting only, needs your own review, and is not required for deterministic document auditing, formatting findings, rendered-page preview, Guided Fixes, PDF report export, or Audit History.
- Local AI citation guidance strictly requires a verified local loopback Ollama instance (`127.0.0.1`, `localhost`, or `[::1]`). Remote LAN, external, or cloud Ollama hosts are intentionally rejected to enforce ACA's zero-leakage privacy invariants. When disabled (`LOCAL_AI_ENABLED=false`) or configured with an unverified host, Local AI guidance is unavailable while deterministic audits continue unaffected.
- Local AI performance depends on your computer's memory and processor, and **no minimum memory requirement is specified**. Low-memory computers can simply continue without local AI — deterministic checks are unaffected.
- The optional **Citation Guidance Model** is downloaded separately, after you confirm it in the app, using the Ollama service on your own computer. No download size is displayed, because a model that is not installed locally cannot be measured from a trusted source before it is fetched — the app says *Check model information* rather than guessing.
- **ACA cannot reliably stop an Ollama model download once it has started**, so no Cancel control is offered. Closing the progress view may leave Ollama downloading in the background.
- Whether a retried or interrupted model download resumes or restarts is decided by Ollama, not by ACA.

## Audit scope

- **APA 7 is the supported citation style.** Other citation systems are not checked.
- ACA checks only the rules it supports (margins, fonts, sizes, spacing, headings, captions, APA 7 citations). It does not check grammar or plagiarism.
- **ACA does not guarantee institutional acceptance or complete academic compliance** — findings are guidance for your own review.
- Citation checking compares author surnames and years only. It does not compare initials, so two sources by different people with the same surname and year are reported as a **Manual review** item instead of being guessed.
- Organisation authors, name particles ("van der Berg"), three-or-more author comma chains, title-based citations, numeric styles such as `[12]`, and citations inside tables, text boxes, comments, footnotes, or tracked insertions are **outside the supported comparison** and produce no finding.
- Reference List entries that do not begin with a surname followed by a comma or full stop (the usual APA entry shape) cannot be compared, so they never produce an uncited-entry or duplicate-entry finding.
- The comparison stops at the References heading and at the first Appendix heading: citations inside appendices are not checked.
- Citation matching never edits your document, never verifies that a source is real, and never rewrites the Reference List.

## Guided Fixes

- Only eligible direct font family/size and paragraph alignment/line/before/after spacing findings, plus a unique, resolved Reference heading alignment enabled by the saved profile, can be changed. Other Reference List findings and unsafe, ambiguous, partially indexed or already compliant targets remain manual.
- A corrected copy is available only after whole-package preservation and deterministic re-audit pass. This is not a guarantee of identical Word pagination or institutional acceptance; inspect the downloaded copy in Word.
- Reviews and one-use downloads expire after 15 minutes and do not survive an application restart. Verified output is temporary local storage; the original document and saved History row are unchanged. A later upload of the corrected document is an independent audit.

## Display of historical information

- Some information in older audits may display as **Unavailable** instead of a value (for example, a score for an audit created before scoring existed). Such audits are preserved as-is and are never re-scored automatically.
