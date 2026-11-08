# Build and Release — Academic Compliance Auditor

This guide is for release maintainers producing the packaged Windows release. It is not relevant to ordinary end users (see [Installation](../INSTALLATION.md)) or developers running from source (see [Developer Setup](DEVELOPER_SETUP.md)).

The complete build is driven by two repository scripts. Do not invoke PyInstaller or ISCC directly.

## Reproducible Dependency and Toolchain Contract (Wave 5)

Wave 5 establishes immutable, hash-locked dependency inputs and frozen toolchain specifications for release builds.

### Dependency Source of Truth and Lockfiles

1. **Direct runtime source of truth**: `backend/requirements.txt` contains the authoritative direct runtime dependencies pinned with exact versions (`==`). It contains no transitive dependencies or hashes.
2. **Derived runtime lock**: `backend/requirements-lock.txt` is the derived, complete, transitive runtime lockfile containing exact package versions and distribution SHA-256 hashes.
3. **Model B1 dev/build lock**: `backend/requirements-dev.txt` is a self-contained runtime plus development/build lock with exact versions and SHA-256 hashes. It contains no unhashed transitive dependencies and no nested `-r` inclusion.

### Approved Release Toolchain

Release candidate builds require the frozen toolchain below:

| Component | Exact RC Pin | Role / Source |
|---|---|---|
| **Python** | `CPython 3.12.10` (Windows x64) | Packaging runtime and resolver interpreter |
| **pip** | `25.0.1` | Package installer enforcing `--require-hashes` |
| **pip-tools** | `7.6.2` | Resolver generating deterministic locks |
| **PyInstaller** | `6.22.2` | Windows one-folder bundler |
| **pytest** | `8.4.2` | Backend test runner |
| **pytest-asyncio** | `0.23.8` | Async test plugin |
| **Inno Setup** | `6.7.3` | Windows installer compiler (`ISCC.exe`) |
| **Node.js** | `24.11.1` (x64) | Frontend build runtime (advisory engines: `^22.13.0 \|\| ^24.0.0`) |
| **npm** | `11.6.2` | Frontend package manager (advisory engines: `>=10.0.0`) |

*Note on frontend engines*: `frontend/package.json` declares advisory engine ranges (`^22.13.0 || ^24.0.0`, npm `>=10.0.0`) for broad developer compatibility. This advisory declaration must not be confused with the exact immutable toolchain frozen for release builds (`Node 24.11.1`, `npm 11.6.2`).

### Lockfile Generation Contract

Lockfiles must be generated and regenerated on native Windows x64 under the approved CPython 3.12.10 interpreter using:

```powershell
# 1. Runtime lock (backend/requirements-lock.txt)
pip-compile --generate-hashes --allow-unsafe --pip-args "--cache-dir <task-owned-cache>" --output-file backend/requirements-lock.txt backend/requirements.txt

# 2. Model B1 dev/build lock (backend/requirements-dev.txt)
pip-compile --generate-hashes --allow-unsafe --pip-args "--cache-dir <task-owned-cache>" --output-file backend/requirements-dev.txt <combined-input.txt>
```

- **Rationale for `--allow-unsafe`**: PyInstaller 6.22.2 wheel metadata requires `setuptools>=42.0.0`. By default, pip-tools excludes setuptools as an unsafe package. The `--allow-unsafe` flag is required so pip-compile pins `setuptools==84.2.1` with explicit SHA-256 hashes, preventing `--require-hashes` failures during build.
- **Two-run byte-identity rule**: Any newly generated lock must be regenerated independently twice in clean resolver virtual environments. Both runs must produce bit-for-bit identical outputs.
- **Binary-wheel-only policy**: All packages in the lockfile must resolve to binary wheels for Windows x64 or pure-Python wheels (`--only-binary=:all:`). Compiling source distributions (`sdist`) during packaging is prohibited.
- **No uncontrolled pip freeze**: Uncontrolled developer environment freezes are strictly rejected.

### Packaging Virtual Environment Enforcement

Packaging scripts enforce strict dependency integrity inside `backend/.venv`:

```powershell
pip install --require-hashes --only-binary=:all: -r backend/requirements-lock.txt
pip install --require-hashes --only-binary=:all: -r backend/requirements-dev.txt
```

- Build scripts fail closed immediately if `requirements-lock.txt` is missing. Fallback to unlocked `requirements.txt` is strictly prohibited.
- A mandatory post-installation `pip check` verifies that no dependencies are broken or missing.
- Rejection of unhashed packages, editable installs, VCS URLs, and local directory wheels is enforced by `--require-hashes`.

## Controlled runtime build

