"""Packaging validation helpers (pure Python, testable).

Used by build-packaging-poc.ps1 via the controlled backend/.venv interpreter.
Kept free of third-party imports so tests run in any environment.

Two responsibilities:

1. Bundle guards - contamination and size (the original checks, unchanged).
2. Release input manifest - deterministic provenance over the governed inputs,
   toolchain identity and the produced runtime tree, so an existing runtime is
   never reused on path presence alone.
"""

from __future__ import annotations

import datetime
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

PROHIBITED_PACKAGES = (
    "numpy",
    "pandas",
    "scipy",
    "matplotlib",
    "pyarrow",
    "ollama",
    "googleapiclient",
    "google_generativeai",
)
DEFAULT_MAX_BYTES = 250 * 1024 * 1024  # 250 MB

# Nested package paths the top-level directory rule above cannot see, as
# _internal-relative path segments. The Gemini SDK ships as
# google/generativeai and drags googleapiclient/grpc with it.
_PROHIBITED_NESTED_DIRS = (("google", "generativeai"),)

# Match a directory exactly, a dist-info dir like "numpy-1.26.0.dist-info",
# or a namespace/libs dir like "numpy.libs" — never a longer name that merely
# contains the token (e.g. "numpycompat").
_PROHIBITED_DIR_RE = re.compile(
    r"^(?P<name>numpy|pandas|scipy|matplotlib|pyarrow|ollama|"
    r"googleapiclient|google_generativeai)"
    r"(?:[.-].*)?$",
    re.IGNORECASE,
)

# A real top-level package appears in TOCs as a quoted module name at the
# START of a dotted chain ("('numpy', ...", "('numpy.core', ...") or as the
# FIRST path segment under site-packages ("site-packages\\numpy\\..."). The
# setuptools shim "setuptools._distutils.compat.numpy" and its path
# "...\\compat\\numpy.py" are NOT the numpy package and must not match.
# "google.generativeai" is listed as a full dotted name because its first
# segment ("google") is shared with unrelated Google packages.
_MODULE_NAME_RE = re.compile(
    r"(?:^|['\"\s\[])(?P<token>google\.generativeai|numpy|pandas|scipy|"
    r"matplotlib|pyarrow|ollama|googleapiclient)"
    r"(?=[.'\"\],])",
)
_SITE_PACKAGES_PATH_RE = re.compile(
    r"site-packages[\\/]+(?P<token>google[\\/]+generativeai|numpy|pandas|scipy|"
    r"matplotlib|pyarrow|ollama|googleapiclient|google_generativeai)"
    r"(?=[\\/.\s'\"])",
)


def _toc_tokens(text):
    for pattern in (_MODULE_NAME_RE, _SITE_PACKAGES_PATH_RE):
        for match in pattern.finditer(text):
            token = match.group("token")
            if token:
                yield token


def find_prohibited_dirs(bundle_root: Path):
    """Return prohibited package directory evidence under ``_internal``."""
    found = []
    internal = bundle_root / "_internal"
    if not internal.is_dir():
        return found
    for entry in internal.iterdir():
        if not entry.is_dir():
            continue
        if _PROHIBITED_DIR_RE.match(entry.name):
            found.append(f"{entry.name} [directory]")
    for parts in _PROHIBITED_NESTED_DIRS:
        if internal.joinpath(*parts).is_dir():
            found.append(f"{'/'.join(parts)} [directory]")
    return found


def find_prohibited_tocs(toc_paths):
    """Return prohibited package evidence from PyInstaller TOC text files."""
    found = []
    for toc in toc_paths:
        try:
            text = toc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for token in _toc_tokens(text):
            found.append(f"{token} [TOC {toc.name}]")
    return found


def bundle_size_report(bundle_root: Path):
    """Return (total_bytes, file_count) for a one-folder bundle."""
    if not bundle_root.is_dir():
        return 0, 0
    files = [p for p in bundle_root.rglob("*") if p.is_file()]
    return sum(p.stat().st_size for p in files), len(files)


def contamination_errors(bundle_root: Path, toc_paths=()):
    """Return a list of contamination errors (empty means clean)."""
    errors = find_prohibited_dirs(bundle_root)
    errors += find_prohibited_tocs(toc_paths)
    return sorted(set(errors))


def size_errors(bundle_root: Path, max_bytes: int = DEFAULT_MAX_BYTES):
    """Return (errors, total_bytes, file_count). ``errors`` empty means within bound."""
    total, count = bundle_size_report(bundle_root)
    errors = []
    if total > max_bytes:
        errors.append(
            f"bundle {total / 1048576:.1f} MB exceeds ceiling {max_bytes / 1048576:.1f} MB"
        )
    return errors, total, count


# ---------------------------------------------------------------------------
# Release input manifest (B-PACK-01)
#
# The manifest is a provenance cache, never an authority: verification always
# recomputes every governed input, the toolchain identity and the runtime tree
# digest from the working tree and the bundle on disk.
# ---------------------------------------------------------------------------

MANIFEST_SCHEMA_VERSION = 1

EXIT_PARITY = 0
EXIT_MANIFEST_MISSING = 20
EXIT_SCHEMA = 21
EXIT_MALFORMED = 22
EXIT_TAMPERED = 23
EXIT_CHANGED = 24
EXIT_MISSING_INPUT = 25
EXIT_ADDED_INPUT = 26
EXIT_TOOLCHAIN = 27
EXIT_RUNTIME = 28
EXIT_UNSAFE_PATH = 29
EXIT_UNSTABLE = 30
EXIT_UNSAFE_MANIFEST = 31

# Packaging hygiene (B-HYGIENE-01). These codes extend, and never reuse, the
# legacy 2/3 contamination-size codes or the B-PACK-01 manifest codes 20-31.
HYGIENE_SCHEMA_VERSION = 1
EXIT_HYGIENE = 32            # prohibited file or directory present
EXIT_INVENTORY = 33          # inventory missing, malformed or failing its own self-digest
EXIT_INVENTORY_STALE = 34    # inventory does not match the current runtime tree
EXIT_HYGIENE_UNSTABLE = 35   # a file changed while the walk hashed it

# Third-party license coverage (B-LIC-03).
# These codes extend, and never reuse, legacy (2, 3), B-PACK-01 (20-31), or B-HYGIENE-01 (32-35).
LICENSES_SCHEMA_VERSION = "1.0.0"
EXIT_LICENSES_OK = 0
EXIT_LICENSES_MISSING = 40
EXIT_LICENSES_MALFORMED = 41
EXIT_LICENSES_HASH_MISMATCH = 42
EXIT_LICENSES_COVERAGE_GAP = 43
EXIT_LICENSES_UNSAFE_PATH = 44
EXIT_LICENSES_STAGING_SOURCE = 45
EXIT_LICENSES_STAGING_MISMATCH = 46
NORMALIZATION_POLICY_CANONICAL = "GIT_BLOB_BYTES_NO_CHECKOUT_TRANSFORM"

REQUIRED_PYTHON_DIRECT_PACKAGES = {
    "alembic": "1.11.1",
    "fastapi": "0.110.1",
    "httpx": "0.27.2",
    "pydantic": "2.7.1",
    "pydantic-settings": "2.3.3",
    "pypdf": "6.16.1",
    "python-docx": "1.1.0",
    "python-dotenv": "1.0.1",
    "python-multipart": "0.0.6",
    "reportlab": "4.0.7",
    "sqlalchemy": "2.0.23",
    "uvicorn": "0.29.0",
}

REQUIRED_PYTHON_TRANSITIVE_PACKAGES = {
    "annotated-types": "0.8.0",
    "anyio": "4.15.1",
    "certifi": "2026.7.22",
    "click": "8.5.0",
    "colorama": "0.4.6",
    "greenlet": "3.5.6",
    "h11": "0.16.0",
    "httpcore": "1.0.9",
    "httptools": "0.9.0",
    "idna": "3.20",
    "lxml": "6.1.3",
    "mako": "1.4.3",
    "markupsafe": "3.0.4",
    "pillow": "12.3.0",
    "pydantic-core": "2.18.2",
    "pygments": "2.21.0",
    "pyyaml": "6.0.3",
    "sniffio": "1.3.1",
    "starlette": "0.37.2",
    "typing-extensions": "4.16.0",
    "watchfiles": "1.3.0",
    "websockets": "17.2",
}

REQUIRED_FRONTEND_DIRECT_PACKAGES = {
    "@radix-ui/react-label": "2.1.10",
    "@radix-ui/react-scroll-area": "1.2.12",
    "@radix-ui/react-select": "2.3.1",
    "@radix-ui/react-slot": "1.3.0",
    "@radix-ui/react-switch": "1.3.1",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "lucide-react": "0.303.0",
    "pdfjs-dist": "5.7.284",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-router-dom": "6.30.4",
    "tailwind-merge": "3.6.0",
    "tailwindcss-animate": "1.0.7",
}

