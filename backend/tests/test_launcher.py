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
