# Academic Compliance Auditor

Academic Compliance Auditor (ACA) is a Windows application that reviews academic DOCX documents for formatting and APA 7 citation issues. All checks run locally on your machine. Findings are guidance for your own review — ACA does not guarantee institutional acceptance or complete academic compliance.

## Download

Academic Compliance Auditor is currently distributed privately for evaluation.

Installer: `AcademicComplianceAuditor-Setup-1.0.0.exe`

Obtain it from:

- the project owner, or
- the approved university submission or evaluation channel

Please note:

- A public download page is not currently available.
- The installer is unsigned, so Windows may display an *Unknown publisher* or SmartScreen warning. See [Troubleshooting](docs/TROUBLESHOOTING.md).

## Quick Start

1. Obtain the Windows installer from the project owner or your approved evaluation channel.
2. Double-click the Setup EXE.
3. Complete the installation — per-user, no administrator rights needed.
4. Open ACA from the Windows Start Menu.
5. Upload a DOCX document or use the sample document.
6. Review findings and export the PDF report.

Python and Node.js are not required.

![Academic Compliance Auditor Dashboard showing System Readiness, setup guidance, and the DOCX audit upload area.](docs/images/aca-dashboard.png)

## Review Findings with Page Evidence

After an audit, ACA shows what it found and why:

- Identifies supported formatting and citation issues, grouped by severity.
- Shows the required value and the value found in your document (Expected and Actual).
- Links supported body findings to a rendered page preview when the optional LibreOffice integration is available, or to extracted text otherwise. Structural reviews identify stored section/story definitions without a visual region.
- Produces a PDF report you can save or share.

![Academic Compliance Auditor workspace showing compact findings, Document Preview with inline Evidence details, and read-only Current and Required values.](docs/images/aca-audit-workspace.png)

### Optional Header, Footer and Page Number reviews

Custom Profiles can independently enable **Check Header requirements**,
**Check Footer requirements**, and **Check Page Number requirements**. All
three default to Off (**Not checked**); Built-in Profiles remain unchanged.
Page Number placement can be Header, Footer or Either without enabling a
Header or Footer content requirement.

These checks inspect each section's stored **Normal-pages** definition,
including effective inherited definitions. They do not inspect first-page
or even-page definitions or verify rendered visibility, numbering or sequence.
A resolved PAGE field satisfies the Page Number requirement; typed digits
and total-page fields do not. Missing/empty definitions and insufficient
supported evidence produce **Manual review** findings with no score deduction.
When the section's first rendered page can be proven, selecting a review
opens that page with **Page-level structural evidence**, but no exact
Header/Footer highlight or rectangle. Otherwise, **Structural evidence only**
shows **Rendered page could not be determined** and preserves the current
preview page. Corrections remain manual in Word; Local AI and Guided Fixes
are unavailable for these findings.
History and PDF reports retain the settings and findings saved with the audit.

### Optional Reference DOI presentation check

Custom Profiles can enable **Check Reference DOI format**; it is Off by default
and Built-in Profiles remain unchanged. When enabled, the selected profile requires
the visible format `https://doi.org/<doi>`. ACA reports only definite legacy
presentations such as `doi:` or `http://doi.org/`, once per affected Reference entry.

This offline check uses an ACA-supported conservative lexical subset, not complete
DOI syntax or APA 7 validation. Canonical, absent, ambiguous, unsupported and
multiple-candidate text stays silent; hidden hyperlink targets are ignored.
ACA does not verify DOI registration or resolution, require a DOI, rewrite the
document, or offer an automatic correction. Current values retain source spelling.


## Optional Features

Two optional components extend ACA, but neither is required:

- **LibreOffice** enables rendered-page previews and original-document page locations. Without it, extracted-text evidence remains available.
- **Ollama** enables optional **Local AI Citation Guidance** — suggestions for APA 7 in-text citation formatting only. It is never a full academic review, never rewrites or corrects your DOCX, and every suggestion needs your own review.

Core deterministic audits — document checks, formatting findings, rendered-page previews, Guided Fixes, PDF report export, and Audit History — remain available without either component. When an optional component is missing, setup actions appear in the Dashboard's **System Readiness** card. ACA never installs third-party software; the only download it can start is the optional citation-guidance model, after you explicitly confirm it.

## Documentation

**User documentation**

- [Installation](docs/INSTALLATION.md)
- [User Guide](docs/USER_GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Privacy](docs/PRIVACY.md)
- [Known Limitations](docs/KNOWN_LIMITATIONS.md)

**Developer documentation**

- [Developer Setup](docs/developer/DEVELOPER_SETUP.md)
- [Build and Release](docs/developer/BUILD_AND_RELEASE.md)
- [Technical Troubleshooting](docs/developer/TECHNICAL_TROUBLESHOOTING.md)

**Evaluation documentation** (for the project owner and evaluators)

- [Release Checklist](docs/evaluation/RELEASE_CHECKLIST.md)
- [End-User Installation Test](docs/evaluation/END_USER_INSTALLATION_TEST.md)

**Other**

- [Third-Party Notices](THIRD_PARTY_NOTICES.md)

## License Status

No project software license has been selected. ACA remains All rights reserved.
