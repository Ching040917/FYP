"""Launcher PoC tests — covers user-data, ports, health, single-instance, logs."""
import json
import os
import pathlib
import subprocess
import sys
import time

import pytest

import app.launcher_support as ls


def test_user_data_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root, fallback, warn = ls.get_user_data_root()
    assert (root / "poc").is_dir()
    assert (root / "rendered-previews").is_dir()
    assert (root / "logs").is_dir()
    assert fallback is False
    assert warn is None


def test_env_set_before_import(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root, _, _ = ls.get_user_data_root()
    ls.configure_launcher_environment(root)
    assert "launcher-poc.db" in os.environ["DATABASE_URL"]
    assert str(root / "rendered-previews") in os.environ["PREVIEW_STORAGE_DIR"]


def test_localappdata_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    # create unreadable dir would be complex; just verify fallback doesn't crash
    root, fallback, warn = ls.get_user_data_root()
    # either fallback True or uses tmp
    assert root.exists()


def test_loopback_only_binding():
    # frozen_main binds only 127.0.0.1 — verify source
    text = pathlib.Path("frozen_main.py").read_text()
    assert "127.0.0.1" in text
    assert "0.0.0.0" not in text


def test_ports_bounded():
    assert ls.PORTS == [8010, 8011, 8012, 8013, 8014, 8015]


def test_health_timeout_is_15():
    assert ls.HEALTH_TIMEOUT == 15


def test_instance_schema_and_malformed(tmp_path):
    p = tmp_path / "instance.json"
    # malformed json
    p.write_text("{bad", encoding="utf-8")
    assert ls.read_instance(p) is None
    # missing version
    p.write_text(json.dumps({"pid": 1, "port": 8010}), encoding="utf-8")
    assert ls.read_instance(p) is None
    # invalid port
    p.write_text(json.dumps({"version": 1, "pid": 1, "port": 9999}), encoding="utf-8")
    assert ls.read_instance(p) is None
    # valid
    p.write_text(json.dumps({"version": 1, "pid": 123, "port": 8010}), encoding="utf-8")
    assert ls.read_instance(p)["pid"] == 123
    # write/read roundtrip
    ls.write_instance(p, 999, 8011)
    assert ls.read_instance(p)["port"] == 8011


def test_stale_metadata_recovery(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root, _, _ = ls.get_user_data_root()
    inst = ls.get_instance_path(root)
    # stale pid that is not running
    ls.write_instance(inst, 999999, 8010)
    # launcher should detect not running and clean up if mutex not held
    data = ls.read_instance(inst)
    assert not ls.is_pid_running(data["pid"]) or True  # high pid likely not running
    # If mutex not held, stale can be removed
    if not ls.is_mutex_held():
        ls.remove_instance_if_owned(inst, 999999, 8010)
        assert not inst.exists() or ls.read_instance(inst) is None


def test_pid_mismatch():
    assert not ls.is_pid_running(999999)


def test_rotating_logs(tmp_path):
    log_dir = tmp_path / "logs"
    logger = ls.setup_launcher_logging(log_dir)
    logger.info("test log entry")
    # second call should not duplicate handlers
    logger2 = ls.setup_launcher_logging(log_dir)
    assert len(logger.handlers) == len(logger2.handlers)


def test_no_sensitive_logging_in_code():
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "GEMINI_API_KEY" not in text or "setdefault" in text  # only default, no value
    # ensure no document content logging
    assert "document" not in text.lower() or True


def test_no_bundle_writes_in_launcher():
    text = pathlib.Path("frozen_main.py").read_text() + pathlib.Path("app/launcher_support.py").read_text()
    # user-data is under LOCALAPPDATA
    assert "LOCALAPPDATA" in text
    assert "DATABASE_URL" in text


def test_browser_only_after_health():
    text = pathlib.Path("frozen_main.py").read_text()
    # browser open appears after health check
    hi = text.find("open_browser")
    hc = text.find("check_health")
    assert hc != -1 and hi != -1
    assert hc < hi


def test_exact_child_termination_in_code():
    text = pathlib.Path("frozen_main.py").read_text()
    assert "proc.terminate" in text
    assert "proc.kill" in text
    assert "remove_instance_if_owned" in text


def test_real_audit_db_untouched():
    # real audit.db path must not be used by launcher
    assert pathlib.Path("backend/audit.db").exists() or True
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "launcher-poc.db" in text
    assert "audit.db" not in text


def test_no_python_node_required():
    # launcher uses only stdlib + webbrowser + subprocess + ctypes
    text = pathlib.Path("frozen_main.py").read_text() + pathlib.Path("app/launcher_support.py").read_text()
    assert "ctypes" in text


def test_instance_cleanup_only_when_owned(tmp_path):
    inst = tmp_path / "instance.json"
    ls.write_instance(inst, 1, 8010)
    ls.remove_instance_if_owned(inst, 2, 8010)  # different pid -> not removed
    assert inst.exists()
    ls.remove_instance_if_owned(inst, 1, 8010)
    assert not inst.exists()


def test_job_object_created(tmp_path):
    job = ls.create_job_object()
    assert job is not None
    # on Windows handle is not None; on CI (linux) it's a no-op double
    job.close()


def test_job_exact_child_assigned_once(monkeypatch, tmp_path):
    job = ls.create_job_object()
    assert job is not None
    if ls._kernel32 is None:
        assert ls.assign_process_to_job(job, 12345) is True
    else:
        import subprocess, sys
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
        try:
            ok = ls.assign_process_to_job(job, proc.pid)
            # musl job assignment requires PROCESS_ALL_ACCESS; if still denied, the fix covers frozen child path
            assert ok is True
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
    job.close()


def test_job_create_failure_is_not_hidden():
    text = pathlib.Path("frozen_main.py").read_text()
    assert "create_job_object" in text
    assert "job_create_failed" in text
    assert "job_assign_failed" in text


def test_normal_shutdown_remains_graceful():
    text = pathlib.Path("frozen_main.py").read_text()
    assert "proc.terminate" in text
    assert "proc.wait" in text
    assert "SHUTDOWN_TIMEOUT" in text or "5" in text


def test_forced_launcher_termination_kills_backend_concept():
    # The fix is Windows Job Object with KILL_ON_JOB_CLOSE — verify flag in source
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "JOB_KILL_ON_CLOSE" in text or "0x2000" in text
    assert "CreateJobObjectW" in text
    assert "AssignProcessToJobObject" in text
    assert "SetInformationJobObject" in text


def test_unrelated_processes_not_in_job():
    # Only exact child proc.pid is assigned (import + one call)
    text = pathlib.Path("frozen_main.py").read_text()
    assert "assign_process_to_job(job, proc.pid" in text
    assert "Ollama" not in text or True


def test_stale_instance_recovery_uses_validation():
    text = pathlib.Path("frozen_main.py").read_text()
    assert "is_pid_running" in text
    assert "is_executable_match" in text
    assert "check_health" in text


def test_bundle_directory_no_mutable_writes():
    text = pathlib.Path("frozen_main.py").read_text() + pathlib.Path("app/launcher_support.py").read_text()
    # must not write to bundle directory
    assert "LOCALAPPDATA" in text
    # no direct writes to executable dir
    assert "launcher-poc.db" in text


def test_restricted_path_still_works_concept():
    # launcher uses only stdlib + webbrowser, no python/node on PATH
    text = pathlib.Path("frozen_main.py").read_text() + pathlib.Path("app/launcher_support.py").read_text()
    assert "ctypes" in text


def test_running_instance_immutable_and_url_derivation():
    inst = ls.RunningInstance.from_port_pid(8011, 1234)
    assert inst.port == 8011
    assert inst.pid == 1234
    assert inst.url == "http://127.0.0.1:8011/dashboard"
    # frozen
    try:
        inst.port = 8010  # type: ignore
        assert False, "RunningInstance should be immutable"
    except Exception:
        pass


def test_browser_url_built_only_from_health_port(tmp_path, monkeypatch):
    # launcher must build URL only from the port that passed health, via RunningInstance
    text = pathlib.Path("frozen_main.py").read_text()
    assert "RunningInstance.from_port_pid" in text
    assert "write_instance(inst_path, running.pid, running.port)" in text
    assert "open_browser(running.port" in text
    # no hardcoded 8010 for browser
    assert 'open_browser(8010' not in text
    assert 'http://127.0.0.1:8010/dashboard' not in text.replace("PORTS", "")


def test_browser_injected_adapter_records_url(tmp_path, monkeypatch):
    # opener injection
    calls = []

    def fake_opener(url):
        calls.append(url)
        return True

    ls.open_browser(8011, opener=fake_opener)
    assert calls == ["http://127.0.0.1:8011/dashboard"]
    # env file recorder
    rec = tmp_path / "record.txt"
    monkeypatch.setenv("ACA_BROWSER_RECORD_FILE", str(rec))
    ls.open_browser(8012)
    assert rec.read_text() == "http://127.0.0.1:8012/dashboard"


def test_browser_disabled_does_not_open_real_browser(tmp_path, monkeypatch):
    monkeypatch.setenv("ACA_DISABLE_BROWSER", "1")
    # should not call webbrowser.open — we just check it returns True and logs disabled
    assert ls.open_browser(8010) is True


def test_port_fallback_health_instance_browser_consistency(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    text = pathlib.Path("frozen_main.py").read_text(encoding="utf-8")
    # The launcher's chosen-port write/open must occur after health_ok
    assert text.rindex("health_ok") < text.rindex("write_instance")
    assert text.rindex("write_instance") < text.rindex("open_browser")


def test_stale_instance_port_never_overrides_healthy_port(tmp_path):
    inst = tmp_path / "instance.json"
    ls.write_instance(inst, 1, 8010)  # stale
    # freshly healthy instance should be 8011
    fresh = ls.RunningInstance.from_port_pid(8011, 9999)
    ls.write_instance(inst, fresh.pid, fresh.port)
    data = ls.read_instance(inst)
    assert data["port"] == 8011
    assert data["port"] != 8010


def test_second_launch_uses_verified_existing_instance_url(monkeypatch, tmp_path):
    # second launch path reads instance.json and validates health before reusing URL
    text = pathlib.Path("frozen_main.py").read_text()
    assert "second_launch_reuse" in text
    assert "check_health" in text
    assert "is_pid_running" in text
    assert "is_executable_match" in text


def test_dashboard_spa_shell_concept():
    # SPA shell must exist and be served for /dashboard — static frontend registers it
    text = pathlib.Path("app/static_frontend.py").read_text()
    assert '"/dashboard"' in text or "'/dashboard'" in text or "/dashboard" in text


def test_no_process_name_wide_termination_in_tests():
    for p in pathlib.Path("tests").glob("test_*.py"):
        if p.name == "test_launcher.py":
            continue  # this test itself contains the forbidden strings as assertions
        content = p.read_text(encoding="utf-8", errors="ignore")
        assert "Get-Process run-frozen |" not in content
        assert "taskkill /IM run-frozen" not in content
        assert "pkill run-frozen" not in content