REQUIRED_FRONTEND_TRANSITIVE_PACKAGES = {
    "@floating-ui/core": "1.7.5",
    "@floating-ui/dom": "1.7.6",
    "@floating-ui/react-dom": "2.1.8",
    "@floating-ui/utils": "0.2.11",
    "@radix-ui/number": "1.1.2",
    "@radix-ui/primitive": "1.1.4",
    "@radix-ui/react-arrow": "1.1.10",
    "@radix-ui/react-collection": "1.1.10",
    "@radix-ui/react-compose-refs": "1.1.3",
    "@radix-ui/react-context": "1.1.4",
    "@radix-ui/react-direction": "1.1.2",
    "@radix-ui/react-dismissable-layer": "1.1.13",
    "@radix-ui/react-focus-guards": "1.1.4",
    "@radix-ui/react-focus-scope": "1.1.10",
    "@radix-ui/react-id": "1.1.2",
    "@radix-ui/react-popper": "1.3.1",
    "@radix-ui/react-portal": "1.1.12",
    "@radix-ui/react-presence": "1.1.6",
    "@radix-ui/react-primitive": "2.1.6",
    "@radix-ui/react-use-callback-ref": "1.1.2",
    "@radix-ui/react-use-controllable-state": "1.2.3",
    "@radix-ui/react-use-effect-event": "0.0.3",
    "@radix-ui/react-use-escape-keydown": "1.1.2",
    "@radix-ui/react-use-layout-effect": "1.1.2",
    "@radix-ui/react-use-previous": "1.1.2",
    "@radix-ui/react-use-rect": "1.1.2",
    "@radix-ui/react-use-size": "1.1.2",
    "@radix-ui/react-visually-hidden": "1.2.6",
    "@radix-ui/rect": "1.1.2",
    "@remix-run/router": "1.23.3",
    "aria-hidden": "1.2.6",
    "detect-node-es": "1.1.0",
    "get-nonce": "1.0.1",
    "js-tokens": "4.0.0",
    "loose-envify": "1.4.0",
    "react-remove-scroll": "2.7.2",
    "react-remove-scroll-bar": "2.3.8",
    "react-router": "6.30.4",
    "react-style-singleton": "2.2.3",
    "scheduler": "0.23.2",
    "tslib": "2.8.1",
    "use-callback-ref": "1.3.3",
    "use-sidecar": "1.1.3",
}

REQUIRED_PACKAGING_COMPONENTS = {
    "pyinstaller-bootloader": "6.22.2",
}

TOTAL_DELIVERED_COMPONENTS = (
    len(REQUIRED_PYTHON_DIRECT_PACKAGES)
    + len(REQUIRED_PYTHON_TRANSITIVE_PACKAGES)
    + len(REQUIRED_FRONTEND_DIRECT_PACKAGES)
    + len(REQUIRED_FRONTEND_TRANSITIVE_PACKAGES)
    + len(REQUIRED_PACKAGING_COMPONENTS)
)
EXCLUDED_BUILD_PACKAGES = (
    "altgraph", "iniconfig", "packaging", "pefile", "pip", "pluggy",
    "pyinstaller", "pyinstaller-hooks-contrib", "pytest", "pytest-asyncio",
    "pywin32-ctypes", "setuptools", "vite", "typescript",
)

# Exact bundle-relative paths that are required product content and must never
# be rejected by a name rule. certifi's CA bundle is the only certificate the
# runtime needs; a broad *.pem allowlist would defeat the point of the rule.
HYGIENE_ALLOWED_PATHS = (
    "_internal/certifi/cacert.pem",
    "run-frozen.exe",
)

# Basename patterns, matched case-insensitively against the file name only.
HYGIENE_PROHIBITED_NAMES = (
    ".env",
    ".env.*",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    "*.pem",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "*.log",
    "*.dmp",
    "*.hprof",
    "*.coverage",
    ".coverage",
    "*.map",
    "*.pyc",
    "*.pyo",
    "*.tmp",
    "*.bak",
    "*.orig",
    "*.rej",
    "*.swp",
    "*~",
    "*.pdb",
    "*.whl",
    "*.msi",
    "*.msix",
    "*.exe",
)

# Directory names, matched case-insensitively against any path segment.
HYGIENE_PROHIBITED_DIRS = (
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "test-results",
    "playwright-report",
    "coverage",
    "htmlcov",
    "evidence",
    ".git",
    ".github",
    ".serena",
    ".opencode",
)
_HYGIENE_DIR_SET = frozenset(name.casefold() for name in HYGIENE_PROHIBITED_DIRS)
_HYGIENE_ALLOWED = frozenset(path.casefold() for path in HYGIENE_ALLOWED_PATHS)

INVENTORY_GENERATOR = "backend/scripts/packaging_checks.py"

MANIFEST_GENERATOR = "backend/scripts/packaging_checks.py"

_VENV_PYTHON_REL = "backend/.venv/Scripts/python.exe"
_VENV_SITE_PACKAGES_REL = "backend/.venv/Lib/site-packages"

# Directory names never walked while collecting governed inputs: build output,
# caches, vendored environments and VCS metadata.
_GOVERNED_PRUNE = frozenset(
    {".git", ".venv", "build", "dist", ".pytest_cache", "__pycache__", "node_modules"}
)

# Governed directory trees, in collection order. Alembic comes first so its
# files keep the backend-alembic category instead of the generic backend one.
_GOVERNED_TREES = (
    ("backend/alembic", "backend-alembic", True),
    ("frontend/src", "frontend-source", True),
    ("frontend/dist", "frontend-dist", True),
)

# The only governed tree that is filtered by suffix: every other tree
# contributes all of its files.
_PYTHON_ONLY_TREES = ("backend",)

# Individual governed files. All are required: a governed input that cannot be
# hashed means the tree is not reviewable, so generation fails closed.
_GOVERNED_EXPLICIT = (
    ("backend/alembic.ini", "backend"),
    ("backend/ACA.spec", "backend"),
    ("backend/requirements.txt", "backend"),
    ("backend/requirements-dev.txt", "backend"),
    ("frontend/index.html", "frontend-source"),
    ("frontend/vite.config.ts", "frontend-source"),
    ("frontend/tailwind.config.js", "frontend-source"),
    ("frontend/postcss.config.js", "frontend-source"),
    ("frontend/tsconfig.json", "frontend-source"),
    ("frontend/tsconfig.node.json", "frontend-source"),
    ("frontend/package.json", "frontend-source"),
    ("frontend/package-lock.json", "frontend-source"),
    ("frontend/public/samples/sample-thesis.docx", "sample"),
    ("assets/branding/aca-icon.ico", "assets"),
    ("assets/branding/aca-icon-wizard.bmp", "assets"),
    ("assets/branding/aca-icon-source.png", "assets"),
    ("installer/AcademicComplianceAuditor.iss", "packaging"),
    ("scripts/build-installer.ps1", "packaging"),
    ("backend/scripts/build-packaging-poc.ps1", "packaging"),
    ("backend/scripts/packaging_checks.py", "packaging"),
)

# Licensing inputs are hashed only once they exist: B-LIC-01 creates LICENSE and
# B-LIC-03/B-LIC-04 reconcile the license texts. Their later appearance changes
# the manifest content and therefore forces a rebuild instead of a silent reuse.
_GOVERNED_CONDITIONAL_FILES = (
    ("THIRD_PARTY_NOTICES.md", "licensing"),
    ("LICENSE", "licensing"),
)
_GOVERNED_CONDITIONAL_TREES = (("licenses", "licensing"),)

_DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")


class ManifestProblem(Exception):
    """A provenance failure carrying the contract exit code and a safe detail."""

    def __init__(self, code: int, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _normalise_rel(rel: str) -> str:
    """Normalise to NFC, POSIX separators, and no leading "./"."""
    value = str(rel).replace("\\", "/")
    value = unicodedata.normalize("NFC", value)
    while value.startswith("./"):
        value = value[2:]
    return value


def _unsafe_path_reason(rel: str) -> str | None:
    """Return why a manifest path is unsafe, or None when it is acceptable."""
    if not rel:
        return "empty path"
    if rel.startswith("//"):
        return "UNC path"
    if rel.startswith("/"):
        return "absolute path"
    if _DRIVE_PREFIX_RE.match(rel):
        return "drive prefix"
    if ":" in rel:
        return "colon in path (drive letter or alternate data stream)"
    if "\\" in rel:
        return "backslash separator"
    for segment in rel.split("/"):
        if segment in ("", ".", ".."):
            return "unsafe segment"
    return None


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iter_tree(root: Path):
    """Yield files under ``root`` in deterministic order, pruning build output."""
    if not root.is_dir():
        raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {_normalise_rel(root.name)}")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in _GOVERNED_PRUNE)
        for name in sorted(filenames):
            yield Path(dirpath) / name


def _check_regular(path: Path, repo_root: Path, rel: str, allow_root: Path | None = None) -> None:
    """Reject symlinks, junctions and realpath escapes. Never follow a link."""
    if path.is_symlink():
        raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: symbolic link")
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: junction")
    if not _is_within(path.resolve(), repo_root.resolve()):
        if allow_root is None or not _is_within(path.resolve(), allow_root.resolve()):
            raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: resolves outside the repository")


def _hash_path(
    path: Path,
    repo_root: Path,
    rel: str,
    *,
    unstable_code: int = EXIT_UNSTABLE,
    allow_root: Path | None = None,
) -> tuple[str, int]:
    """Return (sha256, size) for a governed file, rejecting unstable reads.

    ``unstable_code`` lets the inventory callers report 35 while the provenance
    manifest keeps its published 30.
    """
    _check_regular(path, repo_root, rel, allow_root=allow_root)
    try:
        before = path.stat()
    except OSError as exc:
        raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {rel}: {exc.strerror}") from exc
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ManifestProblem(unstable_code, f"UNSTABLE {rel}")
    return digest.hexdigest(), after.st_size


def _is_governed_file(path: Path, repo_root: Path) -> bool:
    """True when ``path`` belongs to the governed input set."""
    try:
        rel = _normalise_rel(path.relative_to(repo_root).as_posix())
    except ValueError:
        return False
    if _unsafe_path_reason(rel) is not None:
        return False
    if rel in {name for name, _ in _GOVERNED_EXPLICIT}:
        return True
    if rel in {name for name, _ in _GOVERNED_CONDITIONAL_FILES}:
        return True
    for root, _ in _GOVERNED_CONDITIONAL_TREES:
        if rel.startswith(root + "/"):
            return True
    for root, _, _ in _GOVERNED_TREES:
        if rel.startswith(root + "/"):
            return True
    if rel.startswith("backend/") and rel.endswith(".py"):
        return not any(part in _GOVERNED_PRUNE for part in rel.split("/")[:-1])
    return False


def _insert_input(rows: dict, path: Path, repo_root: Path, category: str, rel=None, allow_root: Path | None = None) -> None:
    rel = rel or _normalise_rel(path.relative_to(repo_root).as_posix())
    key = rel.casefold()
    if key in rows:
        if rows[key]["path"] != rel:
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST,
                f"UNSAFE duplicate governed path {rel} / {rows[key]['path']}",
            )
        return
    sha256, size = _hash_path(path, repo_root, rel, allow_root=allow_root)
    rows[key] = {"path": rel, "category": category, "sha256": sha256, "size": size}


