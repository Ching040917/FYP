"""Logging configuration runs in subprocesses to isolate global handlers."""
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


BACKEND = Path(__file__).resolve().parents[1]


def run_logging(tmp_path, body):
    script = """
import json, logging, sys
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
from app import launcher_support as ls
import frozen_main
root = Path(sys.argv[1])
root.mkdir(exist_ok=True)
stat = root.stat()
approved = ls.ApprovedRoot(root, stat.st_dev, stat.st_ino)
stdout, stderr = sys.stdout, sys.stderr
""" + textwrap.dedent(body)
    result = subprocess.run(
        [sys.executable, "-B", "-c", script, str(tmp_path)], cwd=BACKEND,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)


def test_uvicorn_default_formatter_reproduces_windowed_stdio_failure(tmp_path):
    result = run_logging(tmp_path, """
        from uvicorn.config import LOGGING_CONFIG
        import logging.config
        sys.stdout = sys.stderr = None
        try:
            logging.config.dictConfig(LOGGING_CONFIG)
        except ValueError as exc:
            outcome = {"outer": str(exc), "inner": type(exc.__cause__).__name__,
                       "cause": str(exc.__cause__)}
        else:
            raise AssertionError("The original windowed logging failure was not reproduced")
        finally:
            sys.stdout, sys.stderr = stdout, stderr
        print(json.dumps(outcome))
    """)
    assert result["outer"] == "Unable to configure formatter 'default'"
    assert result["inner"] == "AttributeError"
    assert "isatty" in result["cause"]


def test_file_logging_preserves_none_streams_and_exception_diagnostics(tmp_path):
    result = run_logging(tmp_path, """
        sys.stdout = sys.stderr = None
        ls.setup_backend_logging(root / "logs")
        logging.getLogger("uvicorn.error").info("startup marker")
        logging.getLogger("uvicorn.access").info("access marker")
        try:
            raise RuntimeError("synthetic logging error")
        except RuntimeError:
            logging.getLogger("app.test").exception("exception marker")
        outcome = {"stdout_none": sys.stdout is None, "stderr_none": sys.stderr is None}
        logging.shutdown()
        sys.stdout, sys.stderr = stdout, stderr
        print(json.dumps(outcome))
    """)
    assert result == {"stdout_none": True, "stderr_none": True}
    content = (tmp_path / "logs/backend.log").read_text(encoding="utf-8")
    assert content.count("INFO uvicorn.error: startup marker") == 1
    assert content.count("INFO uvicorn.access: access marker") == 1
    assert "ERROR app.test: exception marker" in content
    assert "Traceback (most recent call last)" in content
    assert "RuntimeError: synthetic logging error" in content


def test_backend_file_rotation_bounds_retained_diagnostics(tmp_path):
    run_logging(tmp_path, """
        ls.LOG_MAX_BYTES = 256
        ls.LOG_BACKUP_COUNT = 2
        ls.setup_backend_logging(root / "logs")
        for number in range(12):
            logging.getLogger("app.test").info("marker-%02d %s", number, "x" * 100)
        logging.shutdown()
        print(json.dumps({"done": True}))
    """)
    files = {path.name for path in (tmp_path / "logs").iterdir()}
    assert files == {"backend.log", "backend.log.1", "backend.log.2"}
    assert "marker-11" in (tmp_path / "logs/backend.log").read_text(encoding="utf-8")
    assert "marker-00" not in "".join(path.read_text(encoding="utf-8") for path in (tmp_path / "logs").iterdir())


def test_logging_failure_stops_before_application_import_and_keeps_traceback(tmp_path):
    result = run_logging(tmp_path, """
        (root / "logs/backend.log").mkdir(parents=True)
        sys.frozen = True
        with patch.object(ls, "revalidate_child_approved_root", return_value=approved):
            code = frozen_main._backend()
        logging.shutdown()
        print(json.dumps({"code": code, "app_loaded": "app.main" in sys.modules}))
    """)
    assert result == {"code": 78, "app_loaded": False}
    content = (tmp_path / "logs/launcher.log").read_text(encoding="utf-8")
    assert "backend_logging_init_failed" in content
    assert "Traceback (most recent call last)" in content
    assert "Unable to configure handler 'backend_file'" in content


