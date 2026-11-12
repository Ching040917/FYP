"""Local DOCX-to-PDF conversion through LibreOffice headless.

Accepts already validated DOCX bytes and returns validated PDF bytes. A
current-user-only temporary directory contains the DOCX, isolated LO profile
and scratch files; cleanup must succeed before any PDF can be returned.
Never log document content, filenames, subprocess output or absolute paths.
"""
import logging
import ctypes
import signal
from contextlib import contextmanager
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

from app import launcher_support

logger = logging.getLogger(__name__)

CONVERT_TIMEOUT_SECONDS = 60

# Windows prefers soffice.com: it is the console launcher and waits for the
# conversion to finish, while soffice.exe detaches and returns immediately.
_SOFFICE_CANDIDATES = (
    r"C:\Program Files\LibreOffice\program\soffice.com",
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.com",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
)

_PDF_MAGIC = b"%PDF"
_PAGE_RE = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")


class DocxConversionError(Exception):
    """Narrow conversion failure with a user-safe category.

    Categories: libreoffice_unavailable | invalid_docx | timeout |
    conversion_failed | invalid_pdf | privacy_failed | cleanup_failed.
    """

    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


def find_soffice() -> str | None:
    """Locate the LibreOffice executable, preferring soffice.com."""
    configured = os.environ.get("SOFFICE_EXECUTABLE")
    if configured and Path(configured).is_file():
        return configured
    for name in ("soffice.com", "soffice"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in _SOFFICE_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    return None


def _job_active_processes(job) -> int:
    class Accounting(ctypes.Structure):
        _fields_ = [
            ("times", ctypes.c_longlong * 4),
            ("page_faults", ctypes.c_ulong),
            ("total", ctypes.c_ulong),
            ("active", ctypes.c_ulong),
            ("terminated", ctypes.c_ulong),
        ]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    query = kernel.QueryInformationJobObject
    query.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                      ctypes.c_ulong, ctypes.c_void_p]
    info = Accounting()
    if not query(job.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
        raise DocxConversionError("cleanup_failed")
    return info.active


def _start_process(args, env):
    """Assign the suspended Windows process before it can create descendants."""
    job = launcher_support.create_job_object() if os.name == "nt" else None
    if os.name == "nt" and job is None:
        raise DocxConversionError("privacy_failed")
    proc = None
    try:
        proc = subprocess.Popen(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env,
            start_new_session=os.name != "nt",
            creationflags=(subprocess.CREATE_NO_WINDOW | 0x00000004) if os.name == "nt" else 0,
        )
        proc._conversion_job = job
        if job is not None:
            if not launcher_support.assign_process_to_job(job, proc.pid):
                raise DocxConversionError("privacy_failed")
            # Popen closes the primary thread handle. Resume the retained process
            # handle only after assignment, so every descendant belongs to our job.
            resume = ctypes.WinDLL("ntdll").NtResumeProcess
            resume.argtypes = [ctypes.c_void_p]
            resume.restype = ctypes.c_long
            if resume(int(proc._handle)) != 0:
                raise DocxConversionError("privacy_failed")
        return proc
    except BaseException:
        if proc is not None:
            proc.kill()
            proc.communicate(timeout=10)
            _close_process(proc)
        elif job is not None:
            job.close()
        raise


def _wait_process_tree(proc, *, terminate=False) -> None:
    job = getattr(proc, "_conversion_job", None)
    if job is None:
        return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    stop = kernel.TerminateJobObject
    stop.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    if terminate and not stop(job.handle, 1):
        raise DocxConversionError("cleanup_failed")
    deadline = time.monotonic() + 10
    while _job_active_processes(job):
        if time.monotonic() >= deadline:
            logger.warning("conversion process_tree_survived")
            raise DocxConversionError("cleanup_failed")
        time.sleep(0.05)


def _close_process(proc) -> None:
    job = getattr(proc, "_conversion_job", None)
    if job is not None:
        job.close()
        proc._conversion_job = None
    for stream in (getattr(proc, "stdout", None), getattr(proc, "stderr", None)):
        if stream is not None:
            stream.close()
    handle = getattr(proc, "_handle", None)
    if os.name == "nt" and handle is not None:
        handle.Close()


def _kill_process_tree(proc) -> None:
    """Terminate only the retained conversion job/session, then confirm exit."""
    if os.name == "nt":
        _wait_process_tree(proc, terminate=True)
    else:
        os.killpg(proc.pid, signal.SIGKILL)
    proc.communicate(timeout=10)


def _profile_uri(path: Path) -> str:
    uri = path.resolve().as_uri()
    parsed = urlsplit(uri)
    if (parsed.scheme != "file" or parsed.netloc or
            Path(url2pathname(parsed.path)).resolve() != path.resolve()):
        raise DocxConversionError("privacy_failed")
    return uri


def _remove_workdir(workdir: Path) -> None:
    """Retry transient Windows locks, without ever declaring residue a pass."""
    for attempt, delay in enumerate((0, 0.05, 0.1, 0.2, 0.4), 1):
        if delay:
            time.sleep(delay)
        try:
            source = workdir / "input" / "document.docx"
            source.unlink(missing_ok=True)
            for name in ("input", "output", "libreoffice-profile"):
                child = workdir / name
                if child.exists():
                    shutil.rmtree(child)
            # Also removes scratch files created by LibreOffice in its TEMP.
            if workdir.exists():
                shutil.rmtree(workdir)
            if os.path.lexists(workdir):
                raise OSError("Conversion directory remains")
            logger.info("conversion cleanup attempt=%d result=removed", attempt)
            return
        except OSError:
            logger.warning("conversion cleanup attempt=%d result=retry", attempt)
    raise DocxConversionError("cleanup_failed") from None


@contextmanager
def _windows_user_descriptor():
    """Reuse launcher native bindings, but grant access ONLY to this user."""
    with launcher_support._startup_windows_descriptor() as (kernel, advapi, owner):
        user = launcher_support._startup_windows_sddl(kernel, advapi, owner, 1)[2:]
        descriptor = ctypes.c_void_p()
        sddl = f"O:{user}D:P(A;OICI;FA;;;{user})"
        try:
            if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl, 1, ctypes.byref(descriptor), None):
                raise OSError("Private conversion permissions unavailable")
            yield kernel, advapi, descriptor
        finally:
            if descriptor:
                kernel.LocalFree(descriptor)


