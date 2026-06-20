# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: A Hybrid Architecture for Automated Academic Compliance Auditing

A local-first, privacy-preserving full-stack web app that audits `.docx` academic documents for layout compliance (fonts, margins, heading hierarchy, media captions) and APA 7th in-text citation format. Targeted at university students and thesis supervisors.

**Repo state:** This repository is currently in the design / pre-implementation phase. Source code has not been written yet — the system is fully specified in `Architecture.md` and `PRD.md`, and the frontend is prototyped as a static HTML/Tailwind page in `stitch_academic_compliance_auditor/stitch_academic_compliance_auditor/academic_compliance_auditor_dashboard/code.html`. When implementing, treat `Architecture.md` § 4 and `PRD.md` § 3 as the authoritative spec.

## High-Level Architecture

Decoupled Browser/Server architecture with a **dual-engine** backend that runs layout checks and AI checks on parallel tracks.

```
React frontend  ──HTTP──►  FastAPI backend  ──reads──►  Target .docx
                              │                          │
                  ┌───────────┴────────────┐             ▼
                  ▼                        ▼   python-docx parses in-memory
        Fixed Layout Rules Engine    Ollama (Qwen2.5-3B)  ← DEFAULT
        (deterministic, <0.5s)       OR Gemini 1.5 Flash  ← optional, UI-gated
```

Key flow (`/api/audit`):
1. FastAPI validates `.docx` extension and 10 MB cap.
2. `run_static_rules_engine` runs synchronously on the request thread → layout errors + weighted score returned immediately.
3. `async_ai_citation_task` is dispatched as a `BackgroundTasks` job → AI citation results are merged into the same response payload (`ai_citation_tooltips`).

### Dual-engine rule

- Local AI is the default path (`DEPLOY_MODE=LOCAL`, `ollama` client → `qwen2.5:3b`).
- Cloud path (`google.generativeai` → `gemini-1.5-flash`) is **disabled by default** and must only be triggered by an explicit UI toggle that flips `DEPLOY_MODE`. Do not auto-enable it.
- `parse_ai_json` is the defensive boundary for AI output: strip ```` ```json ```` wrappers, `json.loads` in a try/except, and fall back to `{"line": -1, "msg": "non-standard"}` on any `JSONDecodeError` / `TypeError`. Never let an AI model crash the request.

### Weighted scoring rule

`base_score = 100`, then deduct per error. Structural violations (page margins, heading hierarchy gaps) are weighted as **Major Violations**; typography inconsistencies are **Minor Violations**. The exact weight table is not yet defined in the docs — when implementing, pick weights that make a single typo negligible compared to a missing heading level.

## Architectural Boundaries (do not violate)

From `PRD.md` § 4 — these are product rules, not suggestions:

- **Read-only.** The platform must never rewrite the user's `.docx`. Detection, location, and suggestions only.
- **`.docx` only.** No PDF, no LaTeX, no grammar checking, no plagiarism database lookups.
- **Read-only file handling.** Files must be read into memory buffers; never write back to the original file.
- **Cloud mode is opt-in only.** The cloud pipeline must remain locked until the user explicitly toggles it on the UI.

## Documented Limitations (from `Architecture.md` § 5)

- `python-docx` does not fully capture complex Word font inheritance and run-level local overrides. The static rules engine validates global styles and paragraph-level configs; tiny inline run overrides may slip past. Document this honestly in user-facing copy — do not promise exhaustive typography coverage.
- AI models can hallucinate or return malformed JSON. The `parse_ai_json` fallback is a first-class component, not a corner case.

## Design System (frontend contract)

The Stitch export at `stitch_academic_compliance_auditor/stitch_academic_compliance_auditor/academic_compliance_system/DESIGN.md` is the source of truth for visual design. When implementing the React app, mirror the prototype at `academic_compliance_auditor_dashboard/code.html`:

- **Aesthetic:** Corporate Modern dark mode, "deep-space" palette, Indigo primary (`#c0c1ff`), Emerald success (`#4edea3`), Rose error (`#ffb4ab`).
- **Typography:** Inter for all UI (14 px body, tighter for dense tables). JetBrains Mono for IDs / reference codes.
- **Layout:** 12-column fixed grid, 1440 px max container, 4 px spacing baseline, responsive collapses to 6-col (tablet) and 4-col (mobile). Sidebar collapses to icon rail ≤ 1023 px.
- **Depth:** Tonal layering, not shadows. Cards = `surface-container` with 1 px `outline-variant` border. Shadows ≤ 10 % opacity, only on modals / dropdowns.
- **Shape:** Soft geometry — 4 px base radius, 8 px on cards.
- **Components:** Elevated cards, semi-transparent status badges, 20–24 px stroke icons, high-density zebra-striped tables, ghost secondary buttons, Indigo focus glow on inputs.
- **Logo asset:** `academic_compliance_auditor_logo/code.html` — a 24×24 shield-with-checkmark SVG. Reuse this for brand marks.

## File Layout (current)

```
Architecture.md                                                   # system design + sample code
PRD.md                                                            # product requirements
stitch_academic_compliance_auditor/stitch_academic_compliance_auditor/
  academic_compliance_auditor_dashboard/code.html                  # React/Tailwind UI prototype
  academic_compliance_auditor_dashboard/screen.png                 # design reference
  academic_compliance_auditor_logo/code.html                       # SVG brand mark
  academic_compliance_auditor_logo/screen.png                      # design reference
  academic_compliance_system/DESIGN.md                             # design tokens + component rules
```

There are no `package.json`, `requirements.txt`, or build configs in the repo yet. Build / lint / test commands will need to be added once the implementation lands — do not invent them in the meantime.

## Working with the Stitch prototype

The dashboard HTML at `academic_compliance_auditor_dashboard/code.html` uses Tailwind via CDN with an inline `tailwind.config` and a Google Fonts stylesheet. It is a static visual prototype, not a runnable React app. When porting to React:

- Translate the inline `tailwind.config` block (lines ~13–150) into `tailwind.config.js` / `tailwind.config.ts` so the same tokens apply in the build pipeline.
- Replace Material Symbols Outlined icon font with the icon set chosen for the production app, or keep it if the prototype dependency is acceptable.
- Preserve the `darkMode: "class"` strategy and the surface-container / surface-container-high / etc. elevation scale exactly — these are the "tonal layering" the design system requires.
