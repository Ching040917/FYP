"""Launcher helpers (Phase 2 PoC) — stdlib only."""
import ctypes
import ctypes.wintypes
import json
import logging
import logging.config
import logging.handlers
import os
import secrets
import stat
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
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
BACKEND_LOGGING_FAILURE_EXIT_CODE = 78

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


STARTUP_SCHEMA_VERSION = 1
STARTUP_STATUS_MAX_BYTES = 1024
STARTUP_FAILURE_CATEGORIES = frozenset({
    "DATABASE_RECONCILIATION_REFUSAL",
    "DATABASE_UPGRADE_OR_VERIFICATION_FAILURE",
    "PORT_UNAVAILABLE",
    "UNEXPECTED_STARTUP_FAILURE",
})
_STARTUP_FALLBACK = "UNEXPECTED_STARTUP_FAILURE"
_STARTUP_RUNTIME = "runtime"


@dataclass(frozen=True)
class StartupAttempt:
    path: Path
    nonce: str
    schema_version: int
    _root_identity: tuple[int, int]
    _runtime_identity: tuple[int, int]
    _directory_identity: tuple[int, int]

    def environment(self) -> dict[str, str]:
        return {
            "ACA_STARTUP_STATUS_PATH": str(self.path),
            "ACA_STARTUP_ATTEMPT_NONCE": self.nonce,
            "ACA_STARTUP_SCHEMA_VERSION": str(self.schema_version),
        }


def _startup_identity(st):
    return st.st_dev, st.st_ino


def _startup_check_stat(st, *, directory=False, private=False, allow_linked=False):
    if (not (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode))
            or stat.S_ISLNK(st.st_mode)
            or getattr(st, "st_file_attributes", 0) & 0x400
            or st.st_dev <= 0 or st.st_ino <= 0):
        raise OSError("Unsafe startup protocol object")
    if os.name != "nt" and private:
        if st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise OSError("Startup protocol object is not private")
        if not directory and not allow_linked and st.st_nlink != 1:
            raise OSError("Startup protocol file has unexpected links")


def _startup_windows_api():
    # Separate bindings: never alter the launcher's existing kernel32 helpers.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p,
        ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p,
    ]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_ulong),
    ]
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_ulong),
    ]
    advapi.GetNamedSecurityInfoW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_int, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi.GetNamedSecurityInfoW.restype = ctypes.c_ulong
    advapi.OpenProcessToken.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi.GetTokenInformation.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    advapi.ConvertSidToStringSidW.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
    ]
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    return kernel, advapi


@contextmanager
def _startup_windows_descriptor():
    kernel, advapi = _startup_windows_api()
    token = ctypes.c_void_p()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise OSError("Startup token unavailable")
    sid_text = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    try:
        size = ctypes.c_ulong()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        if not size.value:
            raise OSError("Startup token identity unavailable")
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise OSError("Startup token identity unavailable")
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise OSError("Startup token identity unavailable")
        user = ctypes.wstring_at(sid_text)
        # Protected DACL: only this user, SYSTEM and administrators can mutate.
        sddl = f"O:{user}D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, 1, ctypes.byref(descriptor), None):
            raise OSError("Startup security descriptor unavailable")
        yield kernel, advapi, descriptor
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)
        if sid_text:
            kernel.LocalFree(sid_text)
        kernel.CloseHandle(token)


def _startup_windows_sddl(kernel, advapi, descriptor, information=5):
    text = ctypes.c_void_p()
    try:
        if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor, 1, information, ctypes.byref(text), None):
            raise OSError("Startup permissions unavailable")
        return ctypes.wstring_at(text)
    finally:
        if text:
            kernel.LocalFree(text)


def _startup_windows_private(path):
    with _startup_windows_descriptor() as (kernel, advapi, expected):
        actual = ctypes.c_void_p()
        try:
            if advapi.GetNamedSecurityInfoW(
                    str(path), 1, 5, None, None, None, None, ctypes.byref(actual)):
                raise OSError("Startup permissions unavailable")
            if (_startup_windows_sddl(kernel, advapi, actual).replace("D:PAI", "D:P")
                    != _startup_windows_sddl(kernel, advapi, expected)):
                raise OSError("Startup directory is not private")
        finally:
            if actual:
                kernel.LocalFree(actual)


