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

import builtins
import hashlib
import json
import os
import re
import subprocess
import sys
import textwrap
import time
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
    for name in PROHIBITED:
        bundle = _tmp_bundle(tmp_path, dirs=(name,))
        errs = packaging_checks.contamination_errors(bundle)
        assert any(name in e for e in errs), f"{name} not detected"


def test_distinfo_and_libs_dirs_detected(tmp_path):
    for name in (
        "numpy-2.1.3.dist-info",
        "numpy.libs",
        "pandas-2.2.3.dist-info",
        "google_generativeai-0.7.2.dist-info",
    ):
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


def test_gemini_sdk_nested_package_dir_detected(tmp_path):
    # The SDK ships as google/generativeai — a nested path the top-level
    # directory rule cannot see.
    bundle = _tmp_bundle(tmp_path)
    (bundle / "_internal" / "google" / "generativeai").mkdir(parents=True)
    errs = packaging_checks.contamination_errors(bundle)
    assert any("generativeai" in e for e in errs)


def test_google_namespace_alone_not_flagged(tmp_path):
    # A bare google/ namespace (e.g. protobuf) is not the Gemini SDK.
    bundle = _tmp_bundle(tmp_path, dirs=("google",))
    assert packaging_checks.contamination_errors(bundle) == []


def test_gemini_sdk_toc_entries_detected(tmp_path):
    toc = tmp_path / "PYZ-00.toc"
    toc.write_text(textwrap.dedent("""\
    ('google.generativeai.client', 'x', 'PYMODULE')
    ('googleapiclient.discovery', 'x', 'PYMODULE')
    """), encoding="utf-8")
    errs = packaging_checks.contamination_errors(_tmp_bundle(tmp_path), toc_paths=[toc])
    assert any("google.generativeai" in e for e in errs)
    assert any("googleapiclient" in e for e in errs)


def test_gemini_sdk_site_packages_path_detected(tmp_path):
    toc = tmp_path / "COLLECT-00.toc"
    toc.write_text(
        "('x', 'C:\\\\env\\\\site-packages\\\\google\\\\generativeai\\\\__init__.py', 'PYMODULE')",
        encoding="utf-8",
    )
    errs = packaging_checks.contamination_errors(_tmp_bundle(tmp_path), toc_paths=[toc])
    assert any("generativeai" in e for e in errs)


def test_prohibited_tokens_enforced_at_every_site():
    # Updating only the display tuple would silently weaken the guard: every
    # independently hard-coded regex and the PowerShell mirror must carry the
    # new tokens too.
    for token in ("googleapiclient", "google_generativeai"):
        assert token in PROHIBITED
        assert token in packaging_checks._PROHIBITED_DIR_RE.pattern
        assert token in BUILD_SCRIPT_TEXT
    assert r"google\.generativeai" in packaging_checks._MODULE_NAME_RE.pattern
    assert r"site-packages[\\/]+" in packaging_checks._SITE_PACKAGES_PATH_RE.pattern
    assert r"google[\\/]+generativeai" in packaging_checks._SITE_PACKAGES_PATH_RE.pattern


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


# ---------------------------------------------------------------------------
# Release input manifest (B-PACK-01)
#
# Everything below is hermetic: the governed inputs, the fake controlled venv
# and the fake runtime bundle are all created under tmp_path. No test reads the
# real repository tree or the real backend/.venv.
# ---------------------------------------------------------------------------

BUNDLE_REL = "backend/dist/run-frozen"


