# Known Limitations — Academic Compliance Auditor

These limitations describe the current release. Nothing here describes a planned or future feature.

## Platform

- ACA runs on **Windows 10/11 desktop and laptop computers only**. Mobile execution is unsupported.
- ACA works entirely on your machine and is not reachable from other computers or networks.

## Installation

- The installer is **unsigned**, so Windows may show an *Unknown publisher* or SmartScreen warning on first run. See [Troubleshooting](TROUBLESHOOTING.md).
- There is **no automatic updater** — you install a newer version by running a newer installer provided by the project owner.

## Optional components

- **LibreOffice** is optional but is needed for rendered-page previews and original-document page locations. Without it, audits complete and extracted-text evidence remains available.
- **Local AI (Ollama)** is optional. It provides suggestions for APA 7 in-text citation formatting only, needs your own review, and is not required for deterministic document auditing, formatting findings, rendered-page preview, Guided Fixes, PDF report export, or Audit History.
- Local AI performance depends on your computer's memory and processor, and **no minimum memory requirement is specified**. Low-memory computers can simply continue without local AI — deterministic checks are unaffected.
- The optional **Citation Guidance Model** is downloaded separately, after you confirm it in the app, using the Ollama service on your own computer. No download size is displayed, because a model that is not installed locally cannot be measured from a trusted source before it is fetched — the app says *Check model information* rather than guessing.
- **ACA cannot reliably stop an Ollama model download once it has started**, so no Cancel control is offered. Closing the progress view may leave Ollama downloading in the background.
- Whether a retried or interrupted model download resumes or restarts is decided by Ollama, not by ACA.
- **Cloud AI** is explicit opt-in per audit and requires your own API key. It is never enabled automatically.

## Audit scope

- **APA 7 is the supported citation style.** Other citation systems are not checked.
- ACA checks only the rules it supports (margins, fonts, sizes, spacing, headings, captions, APA 7 citations). It does not check grammar or plagiarism.
- **ACA does not guarantee institutional acceptance or complete academic compliance** — findings are guidance for your own review.

## Display of historical information

- Some information in older audits may display as **Unavailable** instead of a value (for example, a score for an audit created before scoring existed). Such audits are preserved as-is and are never re-scored automatically.