def collect_inputs(repo_root: Path, license_root: Path | None = None) -> list[dict]:
    """Hash every governed input and return them in deterministic order."""
    repo_root = Path(repo_root)
    rows: dict[str, dict] = {}

    for rel_root, category, _required in _GOVERNED_TREES:
        for path in _iter_tree(repo_root / rel_root):
            _insert_input(rows, path, repo_root, category)

    for rel_root in _PYTHON_ONLY_TREES:
        for path in _iter_tree(repo_root / rel_root):
            if path.suffix != ".py":
                continue
            _insert_input(rows, path, repo_root, "backend")

    for rel, category in _GOVERNED_EXPLICIT:
        path = repo_root / rel
        if not path.is_file():
            raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {rel}")
        _insert_input(rows, path, repo_root, category, rel=rel)

    for rel, category in _GOVERNED_CONDITIONAL_FILES:
        path = repo_root / rel
        if path.is_file():
            _insert_input(rows, path, repo_root, category, rel=rel)

    for rel_root, category in _GOVERNED_CONDITIONAL_TREES:
        if rel_root == "licenses" and license_root is not None:
            lic_base = Path(license_root).resolve()
            staged_pkgs = lic_base / "packages"
            if staged_pkgs.is_dir():
                for path in _iter_tree(staged_pkgs):
                    sub_rel = path.relative_to(staged_pkgs).as_posix()
                    canonical_rel = f"licenses/packages/{sub_rel}"
                    _insert_input(rows, path, repo_root, category, rel=canonical_rel, allow_root=lic_base)
            staged_manifest = staged_pkgs / "MANIFEST.json"
            if staged_manifest.is_file():
                _insert_input(rows, staged_manifest, repo_root, category, rel="licenses/packages/MANIFEST.json", allow_root=lic_base)
        else:
            base = repo_root / rel_root
            if base.is_dir():
                for path in _iter_tree(base):
                    _insert_input(rows, path, repo_root, category)

    return [rows[key] for key in sorted(rows, key=lambda k: (rows[k]["path"].casefold(), rows[k]["path"]))]

def _dist_identity(dist_info: Path) -> tuple[str, str]:
    """Return (name, version) from METADATA, falling back to the directory name."""
    name = version = None
    try:
        with open(dist_info / "METADATA", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.strip():
                    break
                if name is None and line.startswith("Name:"):
                    name = line[len("Name:") :].strip()
                elif version is None and line.startswith("Version:"):
                    version = line[len("Version:") :].strip()
    except OSError:
        pass
    if not name or not version:
        base = dist_info.name[: -len(".dist-info")]
        if "-" in base:
            fallback_name, fallback_version = base.rsplit("-", 1)
            name = name or fallback_name
            version = version or fallback_version
        else:
            name = name or base
            version = version or ""
    return name, version


def _collect_distributions(repo_root: Path) -> list[dict]:
    site_packages = repo_root / _VENV_SITE_PACKAGES_REL
    if not site_packages.is_dir():
        raise ManifestProblem(
            EXIT_MISSING_INPUT, f"MISSING {_VENV_SITE_PACKAGES_REL}"
        )
    rows = []
    seen = set()
    for dist_info in sorted(
        site_packages.glob("*.dist-info"), key=lambda p: (p.name.casefold(), p.name)
    ):
        name, version = _dist_identity(dist_info)
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        rows.append({"name": name, "version": version})
    rows.sort(key=lambda row: (row["name"].casefold(), row["name"]))
    return rows


def collect_toolchain(
    repo_root: Path,
    *,
    python_version=None,
    implementation=None,
    machine=None,
    system=None,
):
    """Collect the toolchain identity that produced (or must produce) the bundle."""
    repo_root = Path(repo_root)
    python_path = repo_root / _VENV_PYTHON_REL
    if not python_path.is_file():
        raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {_VENV_PYTHON_REL}")
    python_sha256, _ = _hash_path(python_path, repo_root, _VENV_PYTHON_REL)
    distributions = _collect_distributions(repo_root)
    pyinstaller_version = next(
        (row["version"] for row in distributions if row["name"].casefold() == "pyinstaller"),
        None,
    )
    import platform as _platform

    return {
        "python_sha256": python_sha256,
        "python_version": python_version if python_version is not None else sys.version,
        "implementation": implementation
        if implementation is not None
        else sys.implementation.name,
        "machine": machine if machine is not None else _platform.machine(),
        "system": system if system is not None else _platform.system(),
        "pyinstaller_version": pyinstaller_version,
        "distributions": distributions,
    }


def _bundle_rows(
    bundle_root: Path,
    *,
    unstable_code: int = EXIT_UNSTABLE,
) -> list[dict]:
    """Return deterministic [{path, size, sha256}] rows for every bundle file.

    ``unstable_code`` is forwarded to :func:`_hash_path`; the default keeps the
    published B-PACK-01 behaviour (exit 30) for the provenance manifest.
    """
    bundle_root = Path(bundle_root)
    if not bundle_root.is_dir():
        raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {bundle_root.name}/")

    rows = []
    seen: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(bundle_root, followlinks=False):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            rel = _normalise_rel(path.relative_to(bundle_root).as_posix())
            reason = _unsafe_path_reason(rel)
            if reason is not None:
                raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE runtime path {rel}: {reason}")
            key = rel.casefold()
            if key in seen:
                raise ManifestProblem(
                    EXIT_UNSAFE_MANIFEST, f"UNSAFE duplicate runtime path {rel} / {seen[key]}"
                )
            seen[key] = rel
            sha256, size = _hash_path(path, bundle_root, rel, unstable_code=unstable_code)
            rows.append({"path": rel, "size": size, "sha256": sha256})

    rows.sort(key=lambda row: (row["path"].casefold(), row["path"]))
    return rows


def bundle_tree_digest(bundle_root: Path) -> dict:
    """Return {tree_sha256, file_count, total_bytes} for the runtime tree.

    The digest formula is the published B-PACK-01 one and must not drift:
    sha256 over f"{rel}\\t{sha256}\\n" for rows sorted by (rel.casefold(), rel).
    """
    rows = _bundle_rows(bundle_root)
    tree_digest = hashlib.sha256()
    for row in rows:
        tree_digest.update(f"{row['path']}\t{row['sha256']}\n".encode("utf-8"))
    return {
        "tree_sha256": tree_digest.hexdigest(),
        "file_count": len(rows),
        "total_bytes": sum(row["size"] for row in rows),
    }


def _content_digest(content: dict) -> str:
    serialised = json.dumps(
        content, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    return hashlib.sha256(serialised.encode("utf-8")).hexdigest()


def build_manifest(
    repo_root: Path,
    bundle_root: Path,
    recorded: dict | None = None,
    license_root: Path | None = None,
) -> dict:
    """Build the deterministic manifest content plus non-deterministic metadata."""
    content = {
        "inputs": collect_inputs(repo_root, license_root=license_root),
        "toolchain": collect_toolchain(repo_root),
        "runtime": bundle_tree_digest(bundle_root),
    }
    recorded = dict(recorded or {})
    recorded.setdefault("generated_at_utc", _utc_now())
    recorded.setdefault("generator", MANIFEST_GENERATOR)
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "content": content,
        "content_sha256": _content_digest(content),
        "recorded": recorded,
    }


def write_manifest_atomic(path: Path, manifest: dict) -> None:
    """Write the manifest atomically: temp file, fsync, then os.replace."""
    path = Path(path)
    if path.parent and not path.parent.is_dir():
        path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _validate_content_shape(content: dict) -> None:
    if not isinstance(content, dict):
        raise ManifestProblem(EXIT_MALFORMED, "manifest content is not an object")
    inputs = content.get("inputs")
    toolchain = content.get("toolchain")
    runtime = content.get("runtime")
    if not isinstance(inputs, list) or not isinstance(toolchain, dict) or not isinstance(runtime, dict):
        raise ManifestProblem(EXIT_MALFORMED, "manifest content is missing inputs/toolchain/runtime")
    for row in inputs:
        if not isinstance(row, dict):
            raise ManifestProblem(EXIT_MALFORMED, "manifest input entry is not an object")
        if not isinstance(row.get("path"), str) or not isinstance(row.get("sha256"), str):
            raise ManifestProblem(EXIT_MALFORMED, "manifest input entry lacks path or sha256")
        if not isinstance(row.get("size"), int):
            raise ManifestProblem(EXIT_MALFORMED, "manifest input entry lacks an integer size")
        if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
            raise ManifestProblem(EXIT_MALFORMED, f"manifest input {row['path']} has a non-64-hex sha256")
    if not isinstance(runtime.get("tree_sha256"), str) or not re.fullmatch(
        r"[0-9a-f]{64}", runtime["tree_sha256"]
    ):
        raise ManifestProblem(EXIT_MALFORMED, "manifest runtime tree_sha256 is not 64 lowercase hex")
    if not isinstance(runtime.get("file_count"), int) or not isinstance(runtime.get("total_bytes"), int):
        raise ManifestProblem(EXIT_MALFORMED, "manifest runtime counters are not integers")


def _validate_manifest_paths(inputs: list[dict]) -> None:
    seen: dict[str, str] = {}
    for row in inputs:
        rel = row["path"]
        reason = _unsafe_path_reason(rel)
        if reason is not None:
            raise ManifestProblem(EXIT_UNSAFE_MANIFEST, f"UNSAFE manifest path {rel!r}: {reason}")
        key = _normalise_rel(rel).casefold()
        if key in seen:
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST, f"UNSAFE duplicate manifest path {rel!r} / {seen[key]!r}"
            )
        seen[key] = rel


