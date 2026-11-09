"""Launcher helpers (Phase 2 PoC) — stdlib only."""
import ctypes
import ctypes.wintypes
import json
import logging
import logging.handlers
import os
import sys
import tempfile
import time
import urllib.parse
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
_user32 = ctypes.windll.user32 if os.name == "nt" else None

MB_OK = 0x00000000
MB_ICONERROR = 0x00000010
MB_ICONINFORMATION = 0x00000040


def is_packaged_windows() -> bool:
    return os.name == "nt" and bool(getattr(sys, "frozen", False))


def _safe_log(logger, level: int, msg: str, *args, **kwargs):
    if logger is None:
        return
    try:
        logger.log(level, msg, *args, **kwargs)
    except Exception:
        pass


class _SafeLogger(logging.LoggerAdapter):
    """Keep launcher dependency logging from interrupting startup."""

    def log(self, level, msg, *args, **kwargs):
        _safe_log(self.logger, level, msg, *args, **kwargs)


def validate_loopback_dashboard_url(url: str) -> bool:
    if not isinstance(url, str):
        return False
    try:
        if not url:
            return False
        parts = urllib.parse.urlsplit(url)
        port = parts.port
        if (
            parts.scheme != "http"
            or parts.username is not None
            or parts.password is not None
            or parts.hostname != "127.0.0.1"
            or port not in PORTS
            or parts.path != "/dashboard"
            or urllib.parse.unquote(parts.path) != "/dashboard"
            or parts.query
            or parts.fragment
        ):
            return False
        expected = "http" + "://" + "127.0.0.1" + ":" + str(port) + "/dashboard"
        return url == expected
    except (TypeError, ValueError, UnicodeError):
        return False


class DialogState:
    __slots__ = ("fatal_shown", "notice_shown")

    def __init__(self):
        self.fatal_shown = False
        self.notice_shown = False


def _show_dialog(title: str, message: str, flags: int, logger=None, state=None) -> bool:
    if not is_packaged_windows() or _user32 is None:
        return False
    if state is not None:
        category = "fatal_shown" if flags & MB_ICONERROR else "notice_shown"
        if getattr(state, category):
            return False
        setattr(state, category, True)
    try:
        ret = _user32.MessageBoxW(0, str(message), str(title), flags)
        if ret == 0:
            _safe_log(logger, logging.WARNING, "dialog_call_failed title=%s", title)
            return False
        return True
    except Exception as exc:
        _safe_log(logger, logging.WARNING, "dialog_call_exception title=%s error=%s", title, type(exc).__name__)
        return False


def show_startup_error(message: str, title: str = "Academic Compliance Auditor", state: DialogState | None = None, logger=None) -> bool:
    return _show_dialog(title, message, MB_OK | MB_ICONERROR, logger=logger, state=state)


def show_startup_notice(message: str, title: str = "Academic Compliance Auditor", state: DialogState | None = None, logger=None) -> bool:
    return _show_dialog(title, message, MB_OK | MB_ICONINFORMATION, logger=logger, state=state)