The runtime is a PyInstaller **one-folder** build: a launcher (`run-frozen.exe`) plus an `_internal` directory containing the Python runtime, dependencies, bundled frontend, and Alembic scripts. The one-folder output is an intermediate build artifact — the **main user delivery is the Setup EXE**, which packages the whole folder.

Build with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/build-packaging-poc.ps1
```

Strict environment requirements (verified before any build output is touched):

- **Python 3.12.10** from the repository-controlled `backend/.venv` only — never a global Python, never a PATH-resolved PyInstaller, never Python 3.13.
- **PyInstaller 6.22.2** exactly, pinned by `backend/requirements-dev.txt`.
- **Lockfile enforcement**: `backend/requirements-lock.txt` present and verified with `pip check`.

The script then:

1. Rebuilds the frontend (`npm ci` + `npm run build`) — always fresh using approved Node/npm toolchain.
2. Verifies required route markers in the bundle (`/dashboard`, `/history`, `/profiles/custom`, `System readiness`) and bundle staleness against source timestamps.
3. Runs PyInstaller via `backend/.venv/Scripts/python.exe -m PyInstaller ACA.spec` — no PATH fallback.
4. **Contamination guard:** rejects the bundle if any prohibited package (`numpy`, `pandas`, `scipy`, `matplotlib`, `pyarrow`, `ollama`) appears in `_internal` or the PyInstaller TOC files.
5. **Size guard:** rejects the bundle above the 250 MB ceiling (a clean Python 3.12 build is ~189 MB; >250 MB indicates dependency contamination).
6. Runs smoke tests on the generated bundle (launches launcher, tests HTTP routes, stops cleanly).
7. Verifies third-party licenses and generates `release-output/input-manifest.json`.

## Windows installer compilation

The installer is compiled with **Inno Setup 6.7.3** using:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

The script:

1. Locates `ISCC.exe` safely (PATH, `%LOCALAPPDATA%\Programs\Inno Setup*`, Program Files) and verifies the installed version against the pinned `6.7.3` (via the uninstall registry entry, because `ISCC.exe` carries no file-version resource).
2. Verifies the controlled Python 3.12.10 venv, lockfile enforcement, and PyInstaller pin, then validates (or builds) the clean one-folder runtime with the contamination and size guards.
3. Verifies the runtime source tree (`run-frozen.exe` + full `_internal` incl. `frontend-dist/index.html`) and that the `.iss` packages the whole tree (`run-frozen\*`).
4. Compiles `installer/AcademicComplianceAuditor.iss` with `/DAppVersion=1.0.0`.
5. Validates the output: non-zero size, PE `MZ` header, required runtime files present in the source tree.
6. Computes and prints the SHA-256 and writes the installer to `release-output/AcademicComplianceAuditor-Setup-1.0.0.exe`.

Installer contract tests live in `installer/installer-contract-tests.ps1`; packaging contract tests in `backend/tests/test_packaging_contract.py`.

## Checksum generation

The build script prints the SHA-256 of the produced installer. To regenerate or share it:

```powershell
Get-FileHash release-output/AcademicComplianceAuditor-Setup-1.0.0.exe -Algorithm SHA256
```

**Every rebuild produces a new checksum.** Never hard-code a checksum into documentation; distribute it only alongside the specific installer build it covers (see [Installation](../INSTALLATION.md) for the user-facing verification steps).

## Release Governance and Residual Disclosures

- `release-output/` is **gitignored**. The Setup EXE is never committed to the repository.
- Official installer artifacts may be provided through an authorized release channel **for controlled release-candidate validation only**. Public distribution of an unsigned installer is **not** authorized: code signing is required before any public distribution.
- **Code signing is not applied to release-candidate builds.** An unsigned build is not public-release ready and must not be described as one; a signed build is required before any public distribution. Windows may display an *Unknown publisher* or Microsoft Defender SmartScreen warning on user machines — state this honestly in every release communication.
- **Row 18 remains BLOCKED**: Under Owner decision D-08 Option 1, database schema upgrades are proven via test fixtures (`pre_migration_v0_db.sqlite`), but no historical prior installer binary exists to anchor an executable-level upgrade test. Acceptance matrix Row 18 remains BLOCKED; installer-to-installer upgrade acceptance is not claimed.
- **Residual limitations**:
  - `package_index_availability: EXTERNAL_RESIDUAL` (installation relies on package index availability; offline rebuild is not claimed).
  - `bit_for_bit_binary_reproducibility: NOT_PROVEN` (Wave 5 guarantees reproducible input dependencies; bit-for-bit binary reproduction of PyInstaller and Inno Setup outputs is not claimed or proven).
  - Actual RC execution, installer testing, and acceptance evidence remain Wave 6 work.
