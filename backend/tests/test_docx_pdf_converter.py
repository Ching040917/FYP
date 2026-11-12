"""Focused tests for the LibreOffice DOCX-to-PDF conversion service.

LibreOffice itself is never required: subprocess.Popen is faked for unit
tests; one optional integration test runs only when soffice is installed.
"""
import asyncio
import os
import io
import subprocess
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

import pytest
from docx import Document

from app.services.docx_pdf_converter import (
    DocxConversionError,
    convert_docx_to_pdf,
    find_soffice,
    _SOFFICE_CANDIDATES,
    _PAGE_RE,
)


def _pdf_bytes(pages=1):
    body = b"".join(
        b"%d 0 obj\n<< /Type /Page >>\nendobj\n" % i for i in range(pages)
    )
    return b"%PDF-1.4\n" + body + b"%%EOF"


class FakePopen:
    """Records invocations; writes a PDF into the --outdir when successful."""

    calls = []

    def __init__(self, args, **kwargs):
        FakePopen.calls.append(args)
        self.args = args
        self.pid = 4242
        self.kwargs = kwargs
        directory = Path(args[args.index("--outdir") + 1])
        uri = next(a.split("=", 1)[1] for a in args if a.startswith("-env:UserInstallation="))
        profile = Path(url2pathname(urlsplit(uri).path))
        (profile / "registrymodifications.xcu").write_bytes(b"synthetic profile")
        (directory / "scratch.tmp").write_bytes(b"synthetic scratch")
        self.returncode = getattr(FakePopen, "returncode", 0)
        self.pdf_bytes = getattr(FakePopen, "pdf_bytes", None)
        self.write_pdf = getattr(FakePopen, "write_pdf", True)
        self.timeout_error = getattr(FakePopen, "timeout_error", False)

    def communicate(self, timeout=None):
        if self.timeout_error:
            raise subprocess.TimeoutExpired(self.args, timeout)
        if self.write_pdf:
            outdir = self.args[self.args.index("--outdir") + 1]
            Path(outdir, "document.pdf").write_bytes(
                self.pdf_bytes or _pdf_bytes()
            )
        return b"", b""
    def kill(self):
        self.timeout_error = False
        self.write_pdf = False
        self.returncode = -9


@pytest.fixture
def fake_popen(monkeypatch):
    FakePopen.calls = []
    for name in ("returncode", "pdf_bytes", "write_pdf", "timeout_error"):
        try:
            delattr(FakePopen, name)
        except AttributeError:
            pass
    monkeypatch.setattr("app.services.docx_pdf_converter.find_soffice", lambda: "fake-soffice")

    def stop(proc):
        proc.kill()
        proc.communicate(timeout=10)
    monkeypatch.setattr("app.services.docx_pdf_converter._kill_process_tree", stop)
    monkeypatch.setattr("app.services.docx_pdf_converter.subprocess.Popen", FakePopen)
    monkeypatch.setattr("app.services.docx_pdf_converter._start_process",
                        lambda args, env: subprocess.Popen(args, env=env))
    return FakePopen


def _track_mkdtemp(monkeypatch, root: Path):
    """Keep native private-directory creation active, under an isolated parent."""
    monkeypatch.setattr(tempfile, "tempdir", str(root))


def _real_docx_bytes():
    doc = Document()
    doc.add_paragraph("Body text.")
    t = doc.add_table(rows=2, cols=2)
    t.rows[0].cells[0].text = "A"
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 1. LibreOffice executable discovery
# ---------------------------------------------------------------------------

def test_discovery_configured_path(monkeypatch, tmp_path):
    exe = tmp_path / "soffice.com"
    exe.write_bytes(b"")
    monkeypatch.setenv("SOFFICE_EXECUTABLE", str(exe))
    assert find_soffice() == str(exe)


def test_discovery_path_lookup(monkeypatch, tmp_path):
    exe = tmp_path / "soffice.exe"
    exe.write_bytes(b"")
    monkeypatch.delenv("SOFFICE_EXECUTABLE", raising=False)
    monkeypatch.setattr("app.services.docx_pdf_converter.shutil.which",
                        lambda name: str(exe) if name == "soffice.com" else None)
    assert find_soffice() == str(exe)