def load_manifest(path: Path) -> dict:
    """Load and validate a manifest. Never trusts it without recomputation."""
    path = Path(path)
    if not path.is_file():
        raise ManifestProblem(
            EXIT_MANIFEST_MISSING, f"manifest is absent: {_normalise_rel(path.name)}"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ManifestProblem(EXIT_MALFORMED, f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ManifestProblem(EXIT_MALFORMED, "manifest root is not an object")
    schema = data.get("schema_version")
    if schema != MANIFEST_SCHEMA_VERSION:
        raise ManifestProblem(
            EXIT_SCHEMA, f"unsupported manifest schema_version {schema!r} (expected {MANIFEST_SCHEMA_VERSION})"
        )
    content = data.get("content")
    _validate_content_shape(content)
    _validate_manifest_paths(content["inputs"])
    stored = data.get("content_sha256")
    if not isinstance(stored, str) or stored != _content_digest(content):
        raise ManifestProblem(EXIT_TAMPERED, "manifest self-digest does not match its content")
    return data


_TOOLCHAIN_FIELDS = (
    "python_sha256",
    "python_version",
    "implementation",
    "machine",
    "system",
    "pyinstaller_version",
    "distributions",
)


def manifest_problems(
    repo_root: Path,
    bundle_root: Path,
    manifest: dict,
    license_root: Path | None = None,
) -> tuple[int, list[str]]:
    """Compare a loaded manifest against the working tree and the bundle."""
    recorded_content = manifest["content"]
    current = {
        "inputs": collect_inputs(repo_root, license_root=license_root),
        "toolchain": collect_toolchain(repo_root),
        "runtime": bundle_tree_digest(bundle_root),
    }

    recorded_inputs = {row["path"]: row for row in recorded_content["inputs"]}
    current_inputs = {row["path"]: row for row in current["inputs"]}

    changed = []
    missing = []
    for rel in sorted(recorded_inputs, key=lambda p: (p.casefold(), p)):
        row = recorded_inputs[rel]
        now = current_inputs.get(rel)
        if now is None:
            missing.append(rel)
        elif now["sha256"] != row["sha256"] or now["size"] != row["size"]:
            changed.append(rel)

    added = [
        rel
        for rel in sorted(current_inputs, key=lambda p: (p.casefold(), p))
        if rel not in recorded_inputs
    ]

    toolchain_diffs = [
        field
        for field in _TOOLCHAIN_FIELDS
        if recorded_content["toolchain"].get(field) != current["toolchain"].get(field)
    ]
    runtime_differs = recorded_content["runtime"] != current["runtime"]

    if changed:
        return EXIT_CHANGED, [f"CHANGED {rel}" for rel in changed]
    if missing:
        return EXIT_MISSING_INPUT, [f"MISSING {rel}" for rel in missing]
    if added:
        return EXIT_ADDED_INPUT, [f"ADDED {rel}" for rel in added]
    if toolchain_diffs:
        return EXIT_TOOLCHAIN, [f"TOOLCHAIN {field}" for field in toolchain_diffs]
    if runtime_differs:
        return EXIT_RUNTIME, ["RUNTIME tree_sha256 mismatch"]
    return EXIT_PARITY, [
        f"inputs={len(current_inputs)} runtime_files={current['runtime']['file_count']} "
        f"bytes={current['runtime']['total_bytes']}"
    ]


def verify_manifest(
    repo_root: Path,
    bundle_root: Path,
    path: Path,
    license_root: Path | None = None,
) -> tuple[int, list[str]]:
    """Return (exit_code, messages). Exit 0 means parity is proven."""
    try:
        manifest = load_manifest(path)
        return manifest_problems(repo_root, bundle_root, manifest, license_root=license_root)
    except ManifestProblem as exc:
        return exc.code, [exc.detail]


def _trailing_dot_or_space(rel: str) -> bool:
    """True when a name ends in a space or dot (silently stripped by Windows)."""
    name = rel.rsplit("/", 1)[-1]
    return unicodedata.normalize("NFC", name).endswith((" ", "."))


def _hygiene_hit(rel: str) -> str | None:
    """Return the policy rule that prohibits ``rel``, or None when it is clean."""
    name = rel.rsplit("/", 1)[-1].casefold()
    for pattern in HYGIENE_PROHIBITED_NAMES:
        if fnmatch.fnmatchcase(name, pattern):
            return pattern
    for segment in rel.casefold().split("/")[:-1]:
        if segment in _HYGIENE_DIR_SET:
            return f"directory {segment}"
    return None


def _count_files(bundle_root: Path) -> int:
    """Count bundle files without hashing them."""
    total = 0
    for _dirpath, dirnames, filenames in os.walk(bundle_root, followlinks=False):
        dirnames[:] = sorted(dirnames)
        total += len(filenames)
    return total


def sensitive_errors(bundle_root: Path) -> list[str]:
    """Return ['PROHIBITED <rel> [rule]'] for every prohibited bundle entry."""
    bundle_root = Path(bundle_root)
    if not bundle_root.is_dir():
        raise ManifestProblem(EXIT_MISSING_INPUT, f"MISSING {bundle_root.name}/")

    errors: list[str] = []
    for dirpath, dirnames, filenames in os.walk(bundle_root, followlinks=False):
        dirnames[:] = sorted(dirnames)
        for directory in dirnames:
            directory_path = Path(dirpath) / directory
            rel_dir = _normalise_rel(directory_path.relative_to(bundle_root).as_posix())
            if directory_path.is_symlink() or (
                callable(getattr(directory_path, "is_junction", None))
                and directory_path.is_junction()
            ):
                raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel_dir}/: linked directory")
            if directory.casefold() in _HYGIENE_DIR_SET:
                errors.append(f"PROHIBITED {rel_dir}/ [directory {directory.casefold()}]")
        for name in sorted(filenames):
            path = Path(dirpath) / name
            rel = _normalise_rel(path.relative_to(bundle_root).as_posix())
            reason = _unsafe_path_reason(rel)
            if reason is not None:
                raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: {reason}")
            if _trailing_dot_or_space(rel):
                raise ManifestProblem(
                    EXIT_UNSAFE_PATH, f"UNSAFE {rel}: name ends with a space or dot"
                )
            if rel.casefold() in _HYGIENE_ALLOWED:
                continue
            hit = _hygiene_hit(rel)
            if hit is not None:
                errors.append(f"PROHIBITED {rel} [{hit}]")
    return sorted(set(errors))


def inventory_files(bundle_root: Path) -> list[dict]:
    """Rows for every delivered file; refuses a bundle that fails hygiene."""
    errors = sensitive_errors(bundle_root)
    if errors:
        raise ManifestProblem(
            EXIT_HYGIENE,
            f"HYGIENE_FAIL count={len(errors)} first={errors[0]}",
        )
    return _bundle_rows(bundle_root, unstable_code=EXIT_HYGIENE_UNSTABLE)


def _inventory_content(rows: list[dict]) -> dict:
    tree = hashlib.sha256()
    for row in rows:
        tree.update(f"{row['path']}\t{row['sha256']}\n".encode("utf-8"))
    return {
        "schema_version": HYGIENE_SCHEMA_VERSION,
        "bundle_root": ".",
        "files": rows,
        "summary": {
            "file_count": len(rows),
            "total_bytes": sum(row["size"] for row in rows),
            "tree_sha256": tree.hexdigest(),
        },
    }


def build_inventory(
    bundle_root: Path,
    recorded: dict | None = None,
) -> dict:
    """Build the deterministic delivered-file inventory."""
    content = _inventory_content(inventory_files(bundle_root))
    recorded = dict(recorded or {})
    recorded.setdefault("generated_at_utc", _utc_now())
    recorded.setdefault("generator", INVENTORY_GENERATOR)
    document = dict(content)
    document["recorded"] = recorded
    document["content_sha256"] = _content_digest(content)
    return document


def _validate_inventory_shape(data: dict) -> None:
    if not isinstance(data, dict):
        raise ManifestProblem(EXIT_INVENTORY, "inventory root is not an object")
    if data.get("schema_version") != HYGIENE_SCHEMA_VERSION:
        raise ManifestProblem(
            EXIT_INVENTORY,
            f"unsupported inventory schema_version {data.get('schema_version')!r}",
        )
    if data.get("bundle_root") != ".":
        raise ManifestProblem(EXIT_INVENTORY, "inventory bundle_root is not '.'")
    files = data.get("files")
    summary = data.get("summary")
    if not isinstance(files, list) or not isinstance(summary, dict):
        raise ManifestProblem(EXIT_INVENTORY, "inventory is missing files or summary")
    for row in files:
        if not isinstance(row, dict):
            raise ManifestProblem(EXIT_INVENTORY, "inventory file row is not an object")
        if not isinstance(row.get("path"), str) or not isinstance(row.get("sha256"), str):
            raise ManifestProblem(EXIT_INVENTORY, "inventory file row lacks path or sha256")
        if not isinstance(row.get("size"), int):
            raise ManifestProblem(EXIT_INVENTORY, "inventory file row lacks an integer size")
        if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
            raise ManifestProblem(
                EXIT_INVENTORY, f"inventory row {row['path']} has a non-64-hex sha256"
            )
    for field in ("file_count", "total_bytes"):
        if not isinstance(summary.get(field), int):
            raise ManifestProblem(EXIT_INVENTORY, f"inventory summary {field} is not an integer")
    if not isinstance(summary.get("tree_sha256"), str) or not re.fullmatch(
        r"[0-9a-f]{64}", summary["tree_sha256"]
    ):
        raise ManifestProblem(EXIT_INVENTORY, "inventory tree_sha256 is not 64 lowercase hex")


def _validate_inventory_entry_paths(raw_files: object) -> None:
    """Tolerant path-safety pass over whatever path data the inventory exposes.

    This establishes only whether a higher-priority unsafe-path condition exists.
    It never certifies the inventory as valid: absent, non-list or non-object
    entries and non-string paths are skipped and classified later as EXIT_INVENTORY.
    """
    if not isinstance(raw_files, list):
        return
    seen: dict[str, str] = {}
    for row in raw_files:
        if not isinstance(row, dict):
            continue
        rel = row.get("path")
        if not isinstance(rel, str):
            continue
        reason = _unsafe_path_reason(rel)
        if reason is not None:
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST, f"UNSAFE inventory path {rel!r}: {reason}"
            )
        if _trailing_dot_or_space(rel):
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST,
                f"UNSAFE inventory path {rel!r}: name ends with a space or dot",
            )
        key = _normalise_rel(rel).casefold()
        if key in seen:
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST,
                f"UNSAFE duplicate inventory path {rel!r} / {seen[key]!r}",
            )
        seen[key] = rel


