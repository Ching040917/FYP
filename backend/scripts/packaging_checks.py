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


def _check_regular(path: Path, repo_root: Path, rel: str) -> None:
    """Reject symlinks, junctions and realpath escapes. Never follow a link."""
    if path.is_symlink():
        raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: symbolic link")
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: junction")
    if not _is_within(path.resolve(), repo_root.resolve()):
        raise ManifestProblem(EXIT_UNSAFE_PATH, f"UNSAFE {rel}: resolves outside the repository")


def _hash_path(path: Path, repo_root: Path, rel: str) -> tuple[str, int]:
    """Return (sha256, size) for a governed file, rejecting unstable reads."""
    _check_regular(path, repo_root, rel)
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
        raise ManifestProblem(EXIT_UNSTABLE, f"UNSTABLE {rel}")
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


def _insert_input(rows: dict, path: Path, repo_root: Path, category: str, rel=None) -> None:
    rel = rel or _normalise_rel(path.relative_to(repo_root).as_posix())
    key = rel.casefold()
    if key in rows:
        if rows[key]["path"] != rel:
            raise ManifestProblem(
                EXIT_UNSAFE_MANIFEST,
                f"UNSAFE duplicate governed path {rel} / {rows[key]['path']}",
            )
        return
    sha256, size = _hash_path(path, repo_root, rel)
    rows[key] = {"path": rel, "category": category, "sha256": sha256, "size": size}


def collect_inputs(repo_root: Path) -> list[dict]:
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


def _bundle_rows(bundle_root: Path) -> list[dict]:
    """Return deterministic [{path, size, sha256}] rows for every bundle file."""
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
            sha256, size = _hash_path(path, bundle_root, rel)
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
) -> dict:
    """Build the deterministic manifest content plus non-deterministic metadata."""
    content = {
        "inputs": collect_inputs(repo_root),
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
) -> tuple[int, list[str]]:
    """Compare a loaded manifest against the working tree and the bundle."""
    recorded_content = manifest["content"]
    current = {
        "inputs": collect_inputs(repo_root),
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
) -> tuple[int, list[str]]:
    """Return (exit_code, messages). Exit 0 means parity is proven."""
    try:
        manifest = load_manifest(path)
        return manifest_problems(repo_root, bundle_root, manifest)
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
    return _bundle_rows(bundle_root)


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
        recorded = _load_inventory(path)
        current = _inventory_content(_bundle_rows(bundle_root))
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
    options = {"--output": None, "--manifest": None, "--node-version": None, "--npm-version": None}
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
            manifest = build_manifest(repo_root, bundle_root, recorded)
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
        code, messages = verify_manifest(repo_root, bundle_root, Path(options["--manifest"]))
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
    sys.exit(_legacy_main(cli_args))
