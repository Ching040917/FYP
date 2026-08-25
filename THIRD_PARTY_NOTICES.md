# Third-Party Notices — Academic Compliance Auditor

## 1. Purpose and scope

This document identifies third-party software and assets redistributed inside the Academic Compliance Auditor (ACA) Windows package, together with their verified licenses. It is generated from the **Python 3.12 clean-environment build** (Python 3.12.10) and the locked Frontend dependency set.

This document:

- records third-party rights only;
- does **not** grant any license to ACA source code;
- does **not** grant a license to ACA itself (see Section 2).

Versions were verified against:

- `backend/requirements.txt` (exact pins);
- the clean Python 3.12 virtual environment installed from those pins;
- `frontend/package-lock.json` (exact locked versions);
- license files shipped inside the clean frozen one-folder bundle.

Packages from the older Python 3.13 global environment (for example pandas, scipy, pyarrow, matplotlib, numpy) were **not** present in the clean bundle and are not listed as bundled.

## 2. ACA license status

**No project software license has been selected. ACA remains all rights reserved.**

- This document records third-party rights only.
- It does not grant a license to ACA source code.
- Public redistribution remains blocked pending the owner's license decision.

## 3. Bundled Backend dependencies

All versions below are the exact declared pins from `backend/requirements.txt` and were installed at those exact versions in the clean Python 3.12 environment. `direct` means declared in `backend/requirements.txt`; `transitive` means installed to satisfy a direct dependency. `bundled` means collected into the frozen one-folder output (verified via the clean-build `PYZ-00.toc`, `COLLECT-00.toc`, and `_internal`).

### Direct dependencies

| Package | Version | Type | Bundled | Purpose in ACA | License | Evidence |
|---|---|---|---|---|---|---|
| FastAPI | 0.110.1 | direct | yes | HTTP framework | MIT | `fastapi-0.110.1.dist-info/licenses/LICENSE` |
| Uvicorn | 0.29.0 | direct | yes | ASGI server | BSD-3-Clause | `uvicorn-0.29.0.dist-info/licenses/LICENSE.md` |
| SQLAlchemy | 2.0.23 | direct | yes | ORM / database | MIT | `sqlalchemy-2.0.23.dist-info/licenses/LICENSE` |
| Alembic | 1.11.1 | direct | yes | database migrations | MIT | `alembic-1.11.1.dist-info/licenses/LICENSE` |
| Pydantic | 2.7.1 | direct | yes | data validation | MIT | `pydantic-2.7.1.dist-info/licenses/LICENSE` |
| pydantic-settings | 2.3.3 | direct | yes | settings loading | MIT | `pydantic_settings-2.3.3.dist-info/licenses/LICENSE` |
| python-docx | 1.1.0 | direct | yes | DOCX parsing | MIT | `python_docx-1.1.0.dist-info/LICENSE` |
| python-multipart | 0.0.6 | direct | yes | multipart uploads | Apache-2.0 | `python_multipart-0.0.6.dist-info/licenses/LICENSE.txt` |
| httpx | 0.27.2 | direct | yes | async HTTP client (Ollama/readiness) | BSD-3-Clause | `httpx-0.27.2.dist-info/licenses/LICENSE.md` |
| Google Generative AI SDK | 0.7.2 | direct | yes | Cloud AI provider client | Apache-2.0 | `google_generativeai-0.7.2.dist-info/LICENSE` |
| python-dotenv | 1.0.1 | direct | yes | `.env` loading | BSD-3-Clause | `python_dotenv-1.0.1.dist-info/LICENSE` |
| ReportLab | 4.0.7 | direct | yes | PDF report generation | BSD | `reportlab-4.0.7.dist-info/LICENSE` |
| pypdf | 6.16.1 | direct | yes | PDF parsing (page counts) | BSD-3-Clause | `pypdf-6.16.1.dist-info/licenses/LICENSE` |

> **Ollama integration note:** Ollama is accessed via direct HTTP (`httpx` to `/api/tags` and `/api/generate`); no Python `ollama` client package is required and none is bundled.

### Verified transitive dependencies (bundled)

The following transitive runtime dependencies are collected in the clean frozen bundle. Versions are the exact clean-environment installed versions.

