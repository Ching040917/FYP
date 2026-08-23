"""Launcher helpers (Phase 2 PoC) — stdlib only."""
import ctypes
import ctypes.wintypes
import json
import logging
import logging.handlers
import os
import tempfile
import time
import urllib.request
from pathlib import Path

APP_NAME = "AcademicComplianceAuditor"
MUTEX_NAME = r"Local\AcademicComplianceAuditor"
INSTANCE_VERSION = 1
PORTS = [8010, 8011, 8012, 8013, 8014, 8015]
HEALTH_TIMEOUT = 15
SHUTDOWN_TIMEOUT = 5
LOG_MAX_BYTES = 1 * 1024 * 1024
LOG_BACKUP_COUNT = 5

_kernel32 = ctypes.windll.kernel32 if os.name == "nt" else None


def get_user_data_root():
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cand = Path(local) / APP_NAME
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".writable_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            for sub in ("poc", "rendered-previews", "logs", "tmp"):
                (cand / sub).mkdir(parents=True, exist_ok=True)
            return cand, False, None
        except Exception:
            pass
    try:
        sess = Path(tempfile.mkdtemp(prefix=f"{APP_NAME}_"))
        for sub in ("poc", "rendered-previews", "logs", "tmp"):
            (sess / sub).mkdir(parents=True, exist_ok=True)
        return sess, True, "Using a temporary data location for this session."
    except Exception:
        fb = Path(tempfile.gettempdir()) / f"{APP_NAME}_fallback"
        fb.mkdir(parents=True, exist_ok=True)
        for sub in ("poc", "rendered-previews", "logs", "tmp"):
            (fb / sub).mkdir(parents=True, exist_ok=True)
        return fb, True, "Using a temporary data location for this session."


def configure_launcher_environment(root: Path):
    db_path = (root / "poc" / "launcher-poc.db").as_posix()
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path}"
    os.environ["PREVIEW_STORAGE_DIR"] = str(root / "rendered-previews")
    os.environ.setdefault("GEMINI_API_KEY", "")


def get_log_dir(root: Path) -> Path:
    return root / "logs"


def get_instance_path(root: Path) -> Path:
    return root / "instance.json"