@pytest.mark.parametrize("fallback", ["raises", "broken_logger"])
def test_logging_failure_remains_nonzero_when_fallback_logging_fails(tmp_path, fallback):
    result = run_logging(tmp_path, f"""
        sys.frozen = True
        class BrokenLogger:
            def log(self, *args, **kwargs):
                raise OSError("synthetic logger failure")
        fallback = {{"side_effect": OSError("synthetic file failure")}} if {fallback!r} == "raises" else {{"return_value": BrokenLogger()}}
        with patch.object(ls, "revalidate_child_approved_root", return_value=approved), \
             patch.object(ls, "setup_backend_logging", side_effect=ValueError("synthetic configuration failure")), \
             patch.object(ls, "setup_launcher_logging", **fallback):
            code = frozen_main._backend()
        print(json.dumps({{"code": code, "app_loaded": "app.main" in sys.modules}}))
    """)
    assert result == {"code": 78, "app_loaded": False}


@pytest.mark.parametrize("frozen", [False, True])
def test_backend_server_configuration_keeps_source_or_file_diagnostics(tmp_path, frozen):
    result = run_logging(tmp_path, f"""
        import io
        import uvicorn
        app_module = ModuleType("app.main")
        async def app(scope, receive, send):
            pass
        app_module.app = app
        sys.modules["app.main"] = app_module
        captured = io.StringIO()
        sys.frozen = {frozen!r}
        sys.stdout = None if sys.frozen else stdout
        sys.stderr = None if sys.frozen else captured
        def server(application, **kwargs):
            uvicorn.Config(application, **kwargs)
            logging.getLogger("uvicorn.error").info("server configuration ready")
        with patch.object(ls, "revalidate_child_approved_root", return_value=approved), \
             patch.object(uvicorn, "run", side_effect=server):
            code = frozen_main._backend()
        logging.shutdown()
        sys.stdout, sys.stderr = stdout, stderr
        print(json.dumps({{"code": code, "console": captured.getvalue()}}))
    """)
    assert result["code"] is None
    backend_log = tmp_path / "logs/backend.log"
    if frozen:
        assert result["console"] == ""
        assert "INFO uvicorn.error: server configuration ready" in backend_log.read_text(encoding="utf-8")
    else:
        assert "server configuration ready" in result["console"]
        assert not backend_log.exists()


@pytest.mark.parametrize("scenario,expected", [
    ("occupied_port", "PORT_UNAVAILABLE"),
    ("generic_lifespan", "UNEXPECTED_STARTUP_FAILURE"),
    ("reconciliation_record", "DATABASE_RECONCILIATION_REFUSAL"),
    ("forged_bind_lifespan", "UNEXPECTED_STARTUP_FAILURE"),
])
def test_backend_classifies_actual_bind_and_lifespan_failures(tmp_path, scenario, expected):
    result = run_logging(tmp_path, f"""
        import os, socket
        from contextlib import asynccontextmanager
        from fastapi import FastAPI
        scenario = {scenario!r}
        attempt = ls.new_startup_attempt(approved)
        os.environ.update(attempt.environment())
        @asynccontextmanager
        async def lifespan(app):
            if scenario == "reconciliation_record":
                assert ls.write_startup_failure("DATABASE_RECONCILIATION_REFUSAL", approved)
            if scenario == "forged_bind_lifespan":
                import errno
                try:
                    raise OSError(errno.EADDRINUSE, "synthetic non-bind error")
                except OSError:
                    raise SystemExit(1)
            if scenario != "occupied_port":
                raise ValueError("synthetic unrelated lifespan failure")
            yield
        app_module = ModuleType("app.main")
        app_module.app = FastAPI(lifespan=lifespan)
        sys.modules["app.main"] = app_module
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            os.environ["ACA_POC_PORT"] = str(occupied.getsockname()[1])
            sys.frozen = True
            sys.stdout = sys.stderr = None
            with patch.object(ls, "revalidate_child_approved_root", return_value=approved):
                code = frozen_main._backend()
        logging.shutdown()
        category = ls.consume_startup_failure(attempt, approved)
        sys.stdout, sys.stderr = stdout, stderr
        print(json.dumps({{"code": code, "category": category}}))
    """)
    assert result["code"] != 0
    assert result["category"] == expected