| Package | Version | License | Bundled evidence |
|---|---|---|---|
| annotated-types | 0.8.0 | MIT | PYZ |
| anyio | 4.14.2 | MIT | PYZ |
| certifi | 2026.07.22 | MPL-2.0 | PYZ + `_internal/certifi` |
| cffi | 2.1.1 | MIT | PYZ |
| charset-normalizer | 3.5.1 | MIT | PYZ + `_internal/charset_normalizer` |
| click | 8.4.2 | BSD-3-Clause | `_internal/click-8.4.2.dist-info` |
| colorama | 0.4.6 | BSD-3-Clause | PYZ |
| cryptography | 50.0.0 | Apache-2.0 / BSD | `_internal/cryptography-50.0.0.dist-info` |
| google-ai-generativelanguage | 0.6.6 | Apache-2.0 | PYZ |
| google-api-core | 2.30.3 | Apache-2.0 | `_internal/google_api_core-2.30.3.dist-info` |
| google-api-python-client | 2.199.0 | Apache-2.0 | `_internal/google_api_python_client-2.199.0.dist-info` |
| google-auth | 2.56.3 | Apache-2.0 | PYZ |
| google-auth-httplib2 | 0.4.1 | Apache-2.0 | PYZ |
| googleapis-common-protos | 1.75.0 | Apache-2.0 | PYZ |
| greenlet | 3.5.5 | MIT | `_internal/greenlet` |
| grpcio | 1.83.0 | Apache-2.0 | `_internal/grpc` |
| grpcio-status | 1.62.3 | Apache-2.0 | PYZ |
| h11 | 0.16.0 | MIT | PYZ |
| httpcore | 1.0.9 | BSD-3-Clause | PYZ |
| httplib2 | 0.32.0 | MIT | `_internal/httplib2` |
| httptools | 0.8.0 | MIT | `_internal/httptools` |
| idna | 3.19 | BSD-3-Clause | PYZ |
| lxml | 6.1.2 | BSD-3-Clause | `_internal/lxml` |
| Mako | 1.4.1 | MIT | PYZ |
| MarkupSafe | 3.0.3 | BSD-3-Clause | `_internal/markupsafe-3.0.3.dist-info` |
| Pillow | 12.3.0 | HPND / PIL | `_internal/PIL` |
| proto-plus | 1.28.2 | Apache-2.0 | PYZ |
| protobuf | 4.25.9 | BSD-3-Clause | PYZ |
| pyasn1 | 0.6.4 | BSD-2-Clause | PYZ |
| pyasn1-modules | 0.4.2 | BSD-2-Clause | PYZ |
| pycparser | 3.0 | BSD-3-Clause | PYZ |
| pydantic-core | 2.18.2 | MIT | `_internal/pydantic_core` |
| Pygments | 2.21.0 | BSD-2-Clause | PYZ |
| pyparsing | 3.3.2 | MIT | PYZ |
| PyYAML | 6.0.3 | MIT | `_internal/yaml` |
| requests | 2.34.2 | Apache-2.0 | PYZ |
| sniffio | 1.3.1 | MIT + Apache-2.0 | PYZ |
| starlette | 0.37.2 | BSD-3-Clause | PYZ |
| tqdm | 4.70.0 | MPL-2.0 | `_internal/tqdm-4.70.0.dist-info` |
| typing_extensions | 4.16.0 | PSF | PYZ |
| uritemplate | 4.2.0 | BSD-3-Clause | PYZ |
| urllib3 | 2.7.0 | MIT | PYZ |
| watchfiles | 1.2.0 | MIT | `_internal/watchfiles` |
| websockets | 17.0.1 | BSD-3-Clause | `_internal/websockets-17.0.1.dist-info` |

Not bundled in the clean build (verified absent): pandas, scipy, pyarrow, matplotlib, numpy, tzdata.

## 4. Bundled Frontend dependencies and assets

Versions are the exact locked versions from `frontend/package-lock.json`. All are bundled inside the production `frontend-dist` assets shipped in the frozen package.

| Package | Locked version | License | Purpose |
|---|---|---|---|
| React | 18.3.1 | MIT | UI library |
| React DOM | 18.3.1 | MIT | DOM rendering |
| React Router DOM | 6.30.4 | MIT | routing |
| @radix-ui/react-label | 2.1.10 | MIT | accessible label |
| @radix-ui/react-scroll-area | 1.2.12 | MIT | scroll area |
| @radix-ui/react-select | 2.3.1 | MIT | select control |
| @radix-ui/react-slot | 1.3.0 | MIT | slot pattern |
| @radix-ui/react-switch | 1.3.1 | MIT | toggle |
| lucide-react | 0.303.0 | ISC (Feather-derived MIT portions) | icons |
| pdfjs-dist | 5.7.284 | Apache-2.0 | PDF rendering/worker |
| class-variance-authority | 0.7.1 | Apache-2.0 | styling variants |
| clsx | 2.1.1 | MIT | className helper |
| tailwind-merge | 3.6.0 | MIT | Tailwind class merging |
| tailwindcss-animate | 1.0.7 | MIT | animation utilities |

### Build-only tools (not shipped at runtime)

For transparency only. These are not redistributed inside the package.

