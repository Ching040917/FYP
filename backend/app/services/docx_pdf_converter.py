"""Local DOCX-to-PDF conversion through LibreOffice headless.

Read-only PoC service: accepts DOCX bytes, returns validated PDF bytes.
Nothing is persisted; temp working dir and isolated LO profile are always
deleted. Never log document content, filenames, or absolute temp paths.
"""
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

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
    conversion_failed | invalid_pdf.
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


def _kill_process_tree(proc) -> None:
    """Terminate the conversion process and its children only."""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
            )
        else:
            proc.kill()
    except Exception:  # pragma: no cover - best effort
        logger.warning("failed to terminate timed-out conversion process")


def convert_docx_to_pdf(docx_bytes: bytes) -> bytes:
    """Convert DOCX bytes to validated PDF bytes.

    Raises DocxConversionError with a user-safe category on any failure.
    """
    if not docx_bytes or not docx_bytes.startswith(b"PK"):
        raise DocxConversionError("invalid_docx")

    executable = find_soffice()
    if not executable:
        raise DocxConversionError("libreoffice_unavailable")

    started = time.perf_counter()
    workdir = tempfile.mkdtemp(prefix="docx2pdf_")
    try:
        profile_dir = Path(workdir) / "lo_profile"
        src = Path(workdir) / f"{uuid.uuid4().hex}.docx"
        src.write_bytes(docx_bytes)
        args = [
            executable,
            "--headless",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
            workdir,
            f"-env:UserInstallation={profile_dir.as_uri()}",
            str(src),
        ]
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            proc.communicate(timeout=CONVERT_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            _kill_process_tree(proc)
            try:
                proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            logger.warning(
                "conversion timeout duration_ms=%d",
                int((time.perf_counter() - started) * 1000),
            )
            raise DocxConversionError("timeout")

        duration_ms = int((time.perf_counter() - started) * 1000)
        if proc.returncode != 0:
            logger.warning("conversion failed duration_ms=%d", duration_ms)
            raise DocxConversionError("conversion_failed")

        pdfs = list(Path(workdir).glob("*.pdf"))
        if not pdfs:
            logger.warning("conversion failed no_output duration_ms=%d", duration_ms)
            raise DocxConversionError("conversion_failed")
        pdf_bytes = pdfs[0].read_bytes()
        page_count = len(_PAGE_RE.findall(pdf_bytes))
        if not pdf_bytes.startswith(_PDF_MAGIC) or page_count < 1:
            logger.warning("conversion invalid_pdf duration_ms=%d", duration_ms)
            raise DocxConversionError("invalid_pdf")

        logger.info("conversion ok duration_ms=%d pages=%d", duration_ms, page_count)
        return pdf_bytes
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