def _startup_windows_owned_file(path):
    with _startup_windows_descriptor() as (kernel, advapi, expected):
        actual = ctypes.c_void_p()
        try:
            if advapi.GetNamedSecurityInfoW(
                    str(path), 1, 1, None, None, None, None, ctypes.byref(actual)):
                raise OSError("Startup file ownership unavailable")
            if (_startup_windows_sddl(kernel, advapi, actual, 1)
                    != _startup_windows_sddl(kernel, advapi, expected, 1)):
                raise OSError("Startup file has unexpected owner")
        finally:
            if actual:
                kernel.LocalFree(actual)


def _startup_mkdir(path, parent_fd=None):
    if os.name != "nt":
        os.mkdir(path.name, 0o700, dir_fd=parent_fd)
        return
    with _startup_windows_descriptor() as (kernel, _, descriptor):
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
            error = ctypes.get_last_error()
            if error == 183:
                raise FileExistsError("Startup directory already exists")
            raise OSError("Startup directory creation failed")


@contextmanager
def _startup_directory(path, parent_fd=None, private=False):
    """Pin each directory without following links; Windows pins deny rename."""
    if os.name == "nt":
        kernel, _ = _startup_windows_api()
        handle = kernel.CreateFileW(
            str(path), 0x80, 3, None, 3, 0x02200000, None,
        )
        if handle in (None, ctypes.c_void_p(-1).value):
            raise OSError("Startup directory cannot be pinned")
        try:
            st = os.lstat(path)
            _startup_check_stat(st, directory=True)
            if private:
                _startup_windows_private(path)
            yield None, st
        finally:
            kernel.CloseHandle(handle)
    else:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(path if parent_fd is None else path.name, flags, dir_fd=parent_fd)
        try:
            st = os.fstat(fd)
            _startup_check_stat(st, directory=True, private=private)
            yield fd, st
        finally:
            os.close(fd)


@contextmanager
def _startup_root(approved_root):
    if not isinstance(approved_root, ApprovedRoot):
        raise OSError("Startup root approval required")
    path = approved_root.path
    if (not isinstance(path, Path) or not path.is_absolute()
            or path != Path(os.path.normpath(str(path)))):
        raise OSError("Startup root path is not canonical")
    with ExitStack() as stack:
        parent_fd = None
        current = Path(path.anchor)
        parent_fd, st = stack.enter_context(_startup_directory(current))
        for component in path.parts[1:]:
            current /= component
            parent_fd, st = stack.enter_context(_startup_directory(current, parent_fd))
        if _startup_identity(st) != (approved_root.dev, approved_root.ino):
            raise OSError("Startup root identity changed")
        yield stack, parent_fd


def _startup_validate_attempt(attempt, approved_root):
    if (not isinstance(attempt, StartupAttempt)
            or type(attempt.schema_version) is not int
            or attempt.schema_version != STARTUP_SCHEMA_VERSION
            or not isinstance(attempt.nonce, str) or len(attempt.nonce) != 64
            or any(c not in "0123456789abcdef" for c in attempt.nonce)
            or attempt._root_identity != (approved_root.dev, approved_root.ino)
            or attempt.path != approved_root.path / _STARTUP_RUNTIME
            / ("startup-" + attempt.nonce) / "status.json"):
        raise OSError("Invalid startup attempt")


@contextmanager
def _startup_scope(attempt, approved_root):
    _startup_validate_attempt(attempt, approved_root)
    with _startup_root(approved_root) as (stack, root_fd):
        runtime = attempt.path.parent.parent
        runtime_fd, st = stack.enter_context(
            _startup_directory(runtime, root_fd, private=True))
        if _startup_identity(st) != attempt._runtime_identity:
            raise OSError("Startup runtime identity changed")
        directory_fd, st = stack.enter_context(
            _startup_directory(attempt.path.parent, runtime_fd, private=True))
        if _startup_identity(st) != attempt._directory_identity:
            raise OSError("Startup attempt identity changed")
        yield directory_fd


def _startup_recheck_root(approved_root):
    st = os.lstat(approved_root.path)
    _startup_check_stat(st, directory=True)
    if _startup_identity(st) != (approved_root.dev, approved_root.ino):
        raise OSError("Startup root identity changed")