def _write(path, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    path.write_bytes(data)
    return path


def _tmp_repo(tmp_path, *, dist_text="dist-a", pyinstaller_version="6.22.2", python_bytes=b"python-3.12.10"):
    """Minimal governed repository: sources, dist, assets, packaging, venv, bundle."""
    repo = tmp_path / "repo"
    for rel, data in (
        ("backend/ACA.spec", "spec"),
        ("backend/alembic.ini", "alembic-ini"),
        ("backend/frozen_main.py", "frozen-main"),
        ("backend/requirements.txt", "fastapi==0.110.1\n"),
        ("backend/requirements-dev.txt", "PyInstaller==6.22.2\n"),
        ("backend/alembic/versions/0001_init.py", "migration"),
        ("backend/scripts/packaging_checks.py", "checks"),
        ("backend/scripts/build-packaging-poc.ps1", "poc"),
        ("frontend/index.html", "<html></html>"),
        ("frontend/vite.config.ts", "vite"),
        ("frontend/tailwind.config.js", "tailwind"),
        ("frontend/postcss.config.js", "postcss"),
        ("frontend/tsconfig.json", "{}"),
        ("frontend/tsconfig.node.json", "{}"),
        ("frontend/package.json", "{}"),
        ("frontend/package-lock.json", "{}"),
        ("frontend/src/main.ts", "src"),
        ("frontend/dist/index.html", dist_text),
        ("frontend/public/samples/sample-thesis.docx", b"docx-bytes"),
        ("assets/branding/aca-icon.ico", b"ico"),
        ("assets/branding/aca-icon-wizard.bmp", b"bmp"),
        ("assets/branding/aca-icon-source.png", b"png"),
        ("installer/AcademicComplianceAuditor.iss", "iss"),
        ("scripts/build-installer.ps1", "build-installer"),
    ):
        _write(repo / rel, data)

    site_packages = repo / "backend/.venv/Lib/site-packages"
    _write(
        site_packages / "pyinstaller-6.22.2.dist-info/METADATA",
        f"Name: PyInstaller\nVersion: {pyinstaller_version}\n\nbody\n",
    )
    _write(
        site_packages / "alembic-1.11.1.dist-info/METADATA",
        "Name: alembic\nVersion: 1.11.1\n\n",
    )
    _write(repo / "backend/.venv/Scripts/python.exe", python_bytes)

    bundle = repo / BUNDLE_REL
    _write(bundle / "run-frozen.exe", b"exe")
    _write(bundle / "_internal/frontend-dist/index.html", dist_text)
    return repo


def _generate(repo, tmp_path, name="input-manifest.json"):
    path = tmp_path / name
    packaging_checks.write_manifest_atomic(
        path, packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    )
    return path


def _verify(repo, path):
    return packaging_checks.verify_manifest(repo, repo / BUNDLE_REL, path)


def _dump(path, manifest):
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def test_manifest_is_deterministic(tmp_path):
    repo = _tmp_repo(tmp_path)
    first = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    time.sleep(1.1)
    second = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    assert first["content"] == second["content"]
    assert first["content_sha256"] == second["content_sha256"]
    assert "generated_at_utc" in first["recorded"]
    assert "generated_at_utc" not in json.dumps(first["content"])


def test_manifest_input_order_is_sorted(tmp_path):
    repo = _tmp_repo(tmp_path)
    paths = [row["path"] for row in packaging_checks.collect_inputs(repo)]
    assert paths == sorted(paths, key=lambda p: (p.casefold(), p))


def test_manifest_distribution_order_is_sorted(tmp_path):
    repo = _tmp_repo(tmp_path)
    _write(
        repo / "backend/.venv/Lib/site-packages/Zeta-1.0.dist-info/METADATA",
        "Name: Zeta\nVersion: 1.0\n\n",
    )
    dists = packaging_checks.collect_toolchain(repo)["distributions"]
    names = [row["name"] for row in dists]
    assert names == sorted(names, key=lambda n: (n.casefold(), n))
    assert [row["version"] for row in dists if row["name"] == "PyInstaller"] == ["6.22.2"]


def test_manifest_hashes_are_full_sha256(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    assert re.fullmatch(r"[0-9a-f]{64}", manifest["content_sha256"])
    for row in manifest["content"]["inputs"]:
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), row["path"]
    for key in ("tree_sha256",):
        assert re.fullmatch(r"[0-9a-f]{64}", manifest["content"]["runtime"][key])
    assert re.fullmatch(r"[0-9a-f]{64}", manifest["content"]["toolchain"]["python_sha256"])


def test_manifest_parity_accepts_unchanged_inputs(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_PARITY, messages


def test_manifest_rejects_changed_source(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / "backend/frozen_main.py", "frozen-main-edited")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_CHANGED
    assert "CHANGED backend/frozen_main.py" in messages


def test_manifest_rejects_changed_frontend_asset(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / "frontend/dist/index.html", "dist-b")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_CHANGED
    assert "CHANGED frontend/dist/index.html" in messages


def test_manifest_rejects_changed_package_lock(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / "frontend/package-lock.json", '{"lock": 2}')
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_CHANGED
    assert "CHANGED frontend/package-lock.json" in messages


def test_manifest_rejects_changed_notice_input(tmp_path):
    repo = _tmp_repo(tmp_path)
    _write(repo / "THIRD_PARTY_NOTICES.md", "notices-v1")
    path = _generate(repo, tmp_path)
    _write(repo / "THIRD_PARTY_NOTICES.md", "notices-v2")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_CHANGED
    assert "CHANGED THIRD_PARTY_NOTICES.md" in messages


def test_verify_manifest_missing_file_exit_20(tmp_path):
    repo = _tmp_repo(tmp_path)
    code, messages = _verify(repo, tmp_path / "absent-manifest.json")
    assert code == packaging_checks.EXIT_MANIFEST_MISSING
    assert messages


def test_verify_manifest_malformed_exit_22(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = tmp_path / "broken.json"
    path.write_text("{", encoding="utf-8")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_MALFORMED
    assert messages


def test_verify_manifest_schema_exit_21(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    manifest["schema_version"] = 999
    path = _dump(tmp_path / "schema.json", manifest)
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_SCHEMA
    assert messages


def test_manifest_rejects_missing_input(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    (repo / "backend/frozen_main.py").unlink()
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_MISSING_INPUT
    assert "MISSING backend/frozen_main.py" in messages


def test_manifest_rejects_added_input(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / "frontend/src/extra.ts", "extra")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_ADDED_INPUT
    assert "ADDED frontend/src/extra.ts" in messages


def test_manifest_rejects_toolchain_change(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(
        repo / "backend/.venv/Lib/site-packages/pyinstaller-6.22.2.dist-info/METADATA",
        "Name: PyInstaller\nVersion: 6.22.3\n\n",
    )
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_TOOLCHAIN
    assert "TOOLCHAIN pyinstaller_version" in messages


def test_manifest_rejects_changed_python_identity(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / "backend/.venv/Scripts/python.exe", b"python-3.12.11")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_TOOLCHAIN
    assert "TOOLCHAIN python_sha256" in messages


def test_manifest_requires_runtime_digest(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    _write(repo / BUNDLE_REL / "_internal/frontend-dist/index.html", "dist-b")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_RUNTIME, messages
    assert "RUNTIME tree_sha256 mismatch" in messages


def test_manifest_write_is_atomic(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    assert path.is_file()
    assert not Path(str(path) + ".tmp").exists()
    stray = Path(str(path) + ".tmp")
    stray.write_text("{ not json", encoding="utf-8")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_PARITY, messages


def test_manifest_paths_use_forward_slashes_and_no_absolute(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    for row in manifest["content"]["inputs"]:
        path = row["path"]
        assert "\\" not in path
        assert not path.startswith("/")
        assert not path.startswith("./")
        assert ":" not in path
        assert not any(segment in ("", ".", "..") for segment in path.split("/"))


def test_manifest_rejects_unsafe_path_entries(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    row = {"path": "/etc/passwd", "category": "backend", "sha256": "0" * 64, "size": 1}
    manifest["content"]["inputs"].append(row)
    path = _dump(tmp_path / "unsafe-absolute.json", manifest)
    assert _verify(repo, path)[0] == packaging_checks.EXIT_UNSAFE_MANIFEST

    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    manifest["content"]["inputs"].append(
        {"path": "../outside.py", "category": "backend", "sha256": "0" * 64, "size": 1}
    )
    path = _dump(tmp_path / "unsafe-dotdot.json", manifest)
    assert _verify(repo, path)[0] == packaging_checks.EXIT_UNSAFE_MANIFEST

    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    manifest["content"]["inputs"].append(
        {"path": "C:/windows/x.py", "category": "backend", "sha256": "0" * 64, "size": 1}
    )
    path = _dump(tmp_path / "unsafe-drive.json", manifest)
    assert _verify(repo, path)[0] == packaging_checks.EXIT_UNSAFE_MANIFEST


def test_manifest_rejects_case_fold_collision(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    manifest["content"]["inputs"].append(
        {"path": "Frontend/SRC/Main.ts", "category": "frontend-source", "sha256": "0" * 64, "size": 1}
    )
    path = _dump(tmp_path / "casefold.json", manifest)
    assert _verify(repo, path)[0] == packaging_checks.EXIT_UNSAFE_MANIFEST


def test_manifest_rejects_nfc_equivalent_collision(tmp_path):
    repo = _tmp_repo(tmp_path)
    manifest = packaging_checks.build_manifest(repo, repo / BUNDLE_REL)
    manifest["content"]["inputs"].extend(
        [
            {"path": "frontend/src/caf\u00e9.ts", "category": "frontend-source", "sha256": "0" * 64, "size": 1},
            {"path": "frontend/src/cafe\u0301.ts", "category": "frontend-source", "sha256": "0" * 64, "size": 1},
        ]
    )
    path = _dump(tmp_path / "nfc.json", manifest)
    assert _verify(repo, path)[0] == packaging_checks.EXIT_UNSAFE_MANIFEST


def test_manifest_rejects_symlinked_input(tmp_path):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    outside = _write(tmp_path / "outside.py", "outside")
    link = repo / "backend/linked.py"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted on this host")
    code, messages = _verify(repo, path)
    assert code == packaging_checks.EXIT_UNSAFE_PATH
    assert any("UNSAFE" in message for message in messages)


def test_manifest_rejects_unstable_input(tmp_path, monkeypatch):
    repo = _tmp_repo(tmp_path)
    path = _generate(repo, tmp_path)
    target = repo / "backend/frozen_main.py"
    real_open = builtins.open
    fired = {"done": False}

    def mutating_open(file, *args, **kwargs):
        handle = real_open(file, *args, **kwargs)
        if not fired["done"] and Path(file) == target:
            fired["done"] = True
            # Genuine mid-read mutation: the post-read stat now disagrees with
            # the pre-read stat, which is exactly what must fail closed.
            with real_open(target, "ab") as appender:
                appender.write(b"-mutated-during-hash")
        return handle

    monkeypatch.setattr(packaging_checks, "open", mutating_open, raising=False)
    code, messages = _verify(repo, path)
    assert fired["done"] is True
    assert code == packaging_checks.EXIT_UNSTABLE
    assert "UNSTABLE backend/frozen_main.py" in messages


def test_legacy_cli_contamination_exit_2(tmp_path):
    bundle = _tmp_bundle(tmp_path, dirs=("numpy",))
    completed = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), str(bundle)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 2, completed.stdout + completed.stderr
    assert "PROHIBITED" in completed.stdout


def test_legacy_cli_oversize_exit_3(tmp_path):
    bundle = _tmp_bundle(tmp_path, files=(("blob.bin", "x" * 100),))
    env = dict(os.environ, ACA_MAX_BUNDLE_BYTES="10")
    completed = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), str(bundle)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert completed.returncode == 3, completed.stdout + completed.stderr
    assert "SIZE_FAIL" in completed.stdout


# ---------------------------------------------------------------------------
# Packaging hygiene and delivered-file inventory (B-HYGIENE-01)
# ---------------------------------------------------------------------------


def _tmp_runtime(tmp_path, entries=()):
    """Bundle root at tmp_path/runtime with entries relative to the bundle root."""
    root = tmp_path / "runtime"
    root.mkdir(parents=True, exist_ok=True)
    for name, content in entries:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = content.encode("utf-8")
        path.write_bytes(content)
    return root


def _inventory_path(tmp_path, name="file-inventory.json"):
    return tmp_path / name


def _legacy_tree_digest(bundle):
    """Reimplementation of the published B-PACK-01 digest, for regression proof."""
    rows = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(bundle, followlinks=False):
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            rel = path.relative_to(bundle).as_posix()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            rows.append((rel, digest))
            total += path.stat().st_size
    rows.sort(key=lambda row: (row[0].casefold(), row[0]))
    tree = hashlib.sha256()
    for rel, digest in rows:
        tree.update(f"{rel}\t{digest}\n".encode("utf-8"))
    return {"tree_sha256": tree.hexdigest(), "file_count": len(rows), "total_bytes": total}


def test_inventory_covers_every_file(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (("run-frozen.exe", b"exe"), ("_internal/a/b/c.txt", b"c"), ("_internal/d.dll", b"d")),
    )
    inventory = packaging_checks.build_inventory(bundle)
    assert [row["path"] for row in inventory["files"]] == [
        "_internal/a/b/c.txt",
        "_internal/d.dll",
        "run-frozen.exe",
    ]
    assert inventory["summary"]["file_count"] == 3
    assert inventory["summary"]["total_bytes"] == 5


def test_inventory_order_is_deterministic(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("z.txt", b"z"), ("a.txt", b"a"), ("m/m.txt", b"m")))
    rows = packaging_checks.inventory_files(bundle)
    paths = [row["path"] for row in rows]
    assert paths == sorted(paths, key=lambda p: (p.casefold(), p))


def test_inventory_hashes_are_full_sha256(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"), ("_internal/b.txt", b"bb")))
    inventory = packaging_checks.build_inventory(bundle)
    assert re.fullmatch(r"[0-9a-f]{64}", inventory["content_sha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", inventory["summary"]["tree_sha256"])
    for row in inventory["files"]:
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"])


def test_inventory_tree_digest_matches_bundle_digest(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"), ("_internal/x/y.txt", b"y")))
    inventory = packaging_checks.build_inventory(bundle)
    digest = packaging_checks.bundle_tree_digest(bundle)
    assert inventory["summary"]["tree_sha256"] == digest["tree_sha256"]
    assert inventory["summary"]["file_count"] == digest["file_count"]
    assert inventory["summary"]["total_bytes"] == digest["total_bytes"]


def test_inventory_is_independent_of_creation_order(tmp_path):
    first = _tmp_runtime(tmp_path / "one", (("a.txt", b"a"), ("b.txt", b"b")))
    second = _tmp_runtime(tmp_path / "two", (("b.txt", b"b"), ("a.txt", b"a")))
    assert (
        packaging_checks.build_inventory(first)["content_sha256"]
        == packaging_checks.build_inventory(second)["content_sha256"]
    )


def test_inventory_empty_bundle(tmp_path):
    bundle = _tmp_runtime(tmp_path)
    inventory = packaging_checks.build_inventory(bundle)
    assert inventory["files"] == []
    assert inventory["summary"] == {
        "file_count": 0,
        "total_bytes": 0,
        "tree_sha256": hashlib.sha256(b"").hexdigest(),
    }


def test_inventory_write_is_atomic(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    inventory = packaging_checks.build_inventory(bundle)
    path = _inventory_path(tmp_path)
    packaging_checks.write_manifest_atomic(path, inventory)
    assert path.is_file()
    assert not Path(str(path) + ".tmp").exists()
    Path(str(path) + ".tmp").write_text("{ not json", encoding="utf-8")
    assert packaging_checks.verify_inventory(bundle, path)[0] == 0


def test_hygiene_rejects_env_file(tmp_path):
    bundle = _tmp_runtime(tmp_path, ((".env", b"SECRET=1"),))
    assert any("PROHIBITED .env" in error for error in packaging_checks.sensitive_errors(bundle))


def test_hygiene_rejects_env_variants(tmp_path):
    bundle = _tmp_runtime(tmp_path, ((".env.local", b"x"), (".env.production", b"y")))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any(".env.local" in error for error in errors)
    assert any(".env.production" in error for error in errors)


def test_hygiene_rejects_database_files(tmp_path):
    bundle = _tmp_runtime(
        tmp_path, (("audit.db", b"x"), ("_internal/x.sqlite", b"y"), ("_internal/y.sqlite3", b"z"))
    )
    errors = packaging_checks.sensitive_errors(bundle)
    for name in ("audit.db", "x.sqlite", "y.sqlite3"):
        assert any(name in error for error in errors), name


def test_hygiene_rejects_log_files(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/logs/app.log", b"log"),))
    errors = packaging_checks.sensitive_errors(bundle)
    assert errors and "app.log" in errors[0]


def test_hygiene_rejects_source_maps(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/frontend-dist/assets/app.js.map", b"{}"),))
    assert packaging_checks.sensitive_errors(bundle)


def test_hygiene_rejects_bytecode(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/m.pyc", b"x"), ("_internal/n.pyo", b"y")))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any("m.pyc" in error for error in errors)
    assert any("n.pyo" in error for error in errors)


def test_hygiene_rejects_pycache_directory(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/alembic/__pycache__/env.pyc", b"x"),))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any("__pycache__" in error for error in errors)


def test_hygiene_rejects_key_and_pem_files(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (("server.key", b"k"), ("_internal/secret.pem", b"p"), ("_internal/cert.p12", b"c")),
    )
    errors = packaging_checks.sensitive_errors(bundle)
    for name in ("server.key", "secret.pem", "cert.p12"):
        assert any(name in error for error in errors), name


def test_hygiene_rejects_evidence_and_test_output_dirs(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (
            ("evidence/x.json", b"{}"),
            ("test-results/y.json", b"{}"),
            ("playwright-report/z.html", "<html></html>"),
        ),
    )
    errors = packaging_checks.sensitive_errors(bundle)
    for name in ("evidence", "test-results", "playwright-report"):
        assert any(name in error for error in errors), name


def test_hygiene_match_is_case_insensitive(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (("AUDIT.DB", b"x"), (".ENV", b"y"), ("_internal/Cache/__PYCACHE__/x.PYC", b"z")),
    )
    errors = packaging_checks.sensitive_errors(bundle)
    assert len(errors) >= 3


def test_hygiene_detects_nested_prohibited_files(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/a/b/c/app.log", b"log"),))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any("_internal/a/b/c/app.log" in error for error in errors)


def test_hygiene_allows_sample_docx(tmp_path):
    bundle = _tmp_runtime(
        tmp_path, (("_internal/frontend-dist/samples/sample-thesis.docx", b"docx"),)
    )
    assert packaging_checks.sensitive_errors(bundle) == []


def test_hygiene_allows_docx_template(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/docx/templates/default.docx", b"docx"),))
    assert packaging_checks.sensitive_errors(bundle) == []


def test_hygiene_allows_runtime_binary_extensions(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (
            ("run-frozen.exe", b"exe"),
            ("_internal/a.dll", b"dll"),
            ("_internal/b.pyd", b"pyd"),
            ("_internal/c.ico", b"ico"),
            ("_internal/d.bmp", b"bmp"),
            ("_internal/e.woff2", b"woff"),
            ("_internal/f/METADATA", b"Name: x"),
        ),
    )
    assert packaging_checks.sensitive_errors(bundle) == []


def test_hygiene_allows_certifi_ca_bundle(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/certifi/cacert.pem", b"ca"),))
    assert packaging_checks.sensitive_errors(bundle) == []


def test_hygiene_rejects_other_pem_outside_certifi(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/other/cacert.pem", b"ca"),))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any("other/cacert.pem" in error for error in errors)


def test_hygiene_rejects_nested_launcher_copy(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("run-frozen.exe", b"exe"), ("_internal/copy.exe", b"exe")))
    errors = packaging_checks.sensitive_errors(bundle)
    assert any("copy.exe" in error for error in errors)


def test_hygiene_messages_use_relative_paths(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/a/b/app.log", b"log"),))
    errors = packaging_checks.sensitive_errors(bundle)
    assert errors
    for error in errors:
        assert str(tmp_path) not in error
        assert ":" not in error.split("]")[0].replace("PROHIBITED ", "")
        assert not error.split()[1].startswith("/")


def test_hygiene_rejects_unsafe_path_shapes():
    # ADS, drive prefix, UNC, traversal and trailing dot/space are all rejected.
    for bad in ("_internal/x.txt:secret", "C:/x", "//server/share/x", "../x", "/etc/passwd"):
        assert packaging_checks._unsafe_path_reason(bad) is not None, bad
    assert packaging_checks._trailing_dot_or_space("_internal/engine.pyc.") is True
    assert packaging_checks._trailing_dot_or_space("_internal/name ") is True
    assert packaging_checks._trailing_dot_or_space("_internal/name") is False


def test_hygiene_rejects_symlinked_directory(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("_internal/a.txt", b"a"),))
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.log").write_text("log", encoding="utf-8")
    link = bundle / "_internal" / "linked"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is not permitted on this host")
    with pytest.raises(packaging_checks.ManifestProblem) as excinfo:
        packaging_checks.sensitive_errors(bundle)
    assert excinfo.value.code == packaging_checks.EXIT_UNSAFE_PATH


def test_hygiene_refuses_unstable_walk(tmp_path, monkeypatch):
    bundle = _tmp_runtime(tmp_path, (("_internal/a.txt", b"a"),))
    real_open = builtins.open
    fired = {"done": False}
    target = bundle / "_internal" / "a.txt"

    def mutating_open(file, *args, **kwargs):
        handle = real_open(file, *args, **kwargs)
        if not fired["done"] and Path(file) == target:
            fired["done"] = True
            with real_open(target, "ab") as appender:
                appender.write(b"-mutated")
        return handle

    monkeypatch.setattr(packaging_checks, "open", mutating_open, raising=False)
    with pytest.raises(packaging_checks.ManifestProblem) as excinfo:
        packaging_checks.inventory_files(bundle)
    assert excinfo.value.code == packaging_checks.EXIT_UNSTABLE


def test_verify_inventory_rejects_stale_inventory(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    path = _inventory_path(tmp_path)
    packaging_checks.write_manifest_atomic(path, packaging_checks.build_inventory(bundle))
    (bundle / "b.txt").write_bytes(b"b")
    code, messages = packaging_checks.verify_inventory(bundle, path)
    assert code == packaging_checks.EXIT_INVENTORY_STALE
    assert any("ADDED b.txt" in message for message in messages)


def test_verify_inventory_rejects_malformed_inventory(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    path = _inventory_path(tmp_path)
    path.write_text("{", encoding="utf-8")
    assert packaging_checks.verify_inventory(bundle, path)[0] == packaging_checks.EXIT_INVENTORY


def test_verify_inventory_rejects_bad_self_digest(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    inventory = packaging_checks.build_inventory(bundle)
    inventory["content_sha256"] = "0" * 64
    path = _inventory_path(tmp_path)
    path.write_text(json.dumps(inventory), encoding="utf-8")
    assert packaging_checks.verify_inventory(bundle, path)[0] == packaging_checks.EXIT_INVENTORY


def test_verify_inventory_rejects_unsafe_entries(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    inventory = packaging_checks.build_inventory(bundle)
    inventory["files"].append({"path": "../escape.txt", "size": 1, "sha256": "0" * 64})
    path = _inventory_path(tmp_path)
    path.write_text(json.dumps(inventory), encoding="utf-8")
    assert (
        packaging_checks.verify_inventory(bundle, path)[0]
        == packaging_checks.EXIT_UNSAFE_MANIFEST
    )


def test_hygiene_precedence_over_stale_inventory(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("a.txt", b"a"),))
    path = _inventory_path(tmp_path)
    packaging_checks.write_manifest_atomic(path, packaging_checks.build_inventory(bundle))
    (bundle / "audit.db").write_bytes(b"db")
    code, messages = packaging_checks.verify_inventory(bundle, path)
    assert code == packaging_checks.EXIT_HYGIENE
    assert any("audit.db" in message for message in messages)


def test_hygiene_cli_and_inventory_cli(tmp_path):
    bundle = _tmp_runtime(tmp_path, (("run-frozen.exe", b"exe"),))
    path = _inventory_path(tmp_path)
    hygiene = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), "hygiene", str(bundle)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert hygiene.returncode == 0 and "HYGIENE_OK files=1" in hygiene.stdout
    made = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), "inventory", str(bundle), "--output", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert made.returncode == 0 and "INVENTORY_WRITTEN" in made.stdout
    verified = subprocess.run(
        [
            sys.executable,
            str(CHECKS_MODULE),
            "verify-inventory",
            str(bundle),
            "--inventory",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert verified.returncode == 0 and "INVENTORY_OK" in verified.stdout
    (bundle / ".env").write_bytes(b"x")
    dirty = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), "hygiene", str(bundle)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert dirty.returncode == packaging_checks.EXIT_HYGIENE
    assert "HYGIENE_FAIL count=" in dirty.stdout


def test_bpack01_tree_digest_unchanged(tmp_path):
    bundle = _tmp_runtime(
        tmp_path,
        (("run-frozen.exe", b"exe"), ("_internal/a/b.txt", b"b"), ("_internal/c.dll", b"c")),
    )
    assert packaging_checks.bundle_tree_digest(bundle) == _legacy_tree_digest(bundle)


def test_legacy_and_manifest_exit_codes_preserved(tmp_path):
    contaminated = _tmp_bundle(tmp_path / "bad", dirs=("numpy",))
    completed = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), str(contaminated)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 2
    oversize = _tmp_bundle(tmp_path / "big", files=(("blob.bin", "x" * 100),))
    env = dict(os.environ, ACA_MAX_BUNDLE_BYTES="10")
    completed = subprocess.run(
        [sys.executable, str(CHECKS_MODULE), str(oversize)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert completed.returncode == 3