def _load_inventory(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise ManifestProblem(
            EXIT_INVENTORY, f"inventory is absent: {_normalise_rel(path.name)}"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ManifestProblem(EXIT_INVENTORY, f"inventory is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ManifestProblem(EXIT_INVENTORY, "inventory root is not an object")
    # Path safety outranks general shape classification when it is provable.
    _validate_inventory_entry_paths(data.get("files"))
    _validate_inventory_shape(data)
    _validate_manifest_paths(data["files"])
    content = {
        "schema_version": data["schema_version"],
        "bundle_root": data["bundle_root"],
        "files": data["files"],
        "summary": data["summary"],
    }
    stored = data.get("content_sha256")
    if not isinstance(stored, str) or stored != _content_digest(content):
        raise ManifestProblem(EXIT_INVENTORY, "inventory self-digest does not match its content")
    return data


def verify_inventory(
    bundle_root: Path,
    path: Path,
) -> tuple[int, list[str]]:
    """Return (exit_code, messages). Exit 0 means the inventory matches the tree."""
    try:
        errors = sensitive_errors(bundle_root)
        if errors:
            return EXIT_HYGIENE, errors + [f"HYGIENE_FAIL count={len(errors)}"]
        # Hash the runtime tree before the inventory is loaded or trusted, so an
        # unstable read (35) outranks any inventory classification (31/33).
        current = _inventory_content(
            _bundle_rows(bundle_root, unstable_code=EXIT_HYGIENE_UNSTABLE)
        )
        recorded = _load_inventory(path)
        recorded_rows = {row["path"]: row for row in recorded["files"]}
        current_rows = {row["path"]: row for row in current["files"]}
        messages: list[str] = []
        for rel in sorted(recorded_rows, key=lambda key: (key.casefold(), key)):
            row = recorded_rows[rel]
            now = current_rows.get(rel)
            if now is None:
                messages.append(f"MISSING {rel}")
            elif now["sha256"] != row["sha256"] or now["size"] != row["size"]:
                messages.append(f"CHANGED {rel}")
        for rel in sorted(current_rows, key=lambda key: (key.casefold(), key)):
            if rel not in recorded_rows:
                messages.append(f"ADDED {rel}")
        if messages:
            return EXIT_INVENTORY_STALE, messages + [f"INVENTORY_NOT_PROVEN code={EXIT_INVENTORY_STALE}"]
        summary = current["summary"]
        return EXIT_PARITY, [
            f"INVENTORY_OK files={summary['file_count']} tree={summary['tree_sha256']}"
        ]
    except ManifestProblem as exc:
        return exc.code, [exc.detail]


def _parse_action_options(argv, known):
    """Minimal ``--flag value`` parser for the hygiene/inventory actions."""
    options = {flag: None for flag in known}
    positional = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in options:
            if index + 1 >= len(argv):
                raise ManifestProblem(EXIT_MALFORMED, f"usage: {token} requires a value")
            options[token] = argv[index + 1]
            index += 2
            continue
        positional.append(token)
        index += 1
    return options, positional


def _inventory_cli(argv) -> int:
    action = argv[0]
    try:
        options, positional = _parse_action_options(argv[1:], ("--output", "--inventory"))
        if len(positional) != 1:
            raise ManifestProblem(
                EXIT_MALFORMED,
                "usage: packaging_checks.py {hygiene | inventory --output P | "
                "verify-inventory --inventory P} <bundle_root>",
            )
        bundle_root = Path(positional[0]).resolve()
        if action == "hygiene":
            errors = sensitive_errors(bundle_root)
            for message in errors:
                print(message)
            if errors:
                print(f"HYGIENE_FAIL count={len(errors)}")
                return EXIT_HYGIENE
            print(f"HYGIENE_OK files={_count_files(bundle_root)}")
            return EXIT_PARITY
        if action == "inventory":
            if not options["--output"]:
                raise ManifestProblem(EXIT_MALFORMED, "usage: inventory requires --output <path>")
            errors = sensitive_errors(bundle_root)
            for message in errors:
                print(message)
            if errors:
                print(f"HYGIENE_FAIL count={len(errors)}")
                return EXIT_HYGIENE
            inventory = build_inventory(bundle_root)
            output = Path(options["--output"])
            write_manifest_atomic(output, inventory)
            print(f"INVENTORY_WRITTEN {_normalise_rel(output.as_posix())}")
            print(f"INVENTORY_FILES {inventory['summary']['file_count']}")
            print(f"INVENTORY_TREE_SHA256 {inventory['summary']['tree_sha256']}")
            return EXIT_PARITY
        if not options["--inventory"]:
            raise ManifestProblem(
                EXIT_MALFORMED, "usage: verify-inventory requires --inventory <path>"
            )
        code, messages = verify_inventory(bundle_root, Path(options["--inventory"]))
        for message in messages:
            print(message)
        if code != EXIT_PARITY:
            print(f"INVENTORY_NOT_PROVEN code={code}")
        return code
    except ManifestProblem as exc:
        print(f"INVENTORY_FAIL code={exc.code} {exc.detail}")
        return exc.code


def _parse_manifest_cli(argv):
    options = {"--output": None, "--manifest": None, "--node-version": None, "--npm-version": None, "--license-root": None}
    positional = []
    index = 1
    while index < len(argv):
        token = argv[index]
        if token in options:
            if index + 1 >= len(argv):
                raise ManifestProblem(EXIT_MALFORMED, f"usage: {token} requires a value")
            options[token] = argv[index + 1]
            index += 2
            continue
        positional.append(token)
        index += 1
    if len(positional) < 2:
        raise ManifestProblem(
            EXIT_MALFORMED,
            "usage: packaging_checks.py {manifest --output PATH | verify-manifest --manifest PATH} "
            "<repo_root> <bundle_root>",
        )
    return options, Path(positional[0]).resolve(), Path(positional[1]).resolve()


def _manifest_cli(argv) -> int:
    action = argv[0]
    try:
        options, repo_root, bundle_root = _parse_manifest_cli(argv)
        if action == "manifest":
            if not options["--output"]:
                raise ManifestProblem(EXIT_MALFORMED, "usage: manifest requires --output <path>")
            recorded = {}
            if options["--node-version"]:
                recorded["node_version"] = options["--node-version"]
            if options["--npm-version"]:
                recorded["npm_version"] = options["--npm-version"]
            license_root = Path(options["--license-root"]).resolve() if options["--license-root"] else None
            manifest = build_manifest(repo_root, bundle_root, recorded, license_root=license_root)
            output = Path(options["--output"])
            write_manifest_atomic(output, manifest)
            content = manifest["content"]
            print(f"MANIFEST_WRITTEN {_normalise_rel(output.as_posix())}")
            print(f"MANIFEST_CONTENT_SHA256 {manifest['content_sha256']}")
            print(f"MANIFEST_INPUTS {len(content['inputs'])}")
            print(
                "MANIFEST_RUNTIME files={} bytes={}".format(
                    content["runtime"]["file_count"], content["runtime"]["total_bytes"]
                )
            )
            return EXIT_PARITY
        if not options["--manifest"]:
            raise ManifestProblem(EXIT_MALFORMED, "usage: verify-manifest requires --manifest <path>")
        license_root = Path(options["--license-root"]).resolve() if options["--license-root"] else None
        code, messages = verify_manifest(repo_root, bundle_root, Path(options["--manifest"]), license_root=license_root)
        for message in messages:
            print(message)
        if code == EXIT_PARITY:
            print("MANIFEST_OK")
        else:
            print(f"MANIFEST_NOT_PROVEN code={code}")
        return code
    except ManifestProblem as exc:
        print(f"MANIFEST_FAIL code={exc.code} {exc.detail}")
        return exc.code


def stage_licenses(repo_root: Path, commit: str, dest: Path) -> tuple[int, list[str]]:
    repo_root = Path(repo_root).resolve()
    dest = Path(dest)

    # 1. Resolve commit
    r_rev = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}"],
        cwd=repo_root, capture_output=True, text=True
    )
    if r_rev.returncode != 0:
        return (EXIT_LICENSES_STAGING_SOURCE, [f"INVALID commit {commit}: {r_rev.stderr.strip()}"])
    commit_sha = r_rev.stdout.strip()

    # 2. Require HEAD == commit_sha (equality, not ancestry!)
    r_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_root, capture_output=True, text=True)
    if r_head.returncode != 0 or r_head.stdout.strip() != commit_sha:
        return (EXIT_LICENSES_STAGING_SOURCE, [f"COMMIT mismatch: HEAD ({r_head.stdout.strip()}) does not match staging commit ({commit_sha})"])

    # 3. Read manifest from git blob at commit
    r_cat = subprocess.run(
        ["git", "cat-file", "blob", f"{commit_sha}:licenses/packages/MANIFEST.json"],
        cwd=repo_root, capture_output=True
    )
    if r_cat.returncode != 0:
        return (EXIT_LICENSES_STAGING_SOURCE, [f"MISSING licenses/packages/MANIFEST.json blob at commit {commit_sha}"])
    manifest_bytes = r_cat.stdout

    # Parse manifest JSON from commit bytes only
    try:
        data = json.loads(manifest_bytes.decode("utf-8"))
    except Exception as exc:
        return (EXIT_LICENSES_MALFORMED, [f"MALFORMED manifest JSON at {commit_sha}: {exc}"])

    if not isinstance(data, dict) or "packages" not in data or not isinstance(data["packages"], list):
        return (EXIT_LICENSES_MALFORMED, ["MALFORMED manifest structure at commit"])

    # 4. Check destination safety
    dest_resolved = dest.resolve()
    if dest.is_symlink() or (hasattr(dest, "is_junction") and dest.is_junction()):
        return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE staging destination: symlink or junction {dest}"])

    # Destination must be fresh and empty if it exists
    if dest.exists() and any(dest.iterdir()):
        return (EXIT_LICENSES_STAGING_SOURCE, [f"STAGING destination must be fresh/empty: {dest}"])

    # 5. Extract files
    dest.mkdir(parents=True, exist_ok=True)
    packages_dir = dest / "packages"
    packages_dir.mkdir(parents=True, exist_ok=True)

    declared_files = set()
    for pkg in data["packages"]:
        pkg_name = pkg.get("package", "unknown")
        for f_entry in pkg.get("files", []):
            rel_path = f_entry.get("path", "").replace("\\", "/")
            if not rel_path.startswith("licenses/packages/"):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE path does not start with licenses/packages/: {rel_path}"])
            if ".." in rel_path or ":" in rel_path or rel_path.startswith("/"):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE path traversal: {rel_path}"])

            # Check Pillow anomaly prohibition
            if rel_path == "licenses/packages/pillow/LICENSE":
                exp_bytes = f_entry.get("bytes")
                exp_sha = f_entry.get("sha256", "").lower()
                if exp_bytes in (78016, 78052) or exp_sha == "4f7866a74802c6326f81faff59a56546b6aec2b10b91973e0e9308de95e79857":
                    return (EXIT_LICENSES_STAGING_MISMATCH, ["ANOMALOUS Pillow license bytes rejected"])

            sub_path = rel_path[len("licenses/"):]  # packages/...
            target_file = dest / sub_path

            # Query git ls-tree to confirm it's a blob
            r_tree = subprocess.run(
                ["git", "ls-tree", commit_sha, rel_path],
                cwd=repo_root, capture_output=True, text=True
            )
            tree_parts = r_tree.stdout.strip().split()
            if len(tree_parts) < 3 or tree_parts[1] != "blob":
                return (EXIT_LICENSES_STAGING_SOURCE, [f"MISSING or invalid Git blob object for {rel_path}"])
            blob_id = tree_parts[2]

            # Fetch blob content
            r_blob = subprocess.run(
                ["git", "cat-file", "blob", blob_id],
                cwd=repo_root, capture_output=True
            )
            if r_blob.returncode != 0:
                return (EXIT_LICENSES_STAGING_SOURCE, [f"FAILED to read blob {blob_id} for {rel_path}"])
            blob_content = r_blob.stdout

            # Atomic write
            target_file.parent.mkdir(parents=True, exist_ok=True)
            tmp_file = target_file.parent / (target_file.name + f".tmp_{os.getpid()}")
            tmp_file.write_bytes(blob_content)

            # Verify temporary file
            st_sz = tmp_file.stat().st_size
            st_sha = hashlib.sha256(blob_content).hexdigest()
            if st_sz != len(blob_content) or st_sha != hashlib.sha256(blob_content).hexdigest():
                tmp_file.unlink(missing_ok=True)
                return (EXIT_LICENSES_STAGING_MISMATCH, [f"PARTIAL write for {rel_path}"])

            # Rename to target
            tmp_file.replace(target_file)
            declared_files.add(rel_path)

    # Write packages/MANIFEST.json from manifest_bytes
    tmp_mf = packages_dir / f"MANIFEST.json.tmp_{os.getpid()}"
    tmp_mf.write_bytes(manifest_bytes)
    tmp_mf.replace(packages_dir / "MANIFEST.json")

    # 6. Post-staging verification
    for root_dir, _, files in os.walk(packages_dir):
        for f in files:
            fp = Path(root_dir) / f
            if fp.is_symlink() or (hasattr(fp, "is_junction") and fp.is_junction()):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE symlink in staged licenses: {fp}"])
            rel_in_repo = "licenses/" + fp.relative_to(dest).as_posix()
            if rel_in_repo == "licenses/packages/MANIFEST.json":
                continue
            if rel_in_repo not in declared_files:
                return (EXIT_LICENSES_STAGING_MISMATCH, [f"EXTRA staged file: {rel_in_repo}"])

    for pkg in data["packages"]:
        for f_entry in pkg.get("files", []):
            rel_path = f_entry["path"].replace("\\", "/")
            sub_path = rel_path[len("licenses/"):]
            staged_fp = dest / sub_path
            if not staged_fp.is_file():
                return (EXIT_LICENSES_STAGING_MISMATCH, [f"MISSING staged file: {sub_path}"])
            sz = staged_fp.stat().st_size
            if sz != f_entry["bytes"]:
                return (EXIT_LICENSES_STAGING_MISMATCH, [f"SIZE mismatch for staged {sub_path}: expected {f_entry['bytes']}, got {sz}"])
            sha = hashlib.sha256(staged_fp.read_bytes()).hexdigest()
            if sha != f_entry["sha256"].lower():
                return (EXIT_LICENSES_STAGING_MISMATCH, [f"SHA256 mismatch for staged {sub_path}: expected {f_entry['sha256']}, got {sha}"])

    return (EXIT_LICENSES_OK, [f"STAGING_OK packages={len(data['packages'])} files={len(declared_files)} commit={commit_sha[:16]}"])