class RootResolutionError(RuntimeError):
    """Raised when canonical user data root cannot be safely resolved or validated."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ApprovedRoot:
    __slots__ = ("path", "dev", "ino")

    def __init__(self, path: Path, dev: int, ino: int):
        self.path = path
        self.dev = dev
        self.ino = ino

    def __iter__(self):
        return iter((self.path, self.dev, self.ino))


def get_user_data_root(candidate: Path | str | None = None) -> ApprovedRoot:
    """Resolve and validate the canonical user data root.

    Creates only the canonical product root on valid first run. Eliminates
    all temporary, HOME, and CWD fallbacks, and fails closed when the durable
    root cannot be safely verified.
    """
    if candidate is None:
        override_env = os.environ.get("ACA_USER_DATA_DIR")
        if override_env and override_env.strip():
            candidate = override_env.strip()
        else:
            local = os.environ.get("LOCALAPPDATA")
            if not local or not local.strip():
                raise RootResolutionError("missing_localappdata", "LOCALAPPDATA environment variable is missing or empty.")
            cand_local = Path(local.strip())
            if not cand_local.is_absolute():
                raise RootResolutionError("relative_localappdata", "LOCALAPPDATA must be an absolute path.")
            candidate = cand_local / APP_NAME

    p = Path(candidate)
    if not p.is_absolute():
        raise RootResolutionError("relative_candidate_root", "User data root must be an absolute path.")

    norm_path = p.resolve()
    parent = norm_path.parent
    if not parent.exists():
        raise RootResolutionError("missing_parent_directory", "Parent directory for user data root does not exist.")
    if not parent.is_dir() or parent.is_symlink():
        raise RootResolutionError("invalid_parent_directory", "Parent directory is not a real directory or is a symlink.")

    if norm_path.exists():
        if norm_path.is_file():
            raise RootResolutionError("root_is_a_file", "User data root path is an existing regular file.")
        if norm_path.is_symlink() or not norm_path.is_dir():
            raise RootResolutionError("root_not_a_dir", "User data root path is a symlink, reparse point, or not a directory.")
    else:
        try:
            norm_path.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise RootResolutionError("root_creation_failed", f"Could not create canonical user data root: {type(e).__name__}")

    probe = norm_path / ".writable_probe"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except Exception as e:
        raise RootResolutionError("root_unwritable", f"Canonical user data root is not writable: {type(e).__name__}")

    try:
        st = os.lstat(norm_path)
    except OSError as e:
        raise RootResolutionError("root_stat_failed", f"Failed to stat canonical user data root: {type(e).__name__}")

    if norm_path.is_symlink() or not norm_path.is_dir():
        raise RootResolutionError("root_symlink_or_non_dir", "Canonical user data root is a symlink or non-directory.")

    dev = st.st_dev
    ino = st.st_ino
    if dev == 0 or ino == 0:
        raise RootResolutionError("root_identity_zero", "Canonical user data root returned zero identity.")

    return ApprovedRoot(norm_path, dev, ino)


def _sqlite_url(db_path: Path) -> str:
    return f"sqlite:///{db_path.as_posix()}"


def configure_launcher_environment(approved_root: ApprovedRoot | Path):
    if isinstance(approved_root, ApprovedRoot):
        root_path = approved_root.path
        dev = approved_root.dev
        ino = approved_root.ino
    else:
        root_path = Path(approved_root).resolve()
        st = os.lstat(root_path)
        dev = st.st_dev
        ino = st.st_ino

    db_path = root_path / "audit.db"
    os.environ["DATABASE_URL"] = _sqlite_url(db_path)
    os.environ["PREVIEW_STORAGE_DIR"] = str(root_path / "rendered-previews")
    os.environ["ACA_APPROVED_DATA_ROOT"] = str(root_path)
    os.environ["ACA_APPROVED_DATA_ROOT_DEV"] = str(dev)
    os.environ["ACA_APPROVED_DATA_ROOT_INO"] = str(ino)


def revalidate_child_approved_root() -> ApprovedRoot:
    root_str = os.environ.get("ACA_APPROVED_DATA_ROOT")
    dev_str = os.environ.get("ACA_APPROVED_DATA_ROOT_DEV")
    ino_str = os.environ.get("ACA_APPROVED_DATA_ROOT_INO")

    is_frozen = getattr(sys, "frozen", False)
    if not root_str or not dev_str or not ino_str:
        if is_frozen:
            raise RootResolutionError("missing_approval_fields", "Packaged backend child missing required approval environment.")
        return get_user_data_root()

    try:
        dev = int(dev_str)
        ino = int(ino_str)
    except (ValueError, TypeError):
        raise RootResolutionError("malformed_approval_identity", "Backend child received malformed approval identity.")

    if dev <= 0 or ino <= 0:
        raise RootResolutionError("zero_approval_identity", "Backend child received zero or negative approval identity.")

    p = Path(root_str)
    if not p.is_absolute():
        raise RootResolutionError("relative_approval_path", "Approved root must be an absolute path.")

    norm_path = p.resolve()
    try:
        st = os.lstat(norm_path)
    except OSError as e:
        raise RootResolutionError("child_lstat_failed", f"Child failed to stat approved root: {type(e).__name__}")

    if norm_path.is_symlink() or not norm_path.is_dir():
        raise RootResolutionError("child_root_not_dir", "Approved root is not a real directory or is a symlink.")

    if st.st_dev != dev or st.st_ino != ino:
        raise RootResolutionError("identity_mismatch", "Child observed root identity does not match launcher approval.")

    return ApprovedRoot(norm_path, dev, ino)

def get_log_dir(root: Path) -> Path:
    return root / "logs"


def get_instance_path(root: Path) -> Path:
    return root / "instance.json"


def setup_launcher_logging(log_dir: Path):
    logger = logging.getLogger("launcher")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for h in list(logger.handlers):
        if isinstance(h, logging.StreamHandler) and not isinstance(h, logging.handlers.RotatingFileHandler):
            logger.removeHandler(h)
    if any(isinstance(h, logging.handlers.RotatingFileHandler) for h in logger.handlers):
        return logger
    fh = None
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            str(log_dir / "launcher.log"),
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        for h in list(logger.handlers):
            if isinstance(h, logging.NullHandler):
                logger.removeHandler(h)
        logger.addHandler(fh)
    except Exception:
        if fh and fh in logger.handlers:
            logger.removeHandler(fh)
        if fh:
            try:
                fh.close()
            except Exception:
                pass
        if not any(isinstance(h, (logging.handlers.RotatingFileHandler, logging.NullHandler)) for h in logger.handlers):
            logger.addHandler(logging.NullHandler())
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