def _windows_private_directory(path: Path, *, create: bool) -> None:
    with _windows_user_descriptor() as (kernel, advapi, descriptor):
        if create:
            class SecurityAttributes(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_ulong), ("descriptor", ctypes.c_void_p),
                    ("inherit", ctypes.c_int),
                ]
            attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, 0)
            kernel.CreateDirectoryW.argtypes = [
                ctypes.c_wchar_p, ctypes.POINTER(SecurityAttributes),
            ]
            if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
                if ctypes.get_last_error() == 183:
                    raise FileExistsError("Private conversion directory already exists")
                raise OSError("Private conversion directory unavailable")
        else:
            actual = ctypes.c_void_p()
            try:
                if advapi.GetNamedSecurityInfoW(
                        str(path), 1, 5, None, None, None, None, ctypes.byref(actual)):
                    raise OSError("Private conversion permissions unavailable")
                actual_sddl = launcher_support._startup_windows_sddl(
                    kernel, advapi, actual).replace("D:PAI", "D:P")
                if actual_sddl != launcher_support._startup_windows_sddl(
                        kernel, advapi, descriptor):
                    raise OSError("Conversion directory is not private")
            finally:
                if actual:
                    kernel.LocalFree(actual)


@contextmanager
def _private_workdir():
    workdir = None
    try:
        try:
            if os.name == "nt":
                for _ in range(16):
                    candidate = Path(tempfile.gettempdir()) / f"docx2pdf_{uuid.uuid4().hex}"
                    try:
                        _windows_private_directory(candidate, create=True)
                    except FileExistsError:
                        continue
                    workdir = candidate
                    break
                if workdir is None:
                    raise OSError("Private conversion directory unavailable")
            else:
                workdir = Path(tempfile.mkdtemp(prefix="docx2pdf_"))
            # Pin against rename/reparse replacement while LibreOffice runs.
            scope = launcher_support._startup_directory(
                workdir, private=os.name != "nt")
            with scope:
                if os.name == "nt":
                    _windows_private_directory(workdir, create=False)
                yield workdir
        except OSError:
            raise DocxConversionError("privacy_failed") from None
        except DocxConversionError:
            raise
        except Exception:
            raise DocxConversionError("conversion_failed") from None
    finally:
        if workdir is not None:
            _remove_workdir(workdir)