def test_discovery_prefers_soffice_com(monkeypatch, tmp_path):
    com = tmp_path / "soffice.com"
    exe = tmp_path / "soffice.exe"
    com.write_bytes(b"")
    exe.write_bytes(b"")
    monkeypatch.delenv("SOFFICE_EXECUTABLE", raising=False)
    monkeypatch.setattr("app.services.docx_pdf_converter.shutil.which", lambda name: None)
    monkeypatch.setattr("app.services.docx_pdf_converter._SOFFICE_CANDIDATES",
                        (str(com), str(exe)))
    assert find_soffice() == str(com)


def test_discovery_uses_fixed_candidates(monkeypatch, tmp_path):
    exe = tmp_path / "soffice.com"
    exe.write_bytes(b"")
    monkeypatch.delenv("SOFFICE_EXECUTABLE", raising=False)
    monkeypatch.setattr("app.services.docx_pdf_converter.shutil.which", lambda name: None)
    monkeypatch.setattr("app.services.docx_pdf_converter._SOFFICE_CANDIDATES",
                        (str(exe), str(tmp_path / "missing.com")))
    assert find_soffice() == str(exe)


def test_discovery_none_available(monkeypatch):
    monkeypatch.delenv("SOFFICE_EXECUTABLE", raising=False)
    monkeypatch.setattr("app.services.docx_pdf_converter.shutil.which", lambda name: None)
    monkeypatch.setattr("app.services.docx_pdf_converter._SOFFICE_CANDIDATES", ())
    assert find_soffice() is None


# ---------------------------------------------------------------------------
# 2-5. Conversion outcomes
# ---------------------------------------------------------------------------

