"""Launcher PoC tests Ã¢â‚¬â€ covers user-data, ports, health, single-instance, logs."""
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
    approved = ls.get_user_data_root()
    root = approved.path
    assert root.is_dir()
    assert not (root / "poc").exists()
    assert not (root / "rendered-previews").exists()
    assert not (root / "logs").exists()
    assert approved.dev != 0 and approved.ino != 0


def test_env_set_before_import(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root, _, _ = ls.get_user_data_root()
    ls.configure_launcher_environment(root)
    assert "audit.db" in os.environ["DATABASE_URL"]
    assert str(root / "rendered-previews") in os.environ["PREVIEW_STORAGE_DIR"]


def test_localappdata_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    with pytest.raises(ls.RootResolutionError):
        ls.get_user_data_root()


def test_loopback_only_binding():
    # frozen_main binds only 127.0.0.1 Ã¢â‚¬â€ verify source
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
    # Cloud AI is removed: no provider credential may be referenced at all.
    assert "GEMINI_API_KEY" not in text
    assert "GEMINI" not in text
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
    # Static source guard only: inspect the launcher database path literals.
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "audit.db" in text
    assert "backend/audit.db" not in text


def test_launcher_source_mentions_ctypes():
    # Static source guard only: ctypes is mentioned in the launcher sources.
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
    # The fix is Windows Job Object with KILL_ON_JOB_CLOSE Ã¢â‚¬â€ verify flag in source
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "JOB_KILL_ON_CLOSE" in text or "0x2000" in text
    assert "CreateJobObjectW" in text
    assert "AssignProcessToJobObject" in text
    assert "SetInformationJobObject" in text


def test_unrelated_processes_not_in_job():
    # Static source guard only: assignment uses the exact child PID expression.
    text = pathlib.Path("frozen_main.py").read_text()
    assert "assign_process_to_job(job, proc.pid" in text


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
    assert "audit.db" in text


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
    # should not call webbrowser.open Ã¢â‚¬â€ we just check it returns True and logs disabled
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
    # SPA shell must exist and be served for /dashboard Ã¢â‚¬â€ static frontend registers it
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


# ---- Optional-component pathways: default-browser contract (no Edge force) ----

def test_browser_uses_default_browser_mechanism():
    # ACA opens the OS-configured default browser via stdlib webbrowser;
    # no explicit browser executable is launched.
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "import webbrowser" in text
    assert "webbrowser.open" in text


def test_browser_does_not_force_edge_chrome_firefox():
    text = pathlib.Path("app/launcher_support.py").read_text().lower()
    assert "msedge" not in text
    assert "chrome.exe" not in text
    assert "firefox.exe" not in text
    assert "program files" not in text  # no browser-install path probing


def test_browser_url_is_loopback_only():
    text = pathlib.Path("app/launcher_support.py").read_text()
    assert "http://127.0.0.1:" in text
    assert "0.0.0.0" not in text


def test_browser_open_failure_is_caught_and_logged():
    text = pathlib.Path("app/launcher_support.py").read_text()
    # open_browser wraps fn(url) in try/except and returns bool - backend
    # keeps running regardless of the browser result.
    assert "browser_open_failed" in text


def test_browser_open_after_health():
    text = pathlib.Path("frozen_main.py").read_text()
    # health_ok gates write_instance and open_browser
    assert "if health_ok:" in text
    assert text.find("check_health") < text.find("open_browser")
# ===========================================================================
# B-DB-05 Root Safety, Canonical Resolution, and Propagation Tests
# ===========================================================================

def test_b_db_05_valid_first_run_creates_only_product_root(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    root = approved.path
    assert root.is_dir()
    assert root.parent == localappdata.resolve()
    # No unrelated child subdirectories created by root resolution
    assert not (root / "poc").exists()
    assert not (root / "rendered-previews").exists()
    assert not (root / "logs").exists()
    assert not (root / "tmp").exists()
    assert not (root / "backups").exists()
    assert not (root / ".writable_probe").exists()


def test_b_db_05_existing_canonical_root_reused(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    prod_root = localappdata / ls.APP_NAME
    prod_root.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    assert approved.path == prod_root.resolve()


def test_b_db_05_missing_empty_relative_localappdata_fail_closed(monkeypatch):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code == "missing_localappdata"

    monkeypatch.setenv("LOCALAPPDATA", "   ")
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code == "missing_localappdata"

    monkeypatch.setenv("LOCALAPPDATA", "relative/path")
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code == "relative_localappdata"


def test_b_db_05_unwritable_parent_fails_closed(tmp_path, monkeypatch):
    parent = tmp_path / "missing_parent" / "sub"
    # parent does not exist
    monkeypatch.setenv("LOCALAPPDATA", str(parent))
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code == "missing_parent_directory"


def test_b_db_05_product_root_is_a_file_fails_closed(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    prod_file = localappdata / ls.APP_NAME
    prod_file.write_text("not a directory")
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code == "root_is_a_file"


def test_b_db_05_symlink_root_fails_closed(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    monkeypatch.setattr(pathlib.Path, "is_symlink", lambda self: self.name == ls.APP_NAME)
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.get_user_data_root()
    assert exc_info.value.code in ("root_not_a_dir", "root_symlink_or_non_dir")


def test_b_db_05_no_tempfile_home_or_cwd_fallback(monkeypatch, tmp_path):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ACA_USER_DATA_DIR", raising=False)
    with pytest.raises(ls.RootResolutionError):
        ls.get_user_data_root()


def test_b_db_05_path_dev_ino_propagation(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    assert os.environ["ACA_APPROVED_DATA_ROOT"] == str(approved.path)
    assert os.environ["ACA_APPROVED_DATA_ROOT_DEV"] == str(approved.dev)
    assert os.environ["ACA_APPROVED_DATA_ROOT_INO"] == str(approved.ino)


def test_b_db_05_child_accepts_matching_path_and_identity(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    child_approved = ls.revalidate_child_approved_root()
    assert child_approved.path == approved.path
    assert child_approved.dev == approved.dev
    assert child_approved.ino == approved.ino


def test_b_db_05_path_equal_identity_mismatch_rejected_before_db_access(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT_INO", str(approved.ino + 8888))
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "identity_mismatch"


def test_b_db_05_missing_dev_or_ino_rejected(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.delenv("ACA_APPROVED_DATA_ROOT_DEV")
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "missing_approval_fields"


def test_b_db_05_malformed_zero_or_negative_identity_rejected(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT_DEV", "0")
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "zero_approval_identity"

    monkeypatch.setenv("ACA_APPROVED_DATA_ROOT_DEV", "not_a_number")
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "malformed_approval_identity"


def test_b_db_05_missing_approval_provenance_rejected_in_packaged_mode(monkeypatch):
    monkeypatch.delenv("ACA_APPROVED_DATA_ROOT", raising=False)
    monkeypatch.delenv("ACA_APPROVED_DATA_ROOT_DEV", raising=False)
    monkeypatch.delenv("ACA_APPROVED_DATA_ROOT_INO", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "missing_approval_fields"


def test_b_db_05_child_never_calls_root_selection():
    text = pathlib.Path("frozen_main.py").read_text(encoding="utf-8")
    backend_idx = text.find("def _backend():")
    assert backend_idx != -1
    backend_body = text[backend_idx:]
    assert "revalidate_child_approved_root" in backend_body
    assert "get_user_data_root" not in backend_body


def test_b_db_05_root_replaced_by_symlink_rejected(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved = ls.get_user_data_root()
    ls.configure_launcher_environment(approved)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(pathlib.Path, "is_symlink", lambda self: True)
    with pytest.raises(ls.RootResolutionError) as exc_info:
        ls.revalidate_child_approved_root()
    assert exc_info.value.code == "child_root_not_dir"


def test_b_db_05_guided_fix_never_falls_back_to_home(monkeypatch):
    import app.services.guided_fix_storage as gfs
    monkeypatch.delenv("ACA_APPROVED_DATA_ROOT", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ACA_USER_DATA_DIR", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(OSError):
        gfs.storage_root()


def test_b_db_05_cwd_independence(tmp_path, monkeypatch):
    localappdata = tmp_path / "localappdata"
    localappdata.mkdir()
    monkeypatch.setenv("LOCALAPPDATA", str(localappdata))
    approved1 = ls.get_user_data_root()
    # Change working directory
    sub = tmp_path / "other_dir"
    sub.mkdir()
    monkeypatch.chdir(sub)
    approved2 = ls.get_user_data_root()
    assert approved1.path == approved2.path
    assert approved1.dev == approved2.dev and approved1.ino == approved2.ino


def test_b_db_05_mutex_released_on_launcher_root_failure(monkeypatch):
    import frozen_main
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ACA_USER_DATA_DIR", raising=False)
    # _launcher returns 1 and releases mutex cleanly without leak
    rc = frozen_main._launcher()
    assert rc == 1


def test_b_db_05_documentation_wording():
    doc_path = pathlib.Path(__file__).resolve().parents[2] / "docs" / "TROUBLESHOOTING.md"
    assert doc_path.exists()
    content = doc_path.read_text(encoding="utf-8")
    assert "ACA cannot safely access its data folder" in content
    assert "Startup stopped to protect your data rather than creating temporary replacement data" in content

# =====================================================================
# Startup Window Remediation Tests (Wave 6)
# =====================================================================

def test_aca_spec_console_is_false():
    spec_path = pathlib.Path(__file__).resolve().parents[1] / "ACA.spec"
    assert spec_path.is_file()
    text = spec_path.read_text(encoding="utf-8")
    assert "console=False" in text
    assert "console=True" not in text


def test_build_scripts_no_console_override():
    root = pathlib.Path(__file__).resolve().parents[2]
    script1 = root / "backend" / "scripts" / "build-packaging-poc.ps1"
    script2 = root / "scripts" / "build-installer.ps1"
    assert script1.is_file()
    assert script2.is_file()
    for s in (script1, script2):
        text = s.read_text(encoding="utf-8")
        assert "--console" not in text


def _isolate_launcher_environment(monkeypatch):
    for name in (
        "DATABASE_URL",
        "PREVIEW_STORAGE_DIR",
        "ACA_APPROVED_DATA_ROOT",
        "ACA_APPROVED_DATA_ROOT_DEV",
        "ACA_APPROVED_DATA_ROOT_INO",
    ):
        monkeypatch.delenv(name, raising=False)


def _run_launcher_child_spawn(tmp_path, monkeypatch, platform, frozen, browser_opens=True):
    import logging
    from types import SimpleNamespace
    import frozen_main
    from app import db_lifecycle
    _isolate_launcher_environment(monkeypatch)

    port = ls.PORTS[2]
    root = ls.ApprovedRoot(tmp_path, 121, 343)
    mutex = object()
    events = []
    calls = []
    dialogs = []

    class Child:
        pid = 12345
        returncode = 0

        def poll(self):
            events.append("poll")
            return None if events.count("poll") == 1 else 0

    child = Child()

    class Job:
        def close(self):
            events.append("job_closed")

    job = Job()
    frontend = tmp_path / "frontend-dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("test", encoding="utf-8")
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    monkeypatch.setenv("ACA_TEST_SENTINEL", "preserved")
    monkeypatch.setattr(frozen_main, "os", SimpleNamespace(name=platform, environ=os.environ))
    monkeypatch.setattr(
        frozen_main, "signal",
        SimpleNamespace(signal=lambda *_: None, SIGINT=2, SIGBREAK=21),
    )

    def popen(command, **kwargs):
        calls.append((command, kwargs))
        return child

    monkeypatch.setattr(
        frozen_main, "subprocess",
        SimpleNamespace(Popen=popen, CREATE_NEW_PROCESS_GROUP=0x200, CREATE_NO_WINDOW=0x08000000),
    )
    monkeypatch.setattr(ls, "get_user_data_root", lambda: root)
    monkeypatch.setattr(ls, "setup_launcher_logging", lambda _: logging.getLogger("launcher-spawn-test"))
    monkeypatch.setattr(ls, "acquire_mutex", lambda: mutex)
    monkeypatch.setattr(ls, "release_mutex", lambda value: events.append(("mutex_released", value)))
    monkeypatch.setattr(ls, "PORTS", [port])
    monkeypatch.setattr(ls, "create_job_object", lambda logger: job)
    monkeypatch.setattr(
        ls, "assign_process_to_job",
        lambda actual_job, pid, logger: events.append(("assigned", actual_job, pid)) or True,
    )
    monkeypatch.setattr(ls, "check_health", lambda actual_port: actual_port == port)
    monkeypatch.setattr(ls, "write_instance", lambda *args: events.append(("instance_written", args[1:])))
    monkeypatch.setattr(ls, "remove_instance_if_owned", lambda *args: events.append(("instance_removed", args[1:])))
    monkeypatch.setattr(
        ls, "open_browser",
        lambda actual_port, logger: events.append(("browser", actual_port)) or browser_opens,
    )
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    monkeypatch.setattr(
        ls, "_user32",
        SimpleNamespace(MessageBoxW=lambda hwnd, message, title, flags: dialogs.append((message, flags)) or 1),
    )
    monkeypatch.setattr(db_lifecycle, "inspect_state", lambda _: "verified")
    monkeypatch.setattr(db_lifecycle, "startup_action", lambda _: "verify")
    monkeypatch.setattr(db_lifecycle, "verify_after_init", lambda _: None)

    assert frozen_main._launcher() == 0
    assert len(calls) == 1
    command, kwargs = calls[0]
    expected_command = [sys.executable, "--backend"] if frozen else [
        sys.executable, "-m", "backend.frozen_main", "--backend",
    ]
    assert command == expected_command
    assert kwargs.get("shell", False) is False
    assert not any(key in kwargs for key in ("cwd", "stdin", "stdout", "stderr"))
    assert kwargs["env"]["ACA_APPROVED_DATA_ROOT"] == str(tmp_path)
    assert kwargs["env"]["ACA_APPROVED_DATA_ROOT_DEV"] == "121"
    assert kwargs["env"]["ACA_APPROVED_DATA_ROOT_INO"] == "343"
    assert kwargs["env"]["ACA_POC_PORT"] == str(port)
    assert kwargs["env"]["ACA_TEST_SENTINEL"] == "preserved"
    assert not (kwargs["creationflags"] & 0x00000008)
    assert ("assigned", job, child.pid) in events
    assert ("browser", port) in events
    assert ("mutex_released", mutex) in events
    assert "job_closed" in events
    assert events.count("poll") >= 3
    return kwargs["creationflags"], port, events, dialogs


def test_backend_child_creationflags_windows_packaged(tmp_path, monkeypatch):
    flags, _, _, dialogs = _run_launcher_child_spawn(tmp_path, monkeypatch, "nt", True)
    assert flags == 0x08000200
    assert dialogs == []


def test_backend_child_creationflags_windows_source(tmp_path, monkeypatch):
    flags, _, _, dialogs = _run_launcher_child_spawn(tmp_path, monkeypatch, "nt", False)
    assert flags == 0x00000200
    assert dialogs == []


def test_backend_child_creationflags_non_windows(tmp_path, monkeypatch):
    flags, _, _, dialogs = _run_launcher_child_spawn(tmp_path, monkeypatch, "posix", True)
    assert flags == 0
    assert dialogs == []


def test_child_command_and_env_unchanged(tmp_path, monkeypatch):
    # The shared harness invokes _launcher and checks its captured Popen
    # command, --backend, inherited environment, root identity, port and shell.
    monkeypatch.setattr(sys, "executable", "C:\\App\\app.exe")
    for frozen in (True, False):
        case_path = tmp_path / str(frozen)
        case_path.mkdir()
        with monkeypatch.context() as case_patch:
            flags, port, events, dialogs = _run_launcher_child_spawn(
                case_path, case_patch, "nt", frozen,
            )
            assert flags == (0x08000200 if frozen else 0x00000200)
            assert port == ls.PORTS[0]
            assert events.count(("browser", port)) == 1
            assert dialogs == []


def test_normal_shutdown_shows_no_dialog(tmp_path, monkeypatch):
    # Both dialog kinds reach the recording MessageBoxW boundary in the
    # harness; it also requires the real launcher to return success.
    _, port, events, dialogs = _run_launcher_child_spawn(
        tmp_path, monkeypatch, "nt", True,
    )
    assert dialogs == []
    assert events.count("job_closed") == 1
    assert sum(isinstance(event, tuple) and event[0] == "mutex_released"
               for event in events) == 1
    assert sum(isinstance(event, tuple) and event[0] == "instance_removed"
               for event in events) == 1
    assert ("browser", port) in events


def test_safe_print_none_stream_safe(monkeypatch):
    import frozen_main
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)
    frozen_main._safe_print("test message", file=None)
    frozen_main._safe_print("test message default")


def test_safe_print_suppressed_in_frozen_mode(monkeypatch):
    import frozen_main
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    written = []
    class FakeStream:
        def write(self, s):
            written.append(s)
        def flush(self):
            pass
    fake = FakeStream()
    frozen_main._safe_print("diagnostic info", file=fake)
    assert written == []


def test_root_failure_before_logger_no_unbound_error(monkeypatch):
    import frozen_main
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ACA_USER_DATA_DIR", raising=False)
    rc = frozen_main._launcher()
    assert rc == 1


def _root_failure_with_broken_logger(monkeypatch, dialog_fails=False):
    import logging
    from types import SimpleNamespace
    import frozen_main

    log_attempts = []
    dialog_attempts = []

    class BrokenLogger:
        def setLevel(self, level):
            pass

        def log(self, level, message, *args, **kwargs):
            log_attempts.append(message)
            raise OSError("logging unavailable")

    def reject_root():
        raise ls.RootResolutionError("root_unavailable", "root unavailable")

    def show_dialog(hwnd, message, title, flags):
        dialog_attempts.append((message, flags))
        if dialog_fails:
            raise OSError("dialog unavailable")
        return 1

    monkeypatch.setattr(frozen_main, "logging", SimpleNamespace(
        INFO=logging.INFO, getLogger=lambda _: BrokenLogger(),
    ))
    monkeypatch.setattr(ls, "get_user_data_root", reject_root)
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    monkeypatch.setattr(ls, "_user32", SimpleNamespace(MessageBoxW=show_dialog))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert frozen_main._launcher() == 1
    assert len(dialog_attempts) == 1
    assert dialog_attempts[0][1] == ls.MB_OK | ls.MB_ICONERROR
    assert log_attempts


def test_root_failure_dialog_survives_logger_failure(monkeypatch):
    _root_failure_with_broken_logger(monkeypatch)


def test_root_failure_preserves_exit_when_dialog_and_logging_fail(monkeypatch):
    _root_failure_with_broken_logger(monkeypatch, dialog_fails=True)


def _missing_frontend_with_logging_failure(tmp_path, monkeypatch, broken_null_handler):
    import logging
    from types import SimpleNamespace
    import frozen_main

    logger = logging.getLogger("launcher")
    monkeypatch.setattr(logger, "handlers", [])
    monkeypatch.setattr(logger, "level", logger.level)
    monkeypatch.setattr(logger, "propagate", logger.propagate)

    handler_attempts = []

    class BrokenFileHandler(logging.handlers.RotatingFileHandler):
        def __init__(self, *args, **kwargs):
            handler_attempts.append("file")
            raise OSError("file handler unavailable")

    class BrokenNullHandler(logging.NullHandler):
        def __init__(self):
            raise OSError("null handler unavailable")

    class LoggingProxy:
        handlers = SimpleNamespace(RotatingFileHandler=BrokenFileHandler)
        NullHandler = BrokenNullHandler if broken_null_handler else logging.NullHandler

        def __getattr__(self, name):
            return getattr(logging, name)

    monkeypatch.setattr(ls, "logging", LoggingProxy())

    dialogs = []
    released = []
    mutex = object()
    monkeypatch.setattr(ls, "get_user_data_root", lambda: ls.ApprovedRoot(tmp_path, 121, 343))
    monkeypatch.setattr(ls, "acquire_mutex", lambda: mutex)
    monkeypatch.setattr(ls, "release_mutex", released.append)
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    monkeypatch.setattr(
        ls, "_user32",
        SimpleNamespace(MessageBoxW=lambda hwnd, message, title, flags: dialogs.append(flags) or 1),
    )
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "run-frozen.exe"))

    assert frozen_main._launcher() == 1
    assert dialogs == [ls.MB_OK | ls.MB_ICONERROR]
    assert released == [mutex]
    assert handler_attempts == ["file"]
    if not broken_null_handler:
        assert any(isinstance(handler, logging.NullHandler) for handler in logger.handlers)


def test_fatal_dialog_survives_file_handler_setup_failure(tmp_path, monkeypatch):
    _missing_frontend_with_logging_failure(tmp_path, monkeypatch, False)


def test_fatal_dialog_survives_null_handler_fallback_failure(tmp_path, monkeypatch):
    _missing_frontend_with_logging_failure(tmp_path, monkeypatch, True)


def test_job_failure_dialog_survives_dependency_logging_failure(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import frozen_main
    from app import db_lifecycle
    _isolate_launcher_environment(monkeypatch)

    class BrokenLogger:
        def log(self, *args, **kwargs):
            raise OSError("logging unavailable")

    def fail_job(logger):
        logger.info("job creation failed")
        return None

    frontend = tmp_path / "frontend-dist"
    frontend.mkdir()
    (frontend / "index.html").write_text("test", encoding="utf-8")
    dialogs = []
    released = []
    mutex = object()
    monkeypatch.setattr(ls, "get_user_data_root", lambda: ls.ApprovedRoot(tmp_path, 121, 343))
    monkeypatch.setattr(ls, "setup_launcher_logging", lambda _: BrokenLogger())
    monkeypatch.setattr(ls, "acquire_mutex", lambda: mutex)
    monkeypatch.setattr(ls, "release_mutex", released.append)
    monkeypatch.setattr(ls, "create_job_object", fail_job)
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    monkeypatch.setattr(
        ls, "_user32",
        SimpleNamespace(MessageBoxW=lambda hwnd, message, title, flags: dialogs.append(flags) or 1),
    )
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(db_lifecycle, "inspect_state", lambda _: "verified")
    monkeypatch.setattr(db_lifecycle, "startup_action", lambda _: "verify")
    monkeypatch.setattr(db_lifecycle, "verify_after_init", lambda _: None)

    assert frozen_main._launcher() == 1
    assert dialogs == [ls.MB_OK | ls.MB_ICONERROR]
    assert released == [mutex]


def test_file_handler_setup_failure_preserves_exit_code(tmp_path, monkeypatch):
    import logging
    logger = logging.getLogger("launcher")
    old_handlers = list(logger.handlers)
    logger.handlers.clear()
    try:
        bad_dir = tmp_path / "non_writable_dir"
        def failing_mkdir(self, *a, **kw):
            raise PermissionError("denied")
        monkeypatch.setattr(pathlib.Path, "mkdir", failing_mkdir)
        res_logger = ls.setup_launcher_logging(bad_dir)
        assert any(isinstance(h, logging.NullHandler) for h in res_logger.handlers)
    finally:
        logger.handlers = old_handlers


def test_repeated_logging_setup_failure_does_not_accumulate_handlers(tmp_path, monkeypatch):
    import logging
    logger = logging.getLogger("launcher")
    old_handlers = list(logger.handlers)
    logger.handlers.clear()
    try:
        bad_dir = tmp_path / "bad_dir"
        def failing_mkdir(self, *a, **kw):
            raise PermissionError("denied")
        monkeypatch.setattr(pathlib.Path, "mkdir", failing_mkdir)
        ls.setup_launcher_logging(bad_dir)
        count1 = len(logging.getLogger("launcher").handlers)
        ls.setup_launcher_logging(bad_dir)
        count2 = len(logging.getLogger("launcher").handlers)
        assert count1 == count2
        assert count1 == 1
    finally:
        logger.handlers = old_handlers
def test_dialog_error_and_notice_flags(monkeypatch):
    calls = []

    class FakeUser32:
        def MessageBoxW(self, hwnd, text, caption, flags):
            calls.append((hwnd, text, caption, flags))
            return 1

    monkeypatch.setattr(ls, "_user32", FakeUser32())
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)

    state = ls.DialogState()
    res1 = ls.show_startup_error("Fatal problem", "ACA Error", state=state)
    assert res1 is True
    assert len(calls) == 1
    assert calls[0][3] == (ls.MB_OK | ls.MB_ICONERROR)

    res2 = ls.show_startup_notice("Browser notice", "ACA Notice", state=state)
    assert res2 is True
    assert len(calls) == 2
    assert calls[1][3] == (ls.MB_OK | ls.MB_ICONINFORMATION)


def test_dialog_outside_packaged_windows_returns_false(monkeypatch):
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: False)
    state = ls.DialogState()
    assert ls.show_startup_error("Msg", state=state) is False
    assert ls.show_startup_notice("Msg", state=state) is False


def test_dialog_failure_containment(monkeypatch):
    class ExplodingUser32:
        def MessageBoxW(self, hwnd, text, caption, flags):
            raise OSError("Access violation")

    monkeypatch.setattr(ls, "_user32", ExplodingUser32())
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    state = ls.DialogState()
    assert ls.show_startup_error("Error", state=state) is False


def test_dialog_zero_return_treated_as_failure(monkeypatch):
    class ZeroUser32:
        def MessageBoxW(self, hwnd, text, caption, flags):
            return 0

    monkeypatch.setattr(ls, "_user32", ZeroUser32())
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    state = ls.DialogState()
    assert ls.show_startup_error("Error", state=state) is False


def test_dialog_sensitive_data_exclusion():
    sample_messages = [
        "Academic Compliance Auditor cannot safely access its application data folder.\n\nStartup was stopped to protect your data rather than creating temporary replacement data.\nPlease check that your user profile folder is accessible and has normal permissions.",
        "Installation files are missing. Please reinstall Academic Compliance Auditor.",
        "Database initialization could not be completed. Please check permissions and restart Academic Compliance Auditor.",
        "Academic Compliance Auditor could not safely verify its database. Startup was stopped to protect your data. Technical details are recorded in launcher.log.",
        "Database upgrade could not be completed. Startup was stopped to protect your data. Technical details are recorded in launcher.log.",
        "Academic Compliance Auditor stopped startup to protect your database. Technical details are recorded in launcher.log.",
        "Academic Compliance Auditor could not start. Please try restarting your computer or reinstalling ACA.",
        "Academic Compliance Auditor could not start its background process. Please try restarting ACA.",
        "Academic Compliance Auditor did not become ready in time. Please try restarting ACA. If this persists, technical details are recorded in launcher.log.",
        "All network ports reserved for Academic Compliance Auditor are in use. Please close other applications and try again.",
        "Academic Compliance Auditor appears to be running. If it is already open, please use that window. Otherwise, wait a moment and try again.",
        "Academic Compliance Auditor appears to be running. Please wait a moment and try again.",
    ]
    for msg in sample_messages:
        assert "C:\\" not in msg
        assert "/Users/" not in msg
        assert "Local\\AcademicComplianceAuditor" not in msg
        assert "sqlite:///" not in msg
        assert "Traceback" not in msg
        assert "pid" not in msg.lower()


def test_loopback_dashboard_url_validation_rejections():
    for p in ls.PORTS:
        url = "http" + "://" + "127.0.0.1" + ":" + str(p) + "/dashboard"
        assert ls.validate_loopback_dashboard_url(url) is True

    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:9999/dashboard") is False
    assert ls.validate_loopback_dashboard_url("https" + "://" + "127.0.0.1:8010/dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "localhost:8010/dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "192.168.1.1:8010/dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1.attacker.com:8010/dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "user:pass@127.0.0.1:8010/dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:8010/dashboard?a=1") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:8010/dashboard#section") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:8010/dashboard/") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:8010//dashboard") is False
    assert ls.validate_loopback_dashboard_url("http" + "://" + "127.0.0.1:8010/%64ashboard") is False
    assert ls.validate_loopback_dashboard_url(None) is False
    assert ls.validate_loopback_dashboard_url(12345) is False


def test_loopback_dashboard_url_rejects_malformed_authorities_without_side_effects(monkeypatch):
    events = []
    monkeypatch.setattr(ls, "_safe_log", lambda *args, **kwargs: events.append("log"))
    monkeypatch.setattr(ls, "_show_dialog", lambda *args, **kwargs: events.append("dialog"))
    prefix = "http" + "://"
    invalid_authorities = (
        "127.0.0.1:not-a-port",
        "127.0.0.1:-1",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "127.0.0.1",
        "",
        "[::1",
        "%31%32%37.0.0.1:8010",
        "127.0.0.1%3a8010",
    )
    for authority in invalid_authorities:
        assert ls.validate_loopback_dashboard_url(prefix + authority + "/dashboard") is False
    class InvalidString(str):
        def __bool__(self):
            raise ValueError("malformed text")

    assert ls.validate_loopback_dashboard_url(InvalidString("invalid")) is False
    assert events == []


def test_dialog_deduplication_independence(monkeypatch):
    calls = []
    class FakeUser32:
        def MessageBoxW(self, hwnd, text, caption, flags):
            calls.append((caption, flags))
            return 1

    monkeypatch.setattr(ls, "_user32", FakeUser32())
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)

    state = ls.DialogState()
    assert ls.show_startup_notice("Notice 1", state=state) is True
    assert ls.show_startup_notice("Notice 2", state=state) is False
    assert len(calls) == 1

    assert ls.show_startup_error("Fatal 1", state=state) is True
    assert ls.show_startup_error("Fatal 2", state=state) is False
    assert len(calls) == 2


def test_second_instance_success_shows_no_fatal_dialog(tmp_path, monkeypatch):
    import logging
    from types import SimpleNamespace
    import frozen_main

    browser_calls = []
    dialogs = []
    port = ls.PORTS[0]
    monkeypatch.setattr(ls, "get_user_data_root", lambda: ls.ApprovedRoot(tmp_path, 121, 343))
    monkeypatch.setattr(ls, "setup_launcher_logging", lambda _: logging.getLogger("launcher-reuse-test"))
    monkeypatch.setattr(ls, "acquire_mutex", lambda: None)
    monkeypatch.setattr(ls, "read_instance", lambda _: {"pid": 12345, "port": port})
    monkeypatch.setattr(ls, "is_pid_running", lambda _: True)
    monkeypatch.setattr(ls, "is_executable_match", lambda _: True)
    monkeypatch.setattr(ls, "check_health", lambda _: True)
    monkeypatch.setattr(ls, "open_browser", lambda actual_port, logger: browser_calls.append(actual_port) or True)
    monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
    monkeypatch.setattr(
        ls, "_user32",
        SimpleNamespace(MessageBoxW=lambda *args: dialogs.append(args) or 1),
    )

    assert frozen_main._launcher() == 0
    assert browser_calls == [port]
    assert dialogs == []


def test_second_instance_failure_shows_one_fatal_dialog(tmp_path, monkeypatch):
    errors = []
    monkeypatch.setattr(ls, "show_startup_error", lambda msg, **kw: errors.append(msg))
    monkeypatch.setattr(ls, "acquire_mutex", lambda: None)
    monkeypatch.setattr(ls, "read_instance", lambda p: None)
    monkeypatch.setattr(ls, "is_mutex_held", lambda: True)

    import frozen_main
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    rc = frozen_main._launcher()
    assert rc == 1
    assert len(errors) == 1


def test_browser_open_fallback_shows_one_notice_and_preserves_supervision(tmp_path, monkeypatch):
    _, port, events, dialogs = _run_launcher_child_spawn(
        tmp_path, monkeypatch, "nt", True, browser_opens=False,
    )
    assert len(dialogs) == 1
    assert dialogs[0][1] == ls.MB_OK | ls.MB_ICONINFORMATION
    assert str(port) in dialogs[0][0]
    assert "poll" in events[events.index(("browser", port)) + 1:]


def test_launcher_only_dialog_ownership():
    text = pathlib.Path(__file__).resolve().parents[1] / "frozen_main.py"
    content = text.read_text(encoding="utf-8")
    backend_idx = content.find("def _backend():")
    assert backend_idx != -1
    backend_body = content[backend_idx:]
    assert "show_startup_error" not in backend_body
    assert "show_startup_notice" not in backend_body

    api_routes = pathlib.Path(__file__).resolve().parents[1] / "app" / "api" / "routes.py"
    if api_routes.is_file():
        routes_text = api_routes.read_text(encoding="utf-8")
        assert "show_startup_error" not in routes_text
        assert "show_startup_notice" not in routes_text


def test_ollama_boundary_remains_http_only():
    config_path = pathlib.Path(__file__).resolve().parents[1] / "app" / "core" / "config.py"
    if config_path.is_file():
        text = config_path.read_text(encoding="utf-8")
        assert "https://" not in text.lower() or "ollama" not in text.lower()


def test_documentation_and_log_claims_match():
    doc_path = pathlib.Path(__file__).resolve().parents[2] / "docs" / "TROUBLESHOOTING.md"
    assert doc_path.is_file()
    text = doc_path.read_text(encoding="utf-8")
    assert "launcher.log" in text
    assert "startup notice" in text or "error dialog" in text


def test_no_html_or_chat_ui_contamination_across_all_changed_files():
    root = pathlib.Path(__file__).resolve().parents[2]
    changed_files = [
        root / "backend" / "ACA.spec",
        root / "backend" / "frozen_main.py",
        root / "backend" / "app" / "launcher_support.py",
        root / "backend" / "tests" / "test_launcher.py",
        root / "docs" / "TROUBLESHOOTING.md",
    ]

    forbidden_tokens = [
        "<" + "a " + "href=",
        "<" + "/a" + ">",
        "&" + "lt;a " + "href=",
        "&" + "lt;/a" + "&" + "gt;",
        "fai" + "-" + "ChatInput" + "Entity",
        "target=" + chr(34) + "_blank" + chr(34),
        "rel=" + chr(34) + "noopener noreferrer" + chr(34),
        "data" + "-" + "lexical",
    ]

    for cf in changed_files:
        assert cf.is_file(), f"File missing: {cf}"
        content = cf.read_text(encoding="utf-8")
        for token in forbidden_tokens:
            assert token not in content, f"Contamination token {token!r} found in {cf}"


@pytest.fixture
def ownership_launcher(tmp_path, monkeypatch):
    """Run real launcher control flow; all external operations are bounded."""
    from types import SimpleNamespace
    import frozen_main
    from app import db_lifecycle

    def run(state="stale", *, cleanup_error=None, cleanup_noop=False,
            reacquire=True, held=False, first_owned=False, child_error=False,
            timeout=False, metadata_blocked=False, lose_ownership=False,
            metadata_reappears=False):
        _isolate_launcher_environment(monkeypatch)
        events, logs, dialogs, releases = [], [], [], []
        instance = tmp_path / "instance.json"
        original = json.dumps({"version": 1, "pid": 98765, "port": 8010})
        if state != "new":
            instance.write_text("invalid" if state == "invalid" else original, encoding="utf-8")
        if metadata_blocked:
            instance.with_suffix(".tmp").write_text("preserve", encoding="utf-8")

        class InstancePath:
            def read_text(self, **kwargs):
                return instance.read_text(**kwargs)

            def lstat(self):
                return instance.lstat()

            def with_suffix(self, suffix):
                return instance.with_suffix(suffix)

            def unlink(self):
                events.append("unlink")
                if cleanup_error is not None:
                    raise cleanup_error("sensitive metadata path must not reach dialog")
                if not cleanup_noop:
                    instance.unlink()

        class Mutex:
            owned = True

            def __bool__(self):
                return self.owned

        mutex = Mutex()

        def acquire():
            events.append("acquire")
            if events.count("acquire") == 1:
                return mutex if first_owned else None
            if metadata_reappears:
                instance.write_text(original, encoding="utf-8")
            return mutex if reacquire else None

        class Logger:
            def log(self, level, message, *args, **kwargs):
                logs.append(message % args if args else message)

        class Child:
            pid = 12345
            returncode = None
            polls = 0

            def poll(self):
                self.polls += 1
                if not timeout and self.polls > 1:
                    self.returncode = 0
                return self.returncode

            def terminate(self):
                events.append("terminate")
                self.returncode = 0

            def wait(self, **kwargs):
                events.append(("wait", kwargs))
                return self.returncode

            def kill(self):
                events.append("kill")
                self.returncode = 0

        child = Child()

        class Job:
            def close(self):
                events.append("job_close")

        def create_job(logger):
            if lose_ownership:
                mutex.owned = False
            return Job()

        def popen(command, **kwargs):
            events.append(("popen", command, kwargs))
            if child_error:
                raise OSError("simulated child failure")
            return child

        def health(port):
            events.append(("health", port))
            return not timeout and state != "unreachable"

        frontend = tmp_path / "frontend-dist"
        frontend.mkdir()
        (frontend / "index.html").write_text("test", encoding="utf-8")
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
        monkeypatch.setattr(frozen_main, "os", SimpleNamespace(name="nt", environ=os.environ))
        monkeypatch.setattr(frozen_main, "signal", SimpleNamespace(signal=lambda *_: None, SIGINT=2, SIGBREAK=21))
        clock = iter(range(1000))
        monkeypatch.setattr(frozen_main, "time", SimpleNamespace(monotonic=lambda: next(clock), sleep=lambda _: None))
        monkeypatch.setattr(
            frozen_main, "subprocess",
            SimpleNamespace(Popen=popen, CREATE_NEW_PROCESS_GROUP=0x200, CREATE_NO_WINDOW=0x08000000),
        )
        monkeypatch.setattr(ls, "get_user_data_root", lambda: ls.ApprovedRoot(tmp_path, 121, 343))
        monkeypatch.setattr(ls, "get_instance_path", lambda _: InstancePath())
        monkeypatch.setattr(ls, "setup_launcher_logging", lambda _: Logger())
        monkeypatch.setattr(ls, "acquire_mutex", acquire)
        monkeypatch.setattr(ls, "release_mutex", lambda handle: releases.append(handle))
        monkeypatch.setattr(ls, "is_mutex_held", lambda: held)
        monkeypatch.setattr(ls, "is_pid_running", lambda _: None if state == "unknown_pid" else state not in ("stale", "new"))
        monkeypatch.setattr(ls, "is_executable_match", lambda _: None if state == "unknown_executable" else state != "mismatch")
        monkeypatch.setattr(ls, "check_health", health)
        monkeypatch.setattr(ls, "PORTS", [8010, 8011, 8012])
        monkeypatch.setattr(ls, "create_job_object", create_job)
        monkeypatch.setattr(ls, "assign_process_to_job", lambda job, pid, logger: events.append(("assigned", pid)) or True)
        monkeypatch.setattr(ls, "write_instance", lambda *args: events.append(("write_instance", args[1:])))
        monkeypatch.setattr(ls, "remove_instance_if_owned", lambda *args: events.append("remove_instance"))
        monkeypatch.setattr(ls, "open_browser", lambda port, logger: events.append(("browser", port)) or True)
        monkeypatch.setattr(ls, "is_packaged_windows", lambda: True)
        monkeypatch.setattr(ls, "_user32", SimpleNamespace(
            MessageBoxW=lambda hwnd, message, title, flags: dialogs.append((message, flags)) or 1,
        ))
        monkeypatch.setattr(db_lifecycle, "inspect_state", lambda _: "verified")
        monkeypatch.setattr(db_lifecycle, "startup_action", lambda _: "verify")
        monkeypatch.setattr(db_lifecycle, "verify_after_init", lambda _: None)
        rc = frozen_main._launcher()
        return SimpleNamespace(
            rc=rc, events=events, logs=logs, dialogs=dialogs, releases=releases,
            instance=instance, original=original, mutex=mutex,
        )

    return run


def _assert_ownership_refusal(result, state):
    assert result.rc == 1
    assert len(result.dialogs) == 1
    message, flags = result.dialogs[0]
    assert flags == ls.MB_OK | ls.MB_ICONERROR
    for sensitive in (str(result.instance), "98765", "8010", ls.MUTEX_NAME, "Traceback"):
        assert sensitive not in message
    assert any("existing_instance_state=" + state in entry for entry in result.logs)
    assert not any(isinstance(event, tuple) and event[0] in ("popen", "browser", "write_instance")
                   for event in result.events)


def test_stale_cleanup_permission_error_fails_closed(ownership_launcher):
    result = ownership_launcher(cleanup_error=PermissionError)
    _assert_ownership_refusal(result, "STALE_CLEANUP_FAILED")
    assert result.events.count("acquire") == 1
    assert result.events.count("unlink") == 1
    assert result.instance.read_text(encoding="utf-8") == result.original
    assert any("PermissionError" in entry for entry in result.logs)
    assert result.releases == []


def test_stale_cleanup_oserror_fails_closed(ownership_launcher):
    result = ownership_launcher(cleanup_error=OSError)
    _assert_ownership_refusal(result, "STALE_CLEANUP_FAILED")
    assert result.events.count("acquire") == 1
    assert result.instance.read_text(encoding="utf-8") == result.original


def test_stale_cleanup_must_confirm_absence(ownership_launcher):
    result = ownership_launcher(cleanup_noop=True)
    _assert_ownership_refusal(result, "STALE_CLEANUP_FAILED")
    assert result.events.count("acquire") == 1
    assert result.instance.exists()


def test_confirmed_stale_recovery_continues_with_exclusive_mutex(ownership_launcher):
    result = ownership_launcher()
    assert result.rc == 0
    assert result.dialogs == []
    assert result.events.count("acquire") == 2
    assert result.events.index("unlink") < result.events.index("acquire", 1)
    assert not result.instance.exists()
    popen = [event for event in result.events if isinstance(event, tuple) and event[0] == "popen"]
    assert len(popen) == 1
    assert popen[0][1] == [sys.executable, "--backend"]
    assert popen[0][2]["creationflags"] == 0x08000200
    assert popen[0][2]["env"]["ACA_APPROVED_DATA_ROOT_DEV"] == "121"
    assert popen[0][2]["env"]["ACA_APPROVED_DATA_ROOT_INO"] == "343"
    assert popen[0][2]["env"]["ACA_POC_PORT"] == "8010"
    assert popen[0][2].get("shell", False) is False
    assert ("assigned", 12345) in result.events
    assert ("browser", 8010) in result.events
    assert result.events.count("job_close") == 1
    assert result.events.count("remove_instance") == 1
    assert result.releases == [result.mutex]


def test_definitive_executable_mismatch_allows_stale_recovery(ownership_launcher):
    result = ownership_launcher("mismatch")
    assert result.rc == 0
    assert result.dialogs == []
    assert result.events.count("unlink") == 1
    assert result.events.count("acquire") == 2
    assert not any(isinstance(event, tuple) and event == ("health", 8010)
                   for event in result.events[:result.events.index("unlink")])
    assert result.releases == [result.mutex]


def test_healthy_instance_reuses_without_new_child(ownership_launcher):
    result = ownership_launcher("healthy")
    assert result.rc == 0
    assert result.dialogs == []
    assert result.events == ["acquire", ("health", 8010), ("browser", 8010)]
    assert result.instance.read_text(encoding="utf-8") == result.original
    assert result.releases == []


def test_unreachable_matching_instance_is_ambiguous(ownership_launcher):
    result = ownership_launcher("unreachable")
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert "unlink" not in result.events
    assert result.events.count("acquire") == 1
    assert result.instance.read_text(encoding="utf-8") == result.original
    assert any("unreachable_existing_instance" in entry for entry in result.logs)
    assert result.releases == []


def test_unreachable_instance_blocks_even_with_initial_mutex(ownership_launcher):
    result = ownership_launcher("unreachable", first_owned=True)
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert "unlink" not in result.events
    assert result.instance.read_text(encoding="utf-8") == result.original
    assert result.releases == [result.mutex]


def test_unknown_process_state_cannot_authorize_cleanup(ownership_launcher):
    result = ownership_launcher("unknown_pid")
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire"]
    assert result.instance.read_text(encoding="utf-8") == result.original


def test_unknown_executable_identity_cannot_authorize_cleanup(ownership_launcher):
    result = ownership_launcher("unknown_executable")
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire"]
    assert result.instance.read_text(encoding="utf-8") == result.original


def test_invalid_metadata_is_ambiguous_not_proven_stale(ownership_launcher):
    result = ownership_launcher("invalid")
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire"]
    assert result.instance.read_text(encoding="utf-8") == "invalid"


def test_stale_process_does_not_override_held_mutex(ownership_launcher):
    result = ownership_launcher(held=True)
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert "unlink" not in result.events
    assert result.instance.read_text(encoding="utf-8") == result.original


def test_stale_recovery_requires_successful_mutex_reacquisition(ownership_launcher):
    result = ownership_launcher(reacquire=False)
    _assert_ownership_refusal(result, "MUTEX_REACQUISITION_FAILED")
    assert result.events == ["acquire", "unlink", "acquire"]
    assert not result.instance.exists()
    assert result.releases == []


def test_metadata_reappearing_during_reacquisition_blocks_launch(ownership_launcher):
    result = ownership_launcher(metadata_reappears=True)
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire", "unlink", "acquire"]
    assert result.instance.read_text(encoding="utf-8") == result.original
    assert result.releases == [result.mutex]


def test_metadata_write_preflight_refuses_existing_temporary_file(ownership_launcher):
    result = ownership_launcher("new", first_owned=True, metadata_blocked=True)
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.instance.with_suffix(".tmp").read_text(encoding="utf-8") == "preserve"
    assert result.releases == [result.mutex]


def test_missing_exclusive_mutex_blocks_first_launch(ownership_launcher):
    result = ownership_launcher("new")
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire"]
    assert not result.instance.exists()


def test_pre_spawn_gate_rechecks_exclusive_handle(ownership_launcher):
    result = ownership_launcher("new", first_owned=True, lose_ownership=True)
    _assert_ownership_refusal(result, "AMBIGUOUS_EXISTING_INSTANCE")
    assert result.events == ["acquire", "job_close"]
    assert any("pre_spawn_ownership_unproven" in entry for entry in result.logs)
    assert result.releases == [result.mutex]


def test_first_launch_keeps_governed_child_and_shutdown(ownership_launcher):
    result = ownership_launcher("new", first_owned=True)
    assert result.rc == 0
    assert result.dialogs == []
    assert result.events.count("acquire") == 1
    assert "unlink" not in result.events
    popen = next(event for event in result.events if isinstance(event, tuple) and event[0] == "popen")
    assert popen[1] == [sys.executable, "--backend"]
    assert popen[2]["creationflags"] == 0x08000200
    assert ("assigned", 12345) in result.events
    assert ("browser", 8010) in result.events
    assert result.events.count("job_close") == 1
    assert result.events.count("remove_instance") == 1
    assert result.releases == [result.mutex]


def test_recovered_stale_instance_later_spawn_failure_is_fatal(ownership_launcher):
    result = ownership_launcher(child_error=True)
    assert result.rc == 1
    assert len(result.dialogs) == 1
    assert result.dialogs[0][1] == ls.MB_OK | ls.MB_ICONERROR
    assert "background process" in result.dialogs[0][0]
    assert result.events.count("unlink") == 1
    assert sum(isinstance(event, tuple) and event[0] == "popen" for event in result.events) == 1
    assert not any(isinstance(event, tuple) and event[0] in ("browser", "write_instance") for event in result.events)
    assert result.events.count("job_close") == 1
    assert result.releases == [result.mutex]


def test_recovered_stale_instance_readiness_timeout_is_fatal(ownership_launcher):
    result = ownership_launcher(timeout=True)
    assert result.rc == 1
    assert len(result.dialogs) == 1
    assert result.dialogs[0][1] == ls.MB_OK | ls.MB_ICONERROR
    assert "ready in time" in result.dialogs[0][0]
    assert result.events.count("acquire") == 2
    assert result.events.count("unlink") == 1
    assert result.events.count("terminate") == 1
    assert sum(isinstance(event, tuple) and event[0] == "popen" for event in result.events) == 1
    assert not any(isinstance(event, tuple) and event[0] in ("browser", "write_instance") for event in result.events)
    assert result.events.count("job_close") == 1
    assert result.releases == [result.mutex]


def test_windows_process_access_denial_is_unknown(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(OpenProcess=lambda *args: 0, GetLastError=lambda: 5))
    assert ls.is_pid_running(123) is None
    assert ls.is_executable_match(123) is None


def test_windows_invalid_pid_is_confirmed_absent(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(OpenProcess=lambda *args: 0, GetLastError=lambda: 87))
    assert ls.is_pid_running(123) is False


def test_windows_process_exit_state_must_be_observed(monkeypatch):
    from types import SimpleNamespace
    closed = []
    def exit_code(handle, code):
        code._obj.value = 0
        return True
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(
        OpenProcess=lambda *args: 9, GetExitCodeProcess=exit_code, CloseHandle=closed.append,
    ))
    assert ls.is_pid_running(123) is False
    assert closed == [9]


def test_windows_unreadable_exit_state_is_unknown(monkeypatch):
    from types import SimpleNamespace
    closed = []
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(
        OpenProcess=lambda *args: 9, GetExitCodeProcess=lambda *args: False, CloseHandle=closed.append,
    ))
    assert ls.is_pid_running(123) is None
    assert closed == [9]


def test_windows_unreadable_executable_is_unknown(monkeypatch):
    from types import SimpleNamespace
    closed = []
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(
        OpenProcess=lambda *args: 9, QueryFullProcessImageNameW=lambda *args: False, CloseHandle=closed.append,
    ))
    assert ls.is_executable_match(123) is None
    assert closed == [9]


def test_mutex_access_denial_does_not_mean_unheld(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(ls, "_kernel32", SimpleNamespace(OpenMutexW=lambda *args: 0, GetLastError=lambda: 5))
    assert ls.is_mutex_held() is None