def new_startup_attempt(approved_root: ApprovedRoot) -> StartupAttempt:
    """Reserve a private nonce directory, leaving the final status path absent."""
    with _startup_root(approved_root) as (stack, root_fd):
        runtime = approved_root.path / _STARTUP_RUNTIME
        try:
            _startup_mkdir(runtime, root_fd)
        except FileExistsError:
            pass
        runtime_fd, runtime_st = stack.enter_context(
            _startup_directory(runtime, root_fd, private=True))
        for _ in range(16):
            nonce = secrets.token_hex(32)
            directory = runtime / ("startup-" + nonce)
            try:
                _startup_mkdir(directory, runtime_fd)
                break
            except FileExistsError:
                continue
        else:
            raise OSError("Startup attempt reservation failed")
        with _startup_directory(directory, runtime_fd, private=True) as (_, st):
            _startup_recheck_root(approved_root)
            return StartupAttempt(
                directory / "status.json", nonce, STARTUP_SCHEMA_VERSION,
                (approved_root.dev, approved_root.ino),
                _startup_identity(runtime_st), _startup_identity(st),
            )


def _startup_environment_attempt(approved_root):
    path = Path(os.environ.get("ACA_STARTUP_STATUS_PATH", ""))
    nonce = os.environ.get("ACA_STARTUP_ATTEMPT_NONCE", "")
    if os.environ.get("ACA_STARTUP_SCHEMA_VERSION") != "1":
        raise OSError("Invalid startup schema")
    # No resolution: a supplied link must never become an approved real path.
    candidate = StartupAttempt(path, nonce, 1, (approved_root.dev, approved_root.ino), (), ())
    _startup_validate_attempt(candidate, approved_root)
    with _startup_root(approved_root) as (stack, root_fd):
        runtime_fd, runtime_st = stack.enter_context(
            _startup_directory(path.parent.parent, root_fd, private=True))
        _, directory_st = stack.enter_context(
            _startup_directory(path.parent, runtime_fd, private=True))
        return StartupAttempt(
            path, nonce, 1, (approved_root.dev, approved_root.ino),
            _startup_identity(runtime_st), _startup_identity(directory_st),
        )


def _startup_recheck_attempt(attempt, approved_root):
    _startup_recheck_root(approved_root)
    for path, identity in (
            (attempt.path.parent.parent, attempt._runtime_identity),
            (attempt.path.parent, attempt._directory_identity)):
        st = os.lstat(path)
        _startup_check_stat(st, directory=True, private=True)
        if _startup_identity(st) != identity:
            raise OSError("Startup directory identity changed")


def _startup_stat(path, directory_fd):
    return os.lstat(path) if os.name == "nt" else os.stat(
        path.name, dir_fd=directory_fd, follow_symlinks=False)


def _startup_unlink(path, directory_fd, identity, *, allow_linked=False):
    st = _startup_stat(path, directory_fd)
    _startup_check_stat(st, private=True, allow_linked=allow_linked)
    if _startup_identity(st) != identity:
        raise OSError("Startup file identity changed")
    if os.name == "nt":
        os.unlink(path)
    else:
        os.unlink(path.name, dir_fd=directory_fd)


def write_startup_failure(category: str, approved_root=None) -> bool:
    """Best effort only; no logging, exception text, or failure-outcome mutation.

    Publish a complete fsynced sibling atomically without replacing any status:
    Windows rename refuses an existing destination; POSIX link is no-clobber.
    This is not authentication against another process running as this user.
    """
    temporary = None
    temporary_identity = None
    try:
        if type(category) is not str or category not in STARTUP_FAILURE_CATEGORIES:
            return False
        if not all(os.environ.get(name) for name in (
                "ACA_STARTUP_STATUS_PATH", "ACA_STARTUP_ATTEMPT_NONCE",
                "ACA_STARTUP_SCHEMA_VERSION")):
            return False
        if approved_root is None:
            approved_root = revalidate_child_approved_root()
        attempt = _startup_environment_attempt(approved_root)
        payload = json.dumps({
            "schema_version": 1, "attempt_nonce": attempt.nonce, "category": category,
        }, separators=(",", ":")).encode("ascii")
        with _startup_scope(attempt, approved_root) as directory_fd:
            try:
                temporary = attempt.path.with_name(".pending-" + secrets.token_hex(32))
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
                fd = os.open(
                    temporary if os.name == "nt" else temporary.name,
                    flags, 0o600, **({} if os.name == "nt" else {"dir_fd": directory_fd}),
                )
                with os.fdopen(fd, "wb") as handle:
                    temporary_identity = _startup_identity(os.fstat(handle.fileno()))
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                st = _startup_stat(temporary, directory_fd)
                _startup_check_stat(st, private=True)
                if _startup_identity(st) != temporary_identity:
                    raise OSError("Startup temporary identity changed")
                _startup_recheck_attempt(attempt, approved_root)
                if os.name == "nt":
                    os.rename(temporary, attempt.path)
                    temporary = None
                else:
                    os.link(
                        temporary.name, attempt.path.name, src_dir_fd=directory_fd,
                        dst_dir_fd=directory_fd, follow_symlinks=False,
                    )
                    _startup_unlink(
                        temporary, directory_fd, temporary_identity, allow_linked=True)
                    temporary = None
                return True
            finally:
                if temporary is not None and temporary_identity is not None:
                    _startup_unlink(
                        temporary, directory_fd, temporary_identity, allow_linked=True)
    except Exception:
        return False