def generate_manifest(repo_root: Path, stage_root: Path, commit: str) -> dict:
    repo_root = Path(repo_root).resolve()
    stage_root = Path(stage_root).resolve()

    r_rev = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}"],
        cwd=repo_root, capture_output=True, text=True
    )
    if r_rev.returncode != 0:
        raise ValueError(f"Invalid commit: {commit}")
    commit_sha = r_rev.stdout.strip()

    r_cat = subprocess.run(
        ["git", "cat-file", "blob", f"{commit_sha}:licenses/packages/MANIFEST.json"],
        cwd=repo_root, capture_output=True
    )
    if r_cat.returncode != 0:
        old_data = json.loads((repo_root / "licenses" / "packages" / "MANIFEST.json").read_text(encoding="utf-8"))
    else:
        old_data = json.loads(r_cat.stdout.decode("utf-8"))

    pkgs_dir = stage_root / "packages" if (stage_root / "packages").is_dir() else stage_root

    new_packages = []
    for pkg in old_data.get("packages", []):
        new_pkg = dict(pkg)
        new_files = []
        for f_entry in pkg.get("files", []):
            rel_path = f_entry["path"].replace("\\", "/")
            sub_rel = rel_path[len("licenses/packages/"):]
            staged_file = pkgs_dir / sub_rel
            if not staged_file.is_file():
                raise FileNotFoundError(f"Missing staged file for manifest generation: {staged_file}")

            staged_bytes = staged_file.stat().st_size
            staged_sha = hashlib.sha256(staged_file.read_bytes()).hexdigest()

            r_tree = subprocess.run(
                ["git", "ls-tree", commit_sha, rel_path],
                cwd=repo_root, capture_output=True, text=True
            )
            parts = r_tree.stdout.strip().split()
            blob_id = parts[2] if len(parts) >= 3 else ""

            new_file = {
                "path": rel_path,
                "sha256": staged_sha,
                "bytes": staged_bytes,
                "source_commit": commit_sha,
                "blob_id": blob_id,
                "staged_path": rel_path[len("licenses/"):],
                "destination": "{app}\\licenses\\packages\\" + sub_rel.replace("/", "\\"),
                "normalization_policy": NORMALIZATION_POLICY_CANONICAL,
                "verification_status": "VERIFIED"
            }
            new_files.append(new_file)
        new_files.sort(key=lambda x: x["path"])
        new_pkg["files"] = new_files
        new_packages.append(new_pkg)

    new_packages.sort(key=lambda p: p["package"])
    return {
        "manifest_version": LICENSES_SCHEMA_VERSION,
        "packages": new_packages
    }


