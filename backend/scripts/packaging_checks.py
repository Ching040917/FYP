"""Packaging validation helpers (pure Python, testable).

Used by build-packaging-poc.ps1 via the controlled backend/.venv interpreter.
Kept free of third-party imports so tests run in any environment.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

PROHIBITED_PACKAGES = ("numpy", "pandas", "scipy", "matplotlib", "pyarrow", "ollama")
DEFAULT_MAX_BYTES = 250 * 1024 * 1024  # 250 MB

# Match a directory exactly, a dist-info dir like "numpy-1.26.0.dist-info",
# or a namespace/libs dir like "numpy.libs" — never a longer name that merely
# contains the token (e.g. "numpycompat").
_PROHIBITED_DIR_RE = re.compile(
    r"^(?P<name>numpy|pandas|scipy|matplotlib|pyarrow|ollama)"
    r"(?:[.-].*)?$",
    re.IGNORECASE,
)

# A real top-level package appears in TOCs as a quoted module name at the
# START of a dotted chain ("('numpy', ...", "('numpy.core', ...") or as the
# FIRST path segment under site-packages ("site-packages\\numpy\\..."). The
# setuptools shim "setuptools._distutils.compat.numpy" and its path
# "...\\compat\\numpy.py" are NOT the numpy package and must not match.
_MODULE_NAME_RE = re.compile(
    r"(?:^|['\"\s\[])(?P<token>numpy|pandas|scipy|matplotlib|pyarrow|ollama)"
    r"(?=[.'\"\],])",
)
_SITE_PACKAGES_PATH_RE = re.compile(
    r"site-packages[\\/](?P<token>numpy|pandas|scipy|matplotlib|pyarrow|ollama)"
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


if __name__ == "__main__":
    # CLI used by the PowerShell build script.
    root = Path(sys.argv[1]).resolve()
    max_bytes = int(os.environ.get("ACA_MAX_BUNDLE_BYTES", str(DEFAULT_MAX_BYTES)))
    toc_roots = []
    for raw in sys.argv[2:]:
        p = Path(raw)
        if p.is_dir():
            toc_roots.extend(p.glob("*.toc"))
        elif p.is_file():
            toc_roots.append(p)

    contam = contamination_errors(root, toc_roots)
    for err in contam:
        print(f"PROHIBITED {err}")
    if contam:
        sys.exit(2)

    size_errs, total, count = size_errors(root, max_bytes)
    print(f"SIZE bytes={total} files={count} ceiling={max_bytes}")
    for err in size_errs:
        print(f"SIZE_FAIL {err}")
    if size_errs:
        sys.exit(3)
    print("PACKAGING_CHECKS_OK")