def _startup_json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate startup field")
        result[key] = value
    return result



def _startup_open_read(path, directory_fd):
    if os.name != "nt":
        return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                       dir_fd=directory_fd)
    import msvcrt
    kernel, _ = _startup_windows_api()
    # Do not follow a final reparse point; deny concurrent writes and deletion.
    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
    if handle in (None, ctypes.c_void_p(-1).value):
        raise OSError("Startup record cannot be pinned")
    try:
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except Exception:
        kernel.CloseHandle(handle)
        raise

def _startup_read(attempt, directory_fd):
    before = _startup_stat(attempt.path, directory_fd)
    _startup_check_stat(before, private=True)
    if before.st_size > STARTUP_STATUS_MAX_BYTES:
        raise ValueError("Startup record too large")
    fd = _startup_open_read(attempt.path, directory_fd)
    with os.fdopen(fd, "rb") as handle:
        opened = os.fstat(handle.fileno())
        _startup_check_stat(opened, private=True)
        if os.name == "nt":
            _startup_windows_owned_file(attempt.path)
        if _startup_identity(opened) != _startup_identity(before):
            raise OSError("Startup record identity changed")
        payload = handle.read(STARTUP_STATUS_MAX_BYTES + 1)
        after = os.fstat(handle.fileno())
        if (len(payload) > STARTUP_STATUS_MAX_BYTES
                or opened.st_size != after.st_size
                or opened.st_mtime_ns != after.st_mtime_ns):
            raise ValueError("Startup record changed or too large")
    record = json.loads(payload, object_pairs_hook=_startup_json_pairs)
    if (type(record) is not dict
            or set(record) != {"schema_version", "attempt_nonce", "category"}
            or type(record["schema_version"]) is not int or record["schema_version"] != 1
            or type(record["attempt_nonce"]) is not str or record["attempt_nonce"] != attempt.nonce
            or type(record["category"]) is not str
            or record["category"] not in STARTUP_FAILURE_CATEGORIES):
        raise ValueError("Invalid startup record")
    return record["category"]


def startup_failure_present(attempt: StartupAttempt, approved_root: ApprovedRoot) -> bool:
    """Existence gate only, never read or parse while the child is running."""
    with _startup_scope(attempt, approved_root) as directory_fd:
        try:
            _startup_stat(attempt.path, directory_fd)
            return True
        except FileNotFoundError:
            return False


def cleanup_startup_attempt(attempt: StartupAttempt, approved_root: ApprovedRoot):
    """Remove only this reserved directory's safe regular files; fail closed."""
    with _startup_scope(attempt, approved_root) as directory_fd:
        # A pending file is ours only if its private directory and exact naming
        # convention are intact. Never recurse or delete unknown entries.
        names = os.listdir(attempt.path.parent if os.name == "nt" else directory_fd)
        for name in names:
            if name != "status.json" and not (
                    name.startswith(".pending-") and len(name) == 73
                    and all(c in "0123456789abcdef" for c in name[9:])):
                raise OSError("Unknown startup attempt entry")
        files = []
        link_counts = {}
        for name in names:
            path = attempt.path.with_name(name)
            st = _startup_stat(path, directory_fd)
            _startup_check_stat(st, private=True, allow_linked=True)
            if os.name == "nt":
                _startup_windows_owned_file(path)
            identity = _startup_identity(st)
            files.append((path, st, identity))
            link_counts[identity] = link_counts.get(identity, 0) + 1
        # A killed POSIX publisher can leave final and pending as two links.
        # Accept only links completely accounted for inside this owned directory.
        for _, st, identity in files:
            if st.st_nlink != link_counts[identity]:
                raise OSError("Startup file has unowned links")
        for path, _, identity in files:
            _startup_recheck_attempt(attempt, approved_root)
            _startup_unlink(path, directory_fd, identity, allow_linked=True)
    # The private runtime is still identity checked and pinned for removal.
    with _startup_root(approved_root) as (stack, root_fd):
        runtime_fd, st = stack.enter_context(
            _startup_directory(attempt.path.parent.parent, root_fd, private=True))
        if _startup_identity(st) != attempt._runtime_identity:
            raise OSError("Startup runtime identity changed")
        st = _startup_stat(attempt.path.parent, runtime_fd)
        _startup_check_stat(st, directory=True, private=True)
        if _startup_identity(st) != attempt._directory_identity:
            raise OSError("Startup attempt identity changed")
        if os.name == "nt":
            os.rmdir(attempt.path.parent)
        else:
            os.rmdir(attempt.path.parent.name, dir_fd=runtime_fd)