def verify_licenses(repo_root: Path, license_root: Path | None = None) -> tuple[int, list[str]]:
    """Verify that root LICENSE, THIRD_PARTY_NOTICES.md, and licenses/packages/ exist,

    conform to schema, have matching hashes, cover all runtime packages, and are
    referenced by the Inno Setup installer script.
    """
    messages: list[str] = []
    repo = Path(repo_root).resolve()

    # 1. Root LICENSE check
    lic_file = repo / "LICENSE"
    if not lic_file.is_file():
        return (EXIT_LICENSES_MISSING, [f"MISSING {lic_file.name}"])
    if lic_file.stat().st_size == 0:
        return (EXIT_LICENSES_MISSING, [f"EMPTY {lic_file.name}"])

    # 2. THIRD_PARTY_NOTICES.md check
    notices_file = repo / "THIRD_PARTY_NOTICES.md"
    if not notices_file.is_file():
        return (EXIT_LICENSES_MISSING, [f"MISSING {notices_file.name}"])
    if notices_file.stat().st_size == 0:
        return (EXIT_LICENSES_MISSING, [f"EMPTY {notices_file.name}"])

    # 3. Canonical MANIFEST.json check
    if license_root is not None:
        license_tree = Path(license_root).resolve()
        pkgs_dir = license_tree / "packages"
        manifest_path = pkgs_dir / "MANIFEST.json"
    else:
        license_tree = repo / "licenses"
        pkgs_dir = license_tree / "packages"
        manifest_path = pkgs_dir / "MANIFEST.json"

    if not manifest_path.is_file():
        return (EXIT_LICENSES_MISSING, [f"MISSING {manifest_path.name}"])

    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return (EXIT_LICENSES_MALFORMED, [f"MALFORMED JSON in {manifest_path.name}: {exc}"])

    if not isinstance(data, dict):
        return (EXIT_LICENSES_MALFORMED, ["MALFORMED MANIFEST.json: root must be an object"])
    if data.get("manifest_version") != LICENSES_SCHEMA_VERSION:
        return (EXIT_LICENSES_MALFORMED, [f"UNSUPPORTED manifest_version: {data.get('manifest_version')}"])
    if "packages" not in data or not isinstance(data["packages"], list):
        return (EXIT_LICENSES_MALFORMED, ["MALFORMED MANIFEST.json: 'packages' must be a list"])

    seen_packages: set[str] = set()
    manifest_files: set[str] = set()

    for pkg_entry in data["packages"]:
        if not isinstance(pkg_entry, dict):
            return (EXIT_LICENSES_MALFORMED, ["MALFORMED package entry: must be an object"])
        for req_field in ("package", "version", "license", "classification", "delivered", "source", "files"):
            if req_field not in pkg_entry:
                return (EXIT_LICENSES_MALFORMED, [f"MALFORMED package entry missing '{req_field}'"])

        pkg_name = pkg_entry["package"]
        if pkg_name in seen_packages:
            return (EXIT_LICENSES_MALFORMED, [f"DUPLICATE package entry: {pkg_name}"])
        seen_packages.add(pkg_name)

        if not isinstance(pkg_entry["files"], list) or not pkg_entry["files"]:
            return (EXIT_LICENSES_MALFORMED, [f"MALFORMED files list for package {pkg_name}"])

        for f_entry in pkg_entry["files"]:
            if not isinstance(f_entry, dict):
                return (EXIT_LICENSES_MALFORMED, [f"MALFORMED file entry in package {pkg_name}"])
            for f_field in ("path", "sha256", "bytes"):
                if f_field not in f_entry:
                    return (EXIT_LICENSES_MALFORMED, [f"MALFORMED file entry missing '{f_field}' in package {pkg_name}"])

            rel_path = f_entry["path"].replace("\\", "/")
            if not rel_path.startswith("licenses/packages/"):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE path does not start with licenses/packages/: {rel_path}"])
            if ".." in rel_path or ":" in rel_path or rel_path.startswith("/"):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE path traversal: {rel_path}"])

            # Check Pillow anomaly prohibition
            if rel_path == "licenses/packages/pillow/LICENSE":
                exp_bytes = f_entry.get("bytes")
                exp_sha = f_entry.get("sha256", "").lower()
                if exp_bytes in (78016, 78052) or exp_sha == "4f7866a74802c6326f81faff59a56546b6aec2b10b91973e0e9308de95e79857":
                    return (EXIT_LICENSES_HASH_MISMATCH, ["ANOMALOUS Pillow license bytes rejected"])

            # Check normalization policy if present
            norm_policy = f_entry.get("normalization_policy")
            if norm_policy and norm_policy != NORMALIZATION_POLICY_CANONICAL:
                return (EXIT_LICENSES_MALFORMED, [f"UNSUPPORTED normalization_policy: {norm_policy}"])

            if license_root is not None:
                target_file = license_tree / rel_path[len("licenses/"):]
            else:
                target_file = repo / rel_path

            if target_file.is_symlink() or (hasattr(target_file, "is_junction") and target_file.is_junction()):
                return (EXIT_LICENSES_UNSAFE_PATH, [f"UNSAFE symlink in licenses: {rel_path}"])
            if not target_file.is_file():
                return (EXIT_LICENSES_MISSING, [f"MISSING declared license file: {rel_path}"])
            if target_file.stat().st_size == 0:
                return (EXIT_LICENSES_MISSING, [f"EMPTY declared license file: {rel_path}"])

            actual_size = target_file.stat().st_size
            if actual_size != f_entry["bytes"]:
                return (EXIT_LICENSES_HASH_MISMATCH, [f"SIZE mismatch for {rel_path}: expected {f_entry['bytes']}, got {actual_size}"])

            actual_sha = hashlib.sha256(target_file.read_bytes()).hexdigest()
            if actual_sha != f_entry["sha256"].lower():
                return (EXIT_LICENSES_HASH_MISMATCH, [f"SHA256 mismatch for {rel_path}: expected {f_entry['sha256']}, got {actual_sha}"])

            manifest_files.add(rel_path)

    # 4. Check unlisted files beneath packages
    if pkgs_dir.is_dir():
        for root, _, files in os.walk(pkgs_dir):
            for file in files:
                p = Path(root) / file
                if license_root is not None:
                    rel = "licenses/" + p.relative_to(license_tree).as_posix()
                else:
                    rel = str(p.relative_to(repo)).replace("\\", "/")
                if rel == "licenses/packages/MANIFEST.json":
                    continue
                if rel not in manifest_files:
                    return (EXIT_LICENSES_COVERAGE_GAP, [f"UNLISTED file beneath licenses/packages: {rel}"])

    # 5. Check exact-set coverage against required runtime components
    delivered_map = {}
    for pkg_entry in data["packages"]:
        p_name = pkg_entry["package"]
        if pkg_entry.get("delivered", False):
            delivered_map[pkg_entry["package"]] = (pkg_entry.get("version"), pkg_entry.get("classification"))

    for p_name, p_ver in REQUIRED_PYTHON_DIRECT_PACKAGES.items():
        if p_name not in delivered_map:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"MISSING delivered Python direct component: {p_name}"])
        if delivered_map[p_name][0] != p_ver:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for {p_name}: expected {p_ver}, got {delivered_map[p_name][0]}"])
        if delivered_map[p_name][1] != "DIRECT RUNTIME":
            return (EXIT_LICENSES_COVERAGE_GAP, [f"CLASSIFICATION MISMATCH for {p_name}: expected DIRECT RUNTIME, got {delivered_map[p_name][1]}"])

    for p_name, p_ver in REQUIRED_PYTHON_TRANSITIVE_PACKAGES.items():
        if p_name not in delivered_map:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"MISSING delivered Python transitive component: {p_name}"])
        if delivered_map[p_name][0] != p_ver:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for {p_name}: expected {p_ver}, got {delivered_map[p_name][0]}"])
        if delivered_map[p_name][1] != "TRANSITIVE RUNTIME":
            return (EXIT_LICENSES_COVERAGE_GAP, [f"CLASSIFICATION MISMATCH for {p_name}: expected TRANSITIVE RUNTIME, got {delivered_map[p_name][1]}"])

    for p_name, p_ver in REQUIRED_FRONTEND_DIRECT_PACKAGES.items():
        if p_name not in delivered_map:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"MISSING delivered Frontend direct component: {p_name}"])
        if delivered_map[p_name][0] != p_ver:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for {p_name}: expected {p_ver}, got {delivered_map[p_name][0]}"])
        if delivered_map[p_name][1] != "DIRECT RUNTIME":
            return (EXIT_LICENSES_COVERAGE_GAP, [f"CLASSIFICATION MISMATCH for {p_name}: expected DIRECT RUNTIME, got {delivered_map[p_name][1]}"])

    for p_name, p_ver in REQUIRED_FRONTEND_TRANSITIVE_PACKAGES.items():
        if p_name not in delivered_map:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"MISSING delivered Frontend transitive component: {p_name}"])
        if delivered_map[p_name][0] != p_ver:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for {p_name}: expected {p_ver}, got {delivered_map[p_name][0]}"])
        if delivered_map[p_name][1] != "TRANSITIVE RUNTIME":
            return (EXIT_LICENSES_COVERAGE_GAP, [f"CLASSIFICATION MISMATCH for {p_name}: expected TRANSITIVE RUNTIME, got {delivered_map[p_name][1]}"])

    for p_name, p_ver in REQUIRED_PACKAGING_COMPONENTS.items():
        if p_name not in delivered_map:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"MISSING delivered Packaging component: {p_name}"])
        if delivered_map[p_name][0] != p_ver:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for {p_name}: expected {p_ver}, got {delivered_map[p_name][0]}"])
        if delivered_map[p_name][1] != "DELIVERED RUNTIME COMPONENT":
            return (EXIT_LICENSES_COVERAGE_GAP, [f"CLASSIFICATION MISMATCH for {p_name}: expected DELIVERED RUNTIME COMPONENT, got {delivered_map[p_name][1]}"])

    all_expected = (
        set(REQUIRED_PYTHON_DIRECT_PACKAGES.keys())
        | set(REQUIRED_PYTHON_TRANSITIVE_PACKAGES.keys())
        | set(REQUIRED_FRONTEND_DIRECT_PACKAGES.keys())
        | set(REQUIRED_FRONTEND_TRANSITIVE_PACKAGES.keys())
        | set(REQUIRED_PACKAGING_COMPONENTS.keys())
    )
    for p_delivered in delivered_map.keys():
        if p_delivered not in all_expected:
            return (EXIT_LICENSES_COVERAGE_GAP, [f"UNEXPECTED delivered package in manifest: {p_delivered}"])

    if len(delivered_map) != TOTAL_DELIVERED_COMPONENTS:
        return (EXIT_LICENSES_COVERAGE_GAP, [f"DELIVERED COUNT MISMATCH: expected {TOTAL_DELIVERED_COMPONENTS}, got {len(delivered_map)}"])

    for pkg_entry in data["packages"]:
        p_name = pkg_entry["package"]
        if p_name in EXCLUDED_BUILD_PACKAGES and pkg_entry.get("delivered", False):
            return (EXIT_LICENSES_COVERAGE_GAP, [f"BUILD TOOL falsely marked delivered: {p_name}"])

    # 5b. Certifi two-file contract and structural verification (B-LIC-04)
    certifi_pkg = next((p for p in data["packages"] if p.get("package") == "certifi"), None)
    if certifi_pkg is None:
        return (EXIT_LICENSES_COVERAGE_GAP, ["MISSING certifi package in manifest"])
    if certifi_pkg.get("version") != REQUIRED_PYTHON_TRANSITIVE_PACKAGES.get("certifi"):
        return (EXIT_LICENSES_COVERAGE_GAP, [f"VERSION MISMATCH for certifi: expected {REQUIRED_PYTHON_TRANSITIVE_PACKAGES.get('certifi')}"])

    certifi_files = [f.get("path", "").replace("\\", "/") for f in certifi_pkg.get("files", [])]
    expected_certifi_files = [
        "licenses/packages/certifi/LICENSE",
        "licenses/packages/certifi/MPL-2.0.txt",
    ]
    if certifi_files != expected_certifi_files:
        return (
            EXIT_LICENSES_COVERAGE_GAP,
            [f"CERTIFI FILES MISMATCH: expected {expected_certifi_files}, got {certifi_files}"],
        )

    if license_root is not None:
        cert_lic_file = license_tree / "packages" / "certifi" / "LICENSE"
        cert_mpl_file = license_tree / "packages" / "certifi" / "MPL-2.0.txt"
    else:
        cert_lic_file = repo / "licenses/packages/certifi/LICENSE"
        cert_mpl_file = repo / "licenses/packages/certifi/MPL-2.0.txt"

    if not cert_lic_file.is_file() or not cert_mpl_file.is_file():
        return (EXIT_LICENSES_MISSING, ["MISSING required certifi license or MPL text file"])
    if cert_lic_file.stat().st_size == 0 or cert_mpl_file.stat().st_size == 0:
        return (EXIT_LICENSES_MISSING, ["EMPTY certifi license or MPL text file"])

    lic_bytes = cert_lic_file.read_bytes()
    mpl_bytes = cert_mpl_file.read_bytes()
    if lic_bytes == mpl_bytes:
        return (EXIT_LICENSES_MALFORMED, ["MALFORMED certifi license files: LICENSE and MPL-2.0.txt cannot be identical"])

    mpl_text = cert_mpl_file.read_text(encoding="utf-8", errors="replace")
    required_mpl_markers = [
        "Mozilla Public License",
        "1. Definitions",
        "2. License Grants and Conditions",
        "3. Responsibilities",
        "10. Versions of the License",
        "Exhibit A",
        "Exhibit B",
    ]
    for marker in required_mpl_markers:
        if marker not in mpl_text:
            return (EXIT_LICENSES_MALFORMED, [f"MALFORMED certifi MPL-2.0.txt: missing structural marker '{marker}'"])

    notices_text = (repo / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8", errors="replace")
    stale_b_lic_04_markers = [
        "remain pending B-LIC-04",
        "remains tracked in B-LIC-04 and is not resolved",
    ]
    for stale in stale_b_lic_04_markers:
        if stale in notices_text:
            return (EXIT_LICENSES_MALFORMED, [f"STALE B-LIC-04 pending wording in THIRD_PARTY_NOTICES.md: '{stale}'"])

    # 6. Check Inno Setup installer delivery contract
    iss_file = repo / "installer" / "AcademicComplianceAuditor.iss"
    if not iss_file.is_file():
        return (EXIT_LICENSES_MISSING, [f"MISSING {iss_file.name}"])

    iss_text = iss_file.read_text(encoding="utf-8")
    if "LicenseFile=..\\LICENSE" not in iss_text and "LicenseFile=../LICENSE" not in iss_text:
        return (EXIT_LICENSES_MISSING, ["MISSING LicenseFile=..\\LICENSE directive in installer script"])
    if 'Source: "..\\LICENSE"' not in iss_text and 'Source: "../LICENSE"' not in iss_text:
        return (EXIT_LICENSES_MISSING, ["MISSING Source: ..\\LICENSE in installer script [Files]"])
    if 'Source: "..\\THIRD_PARTY_NOTICES.md"' not in iss_text and 'Source: "../THIRD_PARTY_NOTICES.md"' not in iss_text:
        return (EXIT_LICENSES_MISSING, ["MISSING Source: ..\\THIRD_PARTY_NOTICES.md in installer script [Files]"])

    staging_iss_literal = 'Source: "..\\release-output\\license-stage\\packages\\*"'
    staging_iss_literal_fwd = 'Source: "../release-output/license-stage/packages/*"'
    legacy_iss_literal = 'Source: "..\\licenses\\packages\\*"'
    legacy_iss_literal_fwd = 'Source: "../licenses/packages/*"'

    if license_root is not None:
        if staging_iss_literal not in iss_text and staging_iss_literal_fwd not in iss_text:
            return (EXIT_LICENSES_MISSING, ["MISSING Source: ..\\release-output\\license-stage\\packages\\* in installer script [Files]"])
    else:
        # Fallback for synthetic mock-repo unit tests
        if (staging_iss_literal not in iss_text and staging_iss_literal_fwd not in iss_text
            and legacy_iss_literal not in iss_text and legacy_iss_literal_fwd not in iss_text):
            return (EXIT_LICENSES_MISSING, ["MISSING Source: ..\\release-output\\license-stage\\packages\\* in installer script [Files]"])

    py_cnt = len(REQUIRED_PYTHON_DIRECT_PACKAGES) + len(REQUIRED_PYTHON_TRANSITIVE_PACKAGES)
    fe_dir_cnt = len(REQUIRED_FRONTEND_DIRECT_PACKAGES)
    fe_trans_cnt = len(REQUIRED_FRONTEND_TRANSITIVE_PACKAGES)
    pkg_cnt = len(REQUIRED_PACKAGING_COMPONENTS)
    messages.append(
        f"LICENSES_OK packages={len(delivered_map)} python={py_cnt} frontend_direct={fe_dir_cnt} frontend_transitive={fe_trans_cnt} packaging={pkg_cnt}"
    )
    return (EXIT_LICENSES_OK, messages)


def _licenses_cli(argv) -> int:
    action = argv[0]
    if action == "stage-licenses":
        if len(argv) < 4:
            print("FAIL: stage-licenses requires <repo_root> <commit> <dest>")
            return EXIT_LICENSES_STAGING_SOURCE
        repo_root = Path(argv[1]).resolve()
        commit = argv[2]
        dest = Path(argv[3])
        code, messages = stage_licenses(repo_root, commit, dest)
        for m in messages:
            print(m)
        return code
    elif action == "generate-manifest":
        if len(argv) < 4:
            print("FAIL: generate-manifest requires <repo_root> <stage_root> <commit> [--output <dest>]")
            return EXIT_LICENSES_MALFORMED
        repo_root = Path(argv[1]).resolve()
        stage_root = Path(argv[2]).resolve()
        commit = argv[3]
        out_path = None
        if len(argv) >= 6 and argv[4] == "--output":
            out_path = Path(argv[5])
        doc = generate_manifest(repo_root, stage_root, commit)
        if out_path:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
            print(f"MANIFEST_WRITTEN {out_path}")
        else:
            print(json.dumps(doc, indent=2))
        return EXIT_LICENSES_OK
    elif action == "verify-licenses":
        if len(argv) < 2:
            print("FAIL: verify-licenses requires <repo_root> [--license-root <path>]")
            return EXIT_LICENSES_MISSING
        repo_root = Path(argv[1]).resolve()
        license_root = None
        if len(argv) >= 4 and argv[2] == "--license-root":
            license_root = Path(argv[3])
        code, messages = verify_licenses(repo_root, license_root=license_root)
        for m in messages:
            print(m)
        if code == EXIT_LICENSES_OK:
            print("LICENSES_OK")
        else:
            print(f"LICENSES_FAIL code={code}")
        return code
    return EXIT_LICENSES_MISSING


def _legacy_main(argv) -> int:
    """Original positional CLI: <bundle_root> [toc_path ...]."""
    root = Path(argv[0]).resolve()
    max_bytes = int(os.environ.get("ACA_MAX_BUNDLE_BYTES", str(DEFAULT_MAX_BYTES)))
    toc_roots = []
    for raw in argv[1:]:
        p = Path(raw)
        if p.is_dir():
            toc_roots.extend(p.glob("*.toc"))
        elif p.is_file():
            toc_roots.append(p)

    contam = contamination_errors(root, toc_roots)
    for err in contam:
        print(f"PROHIBITED {err}")
    if contam:
        return 2

    size_errs, total, count = size_errors(root, max_bytes)
    print(f"SIZE bytes={total} files={count} ceiling={max_bytes}")
    for err in size_errs:
        print(f"SIZE_FAIL {err}")
    if size_errs:
        return 3
    print("PACKAGING_CHECKS_OK")
    return 0


if __name__ == "__main__":
    cli_args = sys.argv[1:]
    if cli_args and cli_args[0] in ("manifest", "verify-manifest"):
        sys.exit(_manifest_cli(cli_args))
    if cli_args and cli_args[0] in ("hygiene", "inventory", "verify-inventory"):
        sys.exit(_inventory_cli(cli_args))
    if cli_args and cli_args[0] in ("verify-licenses", "stage-licenses", "generate-manifest"):
        sys.exit(_licenses_cli(cli_args))
    sys.exit(_legacy_main(cli_args))