def setup_launcher_logging(log_dir: Path):
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("launcher")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        fh = logging.handlers.RotatingFileHandler(
            str(log_dir / "launcher.log"),
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(fh)
    return logger


def acquire_mutex():
    if _kernel32 is None:
        return object()
    handle = _kernel32.CreateMutexW(None, True, ctypes.create_unicode_buffer(MUTEX_NAME))
    if not handle:
        return None
    if _kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        _kernel32.CloseHandle(handle)
        return None
    return handle


def release_mutex(handle):
    if _kernel32 is None or not handle:
        return
    try:
        _kernel32.ReleaseMutex(handle)
        _kernel32.CloseHandle(handle)
    except Exception:
        pass


def is_mutex_held() -> bool:
    if _kernel32 is None:
        return False
    h = _kernel32.OpenMutexW(0x0001, False, ctypes.create_unicode_buffer(MUTEX_NAME))
    if h:
        _kernel32.CloseHandle(h)
        return True
    return False


def write_instance(path: Path, pid: int, port: int):
    data = {"version": INSTANCE_VERSION, "pid": pid, "port": port}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def read_instance(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("version") != INSTANCE_VERSION:
        return None
    pid = data.get("pid")
    port = data.get("port")
    if not isinstance(pid, int) or pid <= 0:
        return None
    if not isinstance(port, int) or port not in PORTS:
        return None
    return data


def remove_instance_if_owned(path: Path, pid: int, port: int):
    cur = read_instance(path)
    if cur and cur["pid"] == pid and cur["port"] == port:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


def is_pid_running(pid: int) -> bool:
    if _kernel32 is not None:
        h = _kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return False
        _kernel32.CloseHandle(h)
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def is_executable_match(pid: int) -> bool:
    if _kernel32 is None or os.name != "nt":
        return True
    try:
        h = _kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return False
        buf = ctypes.create_unicode_buffer(1024)
        size = ctypes.wintypes.DWORD(1024)
        ok = _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        _kernel32.CloseHandle(h)
        if not ok:
            return True
        name = buf.value.lower()
        return "run-frozen" in name or "python" in name
    except Exception:
        return True


# ---- Job Object (Windows only; no-op elsewhere) ----
_JOB_KILL_ON_CLOSE = 0x2000


class _JobHandle:
    def __init__(self, handle):
        self.handle = handle

    def close(self):
        if _kernel32 is None or not self.handle:
            return
        try:
            _kernel32.CloseHandle(self.handle)
        except Exception:
            pass
        self.handle = None


def create_job_object(logger=None):
    """Create a Job Object with KILL_ON_JOB_CLOSE. Returns _JobHandle or None."""
    if _kernel32 is None:
        return _JobHandle(None)  # no-op on non-Windows (test double)
    try:
        handle = _kernel32.CreateJobObjectW(None, None)
        if not handle:
            if logger:
                logger.info("job_create_failed err=%s", _kernel32.GetLastError())
            return None

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.wintypes.DWORD),
                ("SchedulingClass", ctypes.wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        ctypes.memset(ctypes.byref(info), 0, ctypes.sizeof(info))
        info.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_CLOSE
        JobExtendedLimitInformation = 9
        ok = _kernel32.SetInformationJobObject(handle, JobExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            if logger:
                logger.info("job_setinfo_failed err=%s", _kernel32.GetLastError())
            _kernel32.CloseHandle(handle)
            return None
        if logger:
            logger.info("job_created handle=%s", handle)
        return _JobHandle(handle)
    except Exception as e:
        if logger:
            logger.info("job_create_exception category=%s", type(e).__name__)
        return None


def assign_process_to_job(job, pid: int, logger=None) -> bool:
    """Assign pid to job. Returns True on success."""
    if _kernel32 is None:
        return True  # no-op on non-Windows
    if job is None or not getattr(job, "handle", None):
        if logger:
            logger.info("job_assign_no_handle pid=%s", pid)
        return False
    try:
        h = _kernel32.OpenProcess(0x001F0FFF, False, pid)  # PROCESS_ALL_ACCESS for job assignment
        if not h:
            if logger:
                logger.info("job_open_process_failed pid=%s err=%s", pid, _kernel32.GetLastError())
            return False
        ok = _kernel32.AssignProcessToJobObject(job.handle, h)
        _kernel32.CloseHandle(h)
        if not ok:
            if logger:
                logger.info("job_assign_failed pid=%s err=%s", pid, _kernel32.GetLastError())
            return False
        if logger:
            logger.info("job_assigned pid=%s", pid)
        return True
    except Exception as e:
        if logger:
            logger.info("job_assign_exception pid=%s category=%s", pid, type(e).__name__)
        return False


def check_health(port: int, timeout: float = 2) -> bool:
    url = f"http://127.0.0.1:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            if r.status != 200:
                return False
            data = json.loads(r.read().decode("utf-8"))
            return data.get("status") == "healthy" and data.get("service") == "academic-compliance-auditor"
    except Exception:
        return False


def is_port_free(port: int) -> bool:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(1)
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


from dataclasses import dataclass as _dataclass

@_dataclass(frozen=True)
class RunningInstance:
    port: int
    pid: int
    url: str

    @classmethod
    def from_port_pid(cls, port: int, pid: int):
        return cls(port=port, pid=pid, url=f"http://127.0.0.1:{port}/dashboard")


def open_browser(port: int, logger=None, opener=None) -> bool:
    url = f"http://127.0.0.1:{port}/dashboard"
    # Injected recorder for automated tests: write URL to file instead of opening browser
    record_file = os.environ.get("ACA_BROWSER_RECORD_FILE")
    if record_file:
        try:
            Path(record_file).write_text(url, encoding="utf-8")
            if logger:
                logger.info("browser_record port=%s url=%s", port, url)
            return True
        except Exception as e:
            if logger:
                logger.info("browser_record_failed port=%s category=%s", port, type(e).__name__)
            return False
    # Disabled browser for automated tests
    if os.environ.get("ACA_DISABLE_BROWSER") == "1":
        if logger:
            logger.info("browser_disabled port=%s url=%s", port, url)
        return True
    fn = opener
    if fn is None:
        try:
            import webbrowser
            fn = webbrowser.open
        except Exception:
            fn = None
    try:
        ok = fn(url) if fn else False
        if logger:
            logger.info("browser_open port=%s result=%s url=%s", port, ok, url)
        return bool(ok)
    except Exception as e:
        if logger:
            logger.info("browser_open_failed port=%s category=%s", port, type(e).__name__)
        return False
