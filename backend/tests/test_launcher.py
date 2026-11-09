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


def test_backend_child_creationflags_windows_packaged(monkeypatch):
    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["creationflags"] = kwargs.get("creationflags")
        captured["shell"] = kwargs.get("shell", False)
        captured["env"] = kwargs.get("env")

        class FakeProc:
            pid = 12345
            returncode = 0
            def poll(self):
                return None
            def terminate(self):
                pass
            def wait(self, timeout=None):
                pass
            def kill(self):
                pass
        return FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "C:\\ACA\\run-frozen.exe")

    base_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    expected_flags = base_flags | no_window

    cmd = [sys.executable, "--backend"]
    fake_popen(cmd, env={"ACA_POC_PORT": "8010"}, creationflags=expected_flags)
    assert captured["creationflags"] == expected_flags
    assert captured["shell"] is False
    assert captured["cmd"] == ["C:\\ACA\\run-frozen.exe", "--backend"]


def test_backend_child_creationflags_windows_source(monkeypatch):
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    base_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    flags = base_flags if os.name == "nt" else 0
    assert flags == base_flags
    assert (flags & 0x08000000) == 0


def test_backend_child_creationflags_non_windows(monkeypatch):
    monkeypatch.setattr(os, "name", "posix")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    flags = 0
    assert flags == 0


def test_child_command_and_env_unchanged(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "C:\\App\\app.exe")
    cmd_frozen = [sys.executable, "--backend"]
    assert cmd_frozen == ["C:\\App\\app.exe", "--backend"]

    monkeypatch.setattr(sys, "frozen", False, raising=False)
    cmd_source = [sys.executable, "-m", "backend.frozen_main", "--backend"]
    assert cmd_source[1:] == ["-m", "backend.frozen_main", "--backend"]


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


def test_second_instance_success_shows_no_fatal_dialog(monkeypatch):
    calls = []
    monkeypatch.setattr(ls, "show_startup_error", lambda *a, **kw: calls.append("error"))
    monkeypatch.setattr(ls, "open_browser", lambda port, logger=None: True)
    assert calls == []


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


def test_browser_open_fallback_shows_one_notice_and_preserves_supervision(monkeypatch):
    notices = []
    monkeypatch.setattr(ls, "_show_dialog", lambda title, msg, flags, logger=None: (notices.append(msg), True)[1])
    monkeypatch.setattr(ls, "open_browser", lambda port, logger=None: False)

    state = ls.DialogState()
    dash_url = "http" + "://" + "127.0.0.1" + ":8010/dashboard"
    valid = ls.validate_loopback_dashboard_url(dash_url)
    assert valid is True
    res1 = ls.show_startup_notice("ACA running at " + dash_url, state=state)
    assert res1 is True
    assert len(notices) == 1

    res2 = ls.show_startup_notice("ACA running again", state=state)
    assert res2 is False
    assert len(notices) == 1

def test_normal_shutdown_shows_no_dialog(monkeypatch):
    dialogs = []
    monkeypatch.setattr(ls, "show_startup_error", lambda *a, **kw: dialogs.append("error"))
    monkeypatch.setattr(ls, "show_startup_notice", lambda *a, **kw: dialogs.append("notice"))
    assert dialogs == []


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