| Package | Locked version | License | Purpose |
|---|---|---|---|
| Vite | 5.x | MIT | build tool |
| TypeScript | 5.x | Apache-2.0 | type-checking |
| @vitejs/plugin-react | 4.x | MIT | React plugin |
| Tailwind CSS | 3.4.x | MIT | styling |
| autoprefixer | 10.x | MIT | CSS prefixing |
| postcss | 8.x | MIT | CSS processor |
| @types/react / @types/react-dom | 18.x | MIT | type definitions |

## 5. PDF.js

- `pdfjs-dist` **5.7.284**, Apache-2.0.
- Bundled worker asset: `frontend-dist/assets/pdf.worker.min-iDqQPrd3.mjs` (verified present, 1,232,303 bytes).
- The bundled worker file preserves the embedded Apache License 2.0 header and Mozilla Foundation copyright (verified in the packaged asset).
- Full Apache-2.0 text: see `licenses/apache-2.0.txt`.

## 6. Icons and derived assets

Lucide icons are redistributed inside the bundled JavaScript as SVG components.

- **Lucide** (lucide-react 0.303.0): **ISC License**.
- **Feather-derived icon portions**: MIT License, copyright held by Cole Bemis 2013–2022.
- Both notices must be preserved in redistributed copies. Exact notice text is reproduced in `licenses/lucide-react-ISC.txt` and `licenses/mit.txt`.

Lucide is **not** classified as IPL. The verified installed license file is the source of truth.

## 7. Sample-document provenance

`frontend/public/samples/sample-thesis.docx` is a **project-created synthetic sample**:

- Introduced in project Git history (commit `e31ae53`, message `v1`, by the project author).
- DOCX metadata (`docProps/core.xml`) reports `creator=python-docx` and `description="generated by python-docx"` — consistent with synthetic project-generated content.
- The sample is bundled under `frontend-dist/samples/sample-thesis.docx`.

The sample remains governed by ACA's project distribution terms. No third-party permission is claimed.

## 8. PyInstaller runtime notice

- **PyInstaller 6.22.2**, used to build the packaged one-folder release.
- License: **GPL-2.0-or-later with a special Bootloader Exception** that permits linking/embedding the compiled bootloader into other programs and distributing those combinations without restriction from the bootloader files.
- The generated ACA executable may therefore be distributed independently, subject to the licenses of the bundled dependencies listed in this document.
- **Using PyInstaller does not force ACA itself to be GPL.** Run-time hooks are licensed under Apache-2.0.
- PyInstaller attribution is not mandatory, but ACA documents the tool for transparency.
- Full text: see `licenses/pyinstaller-COPYING.txt`.

## 9. External optional software (not bundled)

Users obtain these separately under their own terms. None are redistributed by ACA.

| Component | License | Notes |
|---|---|---|
| LibreOffice | MPL-2.0 | required only for rendered-page preview |
| Ollama application | MIT | local AI service |
| qwen3.5:4b model | **Apache-2.0** | external model, not bundled |
| Optional Cloud AI provider (Gemini) | provider terms | user-provided credentials |

ACA never bundles the qwen3.5:4b model, LibreOffice, Ollama, or any Cloud AI provider payload.

## 10. Unresolved or release-blocking items

- **ACA project license is not selected** — public redistribution of the ACA source and package is blocked pending an owner decision. This document does not resolve that.
- Some transitive license identifiers are derived from `dist-info` `License` fields and classifier metadata shipped with the installed packages; full text files were verified for the items where a local file exists. Where a license field was empty, the SPDX identifier was confirmed from the shipped `LICENSE`/`COPYING` file or the package's official metadata.

## 11. Evidence and update policy

- Evidence source: clean Python 3.12.10 environment (`pip freeze`), `PYZ-00.toc` / `COLLECT-00.toc` / `_internal` of the clean one-folder build, `frontend/package-lock.json`, and shipped license files.
- This document must be regenerated whenever `backend/requirements.txt` or `frontend/package-lock.json` changes, or when the packaging toolchain version changes.
- Bundled notices must be kept in sync with the exact release that is distributed.

## License texts

Full unmodified license texts are preserved in the `licenses/` directory:

| File | License | Source |
|---|---|---|
| `licenses/lucide-react-ISC.txt` | ISC (with Feather MIT attribution note) | installed `lucide-react/LICENSE` |
| `licenses/mit.txt` | MIT | installed `sniffio` dist-info `LICENSE.MIT` |
| `licenses/apache-2.0.txt` | Apache License 2.0 | installed `sniffio` dist-info `LICENSE.APACHE2` |
| `licenses/certifi-MPL-2.0.txt` | Mozilla Public License 2.0 | installed `certifi` dist-info `licenses/LICENSE` |
| `licenses/google-generativeai-Apache-2.0.txt` | Apache License 2.0 | installed `google-generativeai` `LICENSE` |
| `licenses/pyinstaller-COPYING.txt` | GPL-2.0-or-later with Bootloader Exception | installed `PyInstaller` `licenses/COPYING.txt` |