def convert_docx_to_pdf(docx_bytes: bytes) -> bytes:
    """Convert validated DOCX bytes; fail closed if privacy or cleanup fails.

    Cancellation/BaseException during the synchronous subprocess wait also
    stops the process tree and removes its files before propagating.
    """
    if not docx_bytes or not docx_bytes.startswith(b"PK"):
        raise DocxConversionError("invalid_docx")
    executable = find_soffice()
    if not executable:
        raise DocxConversionError("libreoffice_unavailable")

    started = time.perf_counter()
    with _private_workdir() as workdir:
        input_dir = workdir / "input"
        output_dir = workdir / "output"
        profile_dir = workdir / "libreoffice-profile"
        for directory in (input_dir, output_dir, profile_dir):
            directory.mkdir()
        src = input_dir / "document.docx"
        with src.open("xb") as handle:
            handle.write(docx_bytes)
        args = [
            executable, "--headless", "--nologo", "--nodefault",
            "--nofirststartwizard", "--nolockcheck",
            f"-env:UserInstallation={_profile_uri(profile_dir)}",
            "--convert-to", "pdf:writer_pdf_Export", "--outdir", str(output_dir),
            str(src),
        ]
        env = dict(os.environ, TEMP=str(workdir), TMP=str(workdir), TMPDIR=str(workdir))
        proc = _start_process(args, env)
        try:
            try:
                stdout, stderr = proc.communicate(timeout=CONVERT_TIMEOUT_SECONDS)
                _wait_process_tree(proc)
            except BaseException as exc:
                try:
                    _kill_process_tree(proc)
                except Exception:
                    logger.warning("conversion process_cleanup_failed")
                    raise DocxConversionError("cleanup_failed") from None
                if isinstance(exc, subprocess.TimeoutExpired):
                    logger.warning("conversion timeout pdf_produced=%s",
                                   (output_dir / "document.pdf").is_file())
                    raise DocxConversionError("timeout") from None
                raise
            # Provider output may contain paths or document content: capture it
            # for draining, but record only bounded operational measurements.
            logger.info("conversion process_exit code=%d stdout_bytes=%d stderr_bytes=%d",
                        proc.returncode, len(stdout or b""), len(stderr or b""))
            if proc.returncode != 0:
                raise DocxConversionError("conversion_failed")
        finally:
            _close_process(proc)
        pdf = output_dir / "document.pdf"
        if not pdf.is_file():
            raise DocxConversionError("conversion_failed")
        output_stat = pdf.lstat()
        launcher_support._startup_check_stat(output_stat)
        if output_stat.st_nlink != 1:
            raise DocxConversionError("privacy_failed")
        pdf_bytes = pdf.read_bytes()
        page_count = len(_PAGE_RE.findall(pdf_bytes))
        if not pdf_bytes.startswith(_PDF_MAGIC) or page_count < 1:
            raise DocxConversionError("invalid_pdf")
    # The context has verified deletion before announcing success or returning.
    logger.info("conversion ok duration_ms=%d pages=%d",
                int((time.perf_counter() - started) * 1000), page_count)
    return pdf_bytes