def test_successful_conversion(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    result = convert_docx_to_pdf(_real_docx_bytes())
    assert result.startswith(b"%PDF")


def test_conversion_uses_random_internal_filename(fake_popen):
    convert_docx_to_pdf(_real_docx_bytes())
    src = Path(FakePopen.calls[0][-1])
    assert src.suffix == ".docx"
    assert src.name.startswith(".") is False  # user filename never involved


def test_invalid_docx_rejected():
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(b"not a zip file at all")
    assert exc.value.category == "invalid_docx"


def test_empty_input_rejected():
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(b"")
    assert exc.value.category == "invalid_docx"


# ---------------------------------------------------------------------------
# 6-9. Failure categories
# ---------------------------------------------------------------------------

def test_timeout_simulated(fake_popen, monkeypatch):
    fake_popen.timeout_error = True
    killed = []
    monkeypatch.setattr(
        "app.services.docx_pdf_converter._kill_process_tree",
        lambda proc: killed.append(proc),
    )
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(_real_docx_bytes())
    assert exc.value.category == "timeout"
    assert len(killed) == 1


def test_nonzero_exit_code(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    fake_popen.returncode = 1
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(_real_docx_bytes())
    assert exc.value.category == "conversion_failed"


def test_missing_pdf_output(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    fake_popen.write_pdf = False
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(_real_docx_bytes())
    assert exc.value.category == "conversion_failed"


def test_invalid_pdf_magic(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    fake_popen.pdf_bytes = b"NOTAPDF"
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(_real_docx_bytes())
    assert exc.value.category == "invalid_pdf"


def test_libreoffice_unavailable(monkeypatch):
    monkeypatch.setattr("app.services.docx_pdf_converter.find_soffice",
                        lambda: None)
    with pytest.raises(DocxConversionError) as exc:
        convert_docx_to_pdf(_real_docx_bytes())
    assert exc.value.category == "libreoffice_unavailable"


# ---------------------------------------------------------------------------
# 10. Concurrency: isolated profiles and outdirs
# ---------------------------------------------------------------------------

def test_concurrent_conversions_use_isolated_profiles(fake_popen):
    results = []

    def work(_):
        results.append(convert_docx_to_pdf(_real_docx_bytes()))

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(work, range(6)))

    profiles = set()
    outdirs = set()
    for args in FakePopen.calls:
        profiles.add(next(a for a in args if a.startswith("-env:UserInstallation=")))
        outdirs.add(args[args.index("--outdir") + 1])
    assert len(profiles) == 6
    assert all(not Path(directory).exists() for directory in outdirs)
    assert len(outdirs) == 6
    assert all(r.startswith(b"%PDF") for r in results)


# ---------------------------------------------------------------------------
# 11-12. Cleanup on success and every failure path
# ---------------------------------------------------------------------------

def test_cleanup_after_success(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    assert convert_docx_to_pdf(_real_docx_bytes()).startswith(b"%PDF")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("setup", [
    {"write_pdf": False},
    {"pdf_bytes": b"garbage"},
    {"returncode": 3},
    {"timeout_error": True},
])
def test_cleanup_after_every_failure(fake_popen, monkeypatch, tmp_path, setup):
    _track_mkdtemp(monkeypatch, tmp_path)
    for attr, value in setup.items():
        setattr(fake_popen, attr, value)
    with pytest.raises(DocxConversionError):
        convert_docx_to_pdf(_real_docx_bytes())
    assert list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# 13. Non-ASCII temporary parent directory
# ---------------------------------------------------------------------------

def test_non_ascii_temp_parent(fake_popen, monkeypatch, tmp_path):
    exotic = tmp_path / "Tëst 目录"
    exotic.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(exotic))
    result = convert_docx_to_pdf(_real_docx_bytes())
    assert result.startswith(b"%PDF")


# ---------------------------------------------------------------------------
# 14. Logs never leak content or absolute paths
# ---------------------------------------------------------------------------

def test_logs_do_not_leak_content_or_paths(fake_popen, monkeypatch, caplog, tmp_path):
    import logging
    caplog.set_level(logging.INFO)
    parent = tmp_path / "unused"
    parent.mkdir(exist_ok=True)
    _track_mkdtemp(monkeypatch, parent)
    fake_popen.pdf_bytes = _pdf_bytes()
    assert convert_docx_to_pdf(b"PK\x03\x04SUPER_SECRET_DOCUMENT").startswith(b"%PDF")
    fake_popen.write_pdf = False
    with pytest.raises(DocxConversionError):
        convert_docx_to_pdf(b"PK\x03\x04SUPER_SECRET_DOCUMENT")
    text = caplog.text.lower()
    assert "super_secret" not in text
    assert "secret" not in text
    assert "docx2pdf" not in text


# ---------------------------------------------------------------------------
# Integration: real LibreOffice when installed
# ---------------------------------------------------------------------------

@pytest.mark.skipif(find_soffice() is None, reason="LibreOffice not installed")
def test_real_conversion_with_tables_and_figures(docx_factory):
    before = {p.name for p in Path(tempfile.gettempdir()).glob("docx2pdf_*")}
    file_bytes = docx_factory(
        paragraphs=["Body text.", "More text."],
        references=[],
        tables=[[["A", "B"], ["1", "2"]], [["C", "D"], ["3", "4"]]],
        images=1,
    )
    pdf = convert_docx_to_pdf(file_bytes)
    assert pdf.startswith(b"%PDF")
    assert len(_PAGE_RE.findall(pdf)) >= 1
    after = {p.name for p in Path(tempfile.gettempdir()).glob("docx2pdf_*")}
    assert after == before


def test_private_permissions_failure_prevents_source_write(fake_popen, monkeypatch, tmp_path):
    from contextlib import contextmanager
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)

    @contextmanager
    def denied(*args, **kwargs):
        raise OSError("PRIVATE_PATH_AND_CONTENT")
        yield

    monkeypatch.setattr(converter.launcher_support, "_startup_directory", denied)
    with pytest.raises(DocxConversionError) as caught:
        convert_docx_to_pdf(_real_docx_bytes())
    assert caught.value.category == "privacy_failed"
    assert FakePopen.calls == []
    assert list(tmp_path.iterdir()) == []
    assert str(caught.value) == "privacy_failed"


@pytest.mark.parametrize("error", [KeyboardInterrupt, SystemExit, asyncio.CancelledError])
def test_cleanup_and_process_stop_on_base_exception(fake_popen, monkeypatch, tmp_path, error):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    stopped = []
    original_error = error()

    def interrupted(self, timeout=None):
        raise original_error

    monkeypatch.setattr(FakePopen, "communicate", interrupted)
    monkeypatch.setattr(converter, "_kill_process_tree", lambda proc: stopped.append(proc))
    with pytest.raises(error) as caught:
        convert_docx_to_pdf(_real_docx_bytes())
    assert caught.value is original_error
    assert len(stopped) == 1
    assert list(tmp_path.iterdir()) == []


def test_spawn_failure_cleans_private_source(fake_popen, monkeypatch, tmp_path):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    seen = []

    def cannot_start(args, **kwargs):
        seen.append(Path(args[-1]))
        assert seen[-1].read_bytes().startswith(b"PK")
        raise OSError("PRIVATE_PATH")

    monkeypatch.setattr(converter.subprocess, "Popen", cannot_start)
    with pytest.raises(DocxConversionError):
        convert_docx_to_pdf(_real_docx_bytes())
    assert len(seen) == 1
    assert list(tmp_path.iterdir()) == []


def test_failed_cleanup_never_returns_pdf(fake_popen, monkeypatch, tmp_path, caplog):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    real_rmtree = converter.shutil.rmtree
    remaining = []

    def locked(path, **kwargs):
        remaining.append(path)
        raise OSError("PRIVATE_PATH_AND_CONTENT")

    with monkeypatch.context() as patch:
        patch.setattr(converter.shutil, "rmtree", locked)
        with pytest.raises(DocxConversionError) as caught:
            convert_docx_to_pdf(_real_docx_bytes())
    try:
        assert caught.value.category == "cleanup_failed"
        assert str(caught.value) == "cleanup_failed"
        assert "PRIVATE_PATH_AND_CONTENT" not in caplog.text
        assert "conversion ok" not in caplog.text
        assert len(remaining) == 5
        assert all(path == tmp_path / path.relative_to(tmp_path).parts[0] / "input"
                   for path in remaining)
    finally:
        for path in tmp_path.iterdir():
            real_rmtree(path)


def test_silent_cleanup_failure_is_detected(fake_popen, monkeypatch, tmp_path):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    real_rmtree = converter.shutil.rmtree
    with monkeypatch.context() as patch:
        patch.setattr(converter.shutil, "rmtree", lambda *args, **kwargs: None)
        with pytest.raises(DocxConversionError) as caught:
            convert_docx_to_pdf(_real_docx_bytes())
    try:
        assert caught.value.category == "cleanup_failed"
    finally:
        for path in tmp_path.iterdir():
            real_rmtree(path)


def test_process_cleanup_failure_discards_pdf_and_cleans_source(fake_popen, monkeypatch, tmp_path):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    fake_popen.timeout_error = True

    def cannot_stop(proc):
        raise subprocess.TimeoutExpired("PRIVATE_COMMAND", 10)

    monkeypatch.setattr(converter, "_kill_process_tree", cannot_stop)
    with pytest.raises(DocxConversionError) as caught:
        convert_docx_to_pdf(_real_docx_bytes())
    assert caught.value.category == "cleanup_failed"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.skipif(os.name != "nt", reason="Windows native DACL")
def test_windows_private_directory_grants_only_current_user(tmp_path):
    from app.services import docx_pdf_converter as converter
    with converter._windows_user_descriptor() as (kernel, advapi, descriptor):
        sddl = converter.launcher_support._startup_windows_sddl(kernel, advapi, descriptor)
    assert sddl.count("(A;") == 1
    assert ";;;SY)" not in sddl
    assert ";;;BA)" not in sddl
    directory = tmp_path / "private"
    converter._windows_private_directory(directory, create=True)
    try:
        converter._windows_private_directory(directory, create=False)
    finally:
        directory.rmdir()


def test_partial_docx_write_failure_cleans_private_directory(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    original_open = Path.open

    def disk_full(path, mode="r", *args, **kwargs):
        if path.suffix == ".docx" and mode == "xb":
            with original_open(path, mode, *args, **kwargs) as handle:
                handle.write(b"partial synthetic DOCX")
            raise OSError("PRIVATE_TEMP_PATH")
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", disk_full)
    with pytest.raises(DocxConversionError) as caught:
        convert_docx_to_pdf(_real_docx_bytes())
    assert caught.value.category == "privacy_failed"
    assert FakePopen.calls == []
    assert list(tmp_path.iterdir()) == []


def test_profile_uri_roundtrips_spaces_and_unicode(tmp_path):
    from app.services import docx_pdf_converter as converter
    profile = tmp_path / "Tëst 目录" / "libreoffice-profile"
    uri = converter._profile_uri(profile)
    assert uri.startswith("file:///")
    assert " " not in uri
    assert Path(url2pathname(urlsplit(uri).path)) == profile.resolve()


def test_profile_delete_retries_transient_lock(fake_popen, monkeypatch, tmp_path, caplog):
    from app.services import docx_pdf_converter as converter
    _track_mkdtemp(monkeypatch, tmp_path)
    remove = converter.shutil.rmtree
    attempts = []

    def temporarily_locked(path, **kwargs):
        if Path(path).name == "libreoffice-profile":
            attempts.append(path)
            if len(attempts) < 3:
                raise PermissionError("PRIVATE_PROFILE_PATH")
        return remove(path, **kwargs)

    monkeypatch.setattr(converter.shutil, "rmtree", temporarily_locked)
    assert convert_docx_to_pdf(_real_docx_bytes()) == _pdf_bytes()
    assert len(attempts) == 3
    assert list(tmp_path.iterdir()) == []
    assert "PRIVATE_PROFILE_PATH" not in caplog.text


def test_private_layout_and_expected_pdf(fake_popen, monkeypatch, tmp_path):
    _track_mkdtemp(monkeypatch, tmp_path)
    assert convert_docx_to_pdf(_real_docx_bytes()) == _pdf_bytes()
    args = FakePopen.calls[0]
    source = Path(args[-1])
    assert source.parts[-2:] == ("input", "document.docx")
    output = Path(args[args.index("--outdir") + 1])
    assert output == source.parent.parent / "output"
    uri = next(arg.split("=", 1)[1] for arg in args if arg.startswith("-env:UserInstallation="))
    assert Path(url2pathname(urlsplit(uri).path)) == source.parent.parent / "libreoffice-profile"
    assert list(tmp_path.iterdir()) == []


def test_real_timeout_stops_exact_conversion_tree():
    import sys
    from app.services import docx_pdf_converter as converter
    command = [
        sys.executable, "-c",
        "import subprocess,sys,time; "
        "subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
        "print('child created',flush=True);time.sleep(60)",
    ]
    proc = converter._start_process(command, os.environ.copy())
    try:
        assert proc.stdout.readline().strip() == b"child created"
        with pytest.raises(subprocess.TimeoutExpired):
            proc.communicate(timeout=0.1)
        converter._kill_process_tree(proc)
        assert proc.returncode != 0
        if os.name == "nt":
            assert converter._job_active_processes(proc._conversion_job) == 0
    finally:
        if proc.poll() is None:
            converter._kill_process_tree(proc)
        converter._close_process(proc)


def test_start_process_does_not_inherit_locked_parent_stdin():
    import sys
    from pathlib import Path as _Path
    backend_dir = _Path(__file__).resolve().parents[1]
    child_code = (
        "import os, sys, threading; "
        "threading.Thread(target=lambda: sys.stdin.read(), daemon=True).start(); "
        "from app.services import docx_pdf_converter as c; "
        "p = c._start_process([sys.executable, '-c', 'import sys; print(len(sys.stdin.read()), flush=True)'], os.environ.copy()); "
        "out, _ = p.communicate(timeout=5); "
        "c._wait_process_tree(p); "
        "c._close_process(p); "
        "assert out.strip() == b'0' and p.returncode == 0"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", child_code],
        cwd=str(backend_dir),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        out, err = proc.communicate(timeout=15)
        assert proc.returncode == 0, err.decode(errors="replace")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate(timeout=5)