def consume_startup_failure(attempt: StartupAttempt, approved_root: ApprovedRoot) -> str:
    """Only call after child exit. Invalid/missing records never select a cause."""
    category = _STARTUP_FALLBACK
    try:
        with _startup_scope(attempt, approved_root) as directory_fd:
            category = _startup_read(attempt, directory_fd)
            _startup_recheck_attempt(attempt, approved_root)
    except (OSError, ValueError, TypeError, UnicodeError):
        category = _STARTUP_FALLBACK
    cleanup_startup_attempt(attempt, approved_root)
    return category

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


def setup_backend_logging(log_dir: Path):
    """Configure rotating file diagnostics without probing GUI-mode stdio."""
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.config.dictConfig({
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"},
        },
        "handlers": {
            "backend_file": {
                "class": "logging.handlers.RotatingFileHandler",
                "formatter": "default",
                "filename": str(log_dir / "backend.log"),
                "maxBytes": LOG_MAX_BYTES,
                "backupCount": LOG_BACKUP_COUNT,
                "encoding": "utf-8",
            },
        },
        "loggers": {
            "uvicorn": {"handlers": ["backend_file"], "level": "INFO", "propagate": False},
            "uvicorn.error": {"handlers": [], "level": "INFO", "propagate": True},
            "uvicorn.access": {"handlers": [], "level": "INFO", "propagate": True},
        },
        "root": {"handlers": ["backend_file"], "level": "INFO"},
    })


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


def is_mutex_held() -> bool | None:
    if _kernel32 is None:
        return False
    h = _kernel32.OpenMutexW(0x0001, False, ctypes.create_unicode_buffer(MUTEX_NAME))
    if h:
        _kernel32.CloseHandle(h)
        return True
    return False if _kernel32.GetLastError() == 2 else None


def _verify_instance_write(path: Path, logger=None) -> bool:
    """Check the governed atomic-write location without replacing metadata."""
    tmp = path.with_suffix(".tmp")
    created = False
    try:
        with tmp.open("x", encoding="utf-8") as stream:
            created = True
            stream.write("{}")
        tmp.unlink()
        return True
    except OSError as exc:
        _safe_log(logger, logging.WARNING, "instance_write_refused category=%s", type(exc).__name__)
        if created:
            try:
                tmp.unlink()
            except OSError as cleanup_exc:
                _safe_log(logger, logging.WARNING, "instance_probe_cleanup_failed category=%s", type(cleanup_exc).__name__)
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


def is_pid_running(pid: int) -> bool | None:
    """Return None when process absence cannot be positively established."""
    if _kernel32 is not None:
        h = _kernel32.OpenProcess(0x1000, False, pid)
        if not h:
            return False if _kernel32.GetLastError() == 87 else None
        try:
            code = ctypes.wintypes.DWORD()
            if not _kernel32.GetExitCodeProcess(h, ctypes.byref(code)):
                return None
            return code.value == 259  # STILL_ACTIVE
        finally:
            _kernel32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return None


def is_executable_match(pid: int) -> bool | None:
    """Unknown identity must not authorize deletion or another backend."""
    if _kernel32 is None or os.name != "nt":
        return None
    h = _kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = ctypes.wintypes.DWORD(len(buf))
        if not _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return None
        return os.path.normcase(os.path.realpath(buf.value)) == os.path.normcase(os.path.realpath(sys.executable))
    except OSError:
        return None
    finally:
        _kernel32.CloseHandle(h)


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
