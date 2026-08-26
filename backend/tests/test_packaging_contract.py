"""Packaging reproducibility contract tests.

These are static/unit tests only. They never invoke PyInstaller, never touch a
global Python installation, and never build the bundle. They verify that:

1. The build script uses the controlled backend/.venv interpreter for
   PyInstaller (`python -m PyInstaller`) and never a bare `pyinstaller`.
2. The build script rejects non-3.12 interpreters and fails before building.
3. requirements-dev.txt owns the exact PyInstaller pin.
4. The bundle contamination detector flags prohibited packages robustly.
5. The size guard flags oversized bundles.
"""

import re
import sys
import textwrap
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = BACKEND_DIR / "scripts"
BUILD_SCRIPT = SCRIPTS_DIR / "build-packaging-poc.ps1"
CHECKS_MODULE = SCRIPTS_DIR / "packaging_checks.py"
REQ_DEV = BACKEND_DIR / "requirements-dev.txt"

sys.path.insert(0, str(SCRIPTS_DIR))
import packaging_checks  # noqa: E402

PROHIBITED = packaging_checks.PROHIBITED_PACKAGES
DEFAULT_MAX = packaging_checks.DEFAULT_MAX_BYTES

BUILD_SCRIPT_TEXT = BUILD_SCRIPT.read_text(encoding="utf-8")


def _tmp_bundle(tmp_path, dirs=(), files=(), size_files=0):
    """Build a fake one-folder bundle root: bundle/_internal/<dirs|files>."""
    internal = tmp_path / "_internal"
    internal.mkdir(parents=True, exist_ok=True)
    for name in dirs:
        (internal / name).mkdir(parents=True, exist_ok=True)
    for name, content in files:
        p = internal / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    for i in range(size_files):
        p = tmp_path / f"blob{i}.bin"
        p.write_bytes(b"x" * 1048576)
    return tmp_path


# ---------------------------------------------------------------------------
# Build script contract
# ---------------------------------------------------------------------------


def test_build_script_never_invokes_bare_pyinstaller():
    assert re.search(r"pyinstaller", BUILD_SCRIPT_TEXT, re.IGNORECASE)
    # No unqualified invocation: `pyinstaller` must always be `$VenvPython -m PyInstaller`.
    for line in BUILD_SCRIPT_TEXT.splitlines():
        stripped = line.strip()
        if re.match(r"^&\s+pyinstaller\b", stripped, re.IGNORECASE):
            pytest.fail(f"bare pyinstaller invocation found: {line}")
        if stripped.lower() == "pyinstaller aca.spec --noconfirm":
            pytest.fail("bare pyinstaller invocation found")
    assert "-m PyInstaller" in BUILD_SCRIPT_TEXT


def test_build_script_uses_controlled_venv_interpreter():
    # The venv python path must be derived from backend/.venv.
    assert ".venv" in BUILD_SCRIPT_TEXT
    assert "Scripts\\python.exe" in BUILD_SCRIPT_TEXT or "Scripts/python.exe" in BUILD_SCRIPT_TEXT
    # The PyInstaller invocation must use the controlled interpreter, not PATH.
    assert "$VenvPython -m PyInstaller" in BUILD_SCRIPT_TEXT


def test_build_script_rejects_non_312_before_build():
    # The version check must be an early step and fail (exit non-zero) without
    # reaching npm/PyInstaller. Static evidence: a Fail with a 3.12 message and
    # the check runs in step 0 before any build.
    assert "RequiredPythonMajorMinor" in BUILD_SCRIPT_TEXT
    assert "3.12" in BUILD_SCRIPT_TEXT
    assert "requires Python" in BUILD_SCRIPT_TEXT
    assert "=== 0. Packaging environment" in BUILD_SCRIPT_TEXT


def test_build_script_fails_clearly_when_venv_or_pyinstaller_missing():
    assert "The controlled packaging interpreter is missing" in BUILD_SCRIPT_TEXT
    assert "PyInstaller is not installed in the controlled environment" in BUILD_SCRIPT_TEXT
    assert "pip install -r requirements-dev.txt" in BUILD_SCRIPT_TEXT
    # No silent fallback to global python / PATH-resolved executable.
    assert "Get-Command pyinstaller" not in BUILD_SCRIPT_TEXT
    assert "shutil.which" not in BUILD_SCRIPT_TEXT


def test_build_script_verifies_pyinstaller_pin():
    assert "RequiredPyInstallerVersion" in BUILD_SCRIPT_TEXT
    assert "6.22.2" in BUILD_SCRIPT_TEXT
    assert "does not match the repository pin" in BUILD_SCRIPT_TEXT


def test_build_script_uses_checks_module():
    assert "packaging_checks.py" in BUILD_SCRIPT_TEXT
    assert "Test-BundleChecks" in BUILD_SCRIPT_TEXT


def test_build_script_preserves_core_checks():
    for marker in (
        "=== 1. npm ci",
        "=== 2. npm run build",
        "Markers OK",
        "Hash match OK",
        "=== 7. Frozen smoke",
        "/dashboard",
        "/history",
        "/profiles/custom",
        "/audit/test-id",
        "127.0.0.1",
    ):
        assert marker in BUILD_SCRIPT_TEXT, f"missing marker {marker}"


def test_build_script_no_destructive_cleanup_of_ignored_dist():
    # frontend/dist is ignored+untracked; the finally block must not use
    # `git clean -fd` to delete it.
    assert "git clean" not in BUILD_SCRIPT_TEXT
    assert "git restore frontend/dist" not in BUILD_SCRIPT_TEXT


def test_build_script_isolates_smoke_runtime_root():
    assert "aca_smoke_" in BUILD_SCRIPT_TEXT
    assert "$env:LOCALAPPDATA = $smokeRoot" in BUILD_SCRIPT_TEXT


# ---------------------------------------------------------------------------
# Dependency manifest
# ---------------------------------------------------------------------------


def test_requirements_dev_owns_pyinstaller_pin():
    text = REQ_DEV.read_text(encoding="utf-8")
    assert "PyInstaller==6.22.2" in text


def test_runtime_requirements_exclude_pyinstaller():
    text = (BACKEND_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert "PyInstaller" not in text


# ---------------------------------------------------------------------------
# Contamination detection (packaging_checks.py)
# ---------------------------------------------------------------------------


def test_clean_bundle_passes_contamination(tmp_path):
    bundle = _tmp_bundle(tmp_path, dirs=("fastapi", "sqlalchemy"), files=(("x.py", "x"),))
    assert packaging_checks.contamination_errors(bundle) == []


def test_prohibited_package_dir_detected(tmp_path):
    for name in ("numpy", "pandas", "scipy", "matplotlib", "pyarrow", "ollama"):
        bundle = _tmp_bundle(tmp_path, dirs=(name,))
        errs = packaging_checks.contamination_errors(bundle)
        assert any(name in e for e in errs), f"{name} not detected"


def test_distinfo_and_libs_dirs_detected(tmp_path):
    for name in ("numpy-2.1.3.dist-info", "numpy.libs", "pandas-2.2.3.dist-info"):
        bundle = _tmp_bundle(tmp_path, dirs=(name,))
        errs = packaging_checks.contamination_errors(bundle)
        assert any(name.split("-")[0].split(".")[0] in e for e in errs), f"{name} not detected"


def test_no_false_positive_for_similar_names(tmp_path):
    # Longer names containing the token must NOT match.
    bundle = _tmp_bundle(
        tmp_path,
        dirs=("numpycompat", "scipylab", "matplotlibcustom", "ollama_client_extra"),
    )
    assert packaging_checks.contamination_errors(bundle) == []


def test_prohibited_toc_entry_detected(tmp_path):
    toc = tmp_path / "COLLECT-00.toc"
    toc.write_text(textwrap.dedent("""\
    ('numpy', '/x/site-packages/numpy/__init__.py', 'PYMODULE')
    ('fastapi', '/x/site-packages/fastapi/__init__.py', 'PYMODULE')
    """), encoding="utf-8")
    errs = packaging_checks.contamination_errors(_tmp_bundle(tmp_path), toc_paths=[toc])
    assert any("numpy" in e and "TOC" in e for e in errs)
    assert not any("fastapi" in e for e in errs)


def test_clean_toc_passes(tmp_path):
    toc = tmp_path / "COLLECT-00.toc"
    toc.write_text("('fastapi', '/x/site-packages/fastapi/__init__.py', 'PYMODULE')", encoding="utf-8")
    assert packaging_checks.contamination_errors(_tmp_bundle(tmp_path), toc_paths=[toc]) == []


def test_setuptools_numpy_shim_not_false_positive(tmp_path):
    # setuptools ships a compat shim; its dotted name and nested path must NOT
    # be treated as the numpy package.
    toc = tmp_path / "Analysis-00.toc"
    toc.write_text(textwrap.dedent("""\
    ('setuptools._distutils.compat.numpy',
     'C:\\\\env\\\\site-packages\\\\setuptools\\\\_distutils\\\\compat\\\\numpy.py',
     'PYMODULE')
    """), encoding="utf-8")
    bundle = _tmp_bundle(tmp_path, dirs=("setuptools",))
    assert packaging_checks.contamination_errors(bundle, toc_paths=[toc]) == []


def test_site_packages_top_level_prohibited_detected(tmp_path):
    # A real top-level site-packages path segment must be detected.
    toc = tmp_path / "COLLECT-00.toc"
    toc.write_text("('numpy', 'C:\\\\env\\\\site-packages\\\\numpy\\\\__init__.py', 'PYMODULE')", encoding="utf-8")
    bundle = _tmp_bundle(tmp_path)
    errs = packaging_checks.contamination_errors(bundle, toc_paths=[toc])
    assert any("numpy" in e and "TOC" in e for e in errs)


def test_dotted_module_start_detected(tmp_path):
    # A quoted module name STARTING with the prohibited package must match.
    toc = tmp_path / "PYZ-00.toc"
    toc.write_text("('numpy.core._multiarray_umath', 'x', 'PYMODULE')", encoding="utf-8")
    bundle = _tmp_bundle(tmp_path)
    errs = packaging_checks.contamination_errors(bundle, toc_paths=[toc])
    assert any("numpy" in e and "TOC" in e for e in errs)


# ---------------------------------------------------------------------------
# Size guard
# ---------------------------------------------------------------------------


def test_oversized_bundle_fails(tmp_path):
    # 5 MB of blobs, ceiling 1 MB -> must fail.
    bundle = _tmp_bundle(tmp_path, size_files=5)
    errs, total, count = packaging_checks.size_errors(bundle, max_bytes=1048576)
    assert errs
    assert total >= 5 * 1048576
    assert count >= 5


def test_normal_bundle_passes(tmp_path):
    bundle = _tmp_bundle(tmp_path, files=(("a.py", "x"), ("b.py", "yy")))
    errs, total, count = packaging_checks.size_errors(bundle, max_bytes=DEFAULT_MAX)
    assert errs == []
    assert count == 2


def test_size_report_shape(tmp_path):
    bundle = _tmp_bundle(tmp_path, files=(("a.py", "hello"),))
    errs, total, count = packaging_checks.size_errors(bundle, max_bytes=DEFAULT_MAX)
    assert total == 5
    assert count == 1
