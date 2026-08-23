"""PyInstaller entry — Phase 2 launcher + backend."""
import os
import sys
import time
import subprocess
import signal
from pathlib import Path


def _launcher():
    from app.launcher_support import (
        get_user_data_root, configure_launcher_environment, get_log_dir,
        get_instance_path, setup_launcher_logging, acquire_mutex, release_mutex,
        is_mutex_held, read_instance, write_instance, remove_instance_if_owned,
        is_pid_running, is_executable_match, check_health,
        open_browser, create_job_object, assign_process_to_job,
        PORTS, SHUTDOWN_TIMEOUT,
    )

    root, used_fallback, warning = get_user_data_root()
    log_dir = get_log_dir(root)
    logger = setup_launcher_logging(log_dir)
    inst_path = get_instance_path(root)

    if used_fallback and warning:
        logger.info("user_data_fallback")
        print(warning)

    mutex = acquire_mutex()
    if mutex is None:
        data = read_instance(inst_path)
        # verified reuse: pid+exe+health all must pass
        if data and is_pid_running(data["pid"]) and is_executable_match(data["pid"]) and check_health(data["port"]):
            logger.info("second_launch_reuse port=%s pid=%s", data["port"], data["pid"])
            if not open_browser(data["port"], logger):
                print(f"ACA is running at http://127.0.0.1:{data['port']}/dashboard")
            return 0
        if is_mutex_held():
            logger.info("second_launch_held_invalid_metadata")
            print("ACA appears to be running. Please close the existing window and try again.")
            return 1
        # stale file but mutex free -> remove and retry
        try:
            inst_path.unlink(missing_ok=True)
        except Exception:
            pass
        mutex = acquire_mutex()
        if mutex is None:
            print("ACA appears to be running. Please try again.")
            return 1

    logger.info("mutex_acquired")
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        cands = []
        if meipass:
            cands.append(Path(meipass) / "frontend-dist")
        cands.append(Path(sys.executable).resolve().parent / "frontend-dist")
        if not any((c / "index.html").is_file() for c in cands):
            logger.info("missing_frontend_resources")
            print("Installation files are missing. Please reinstall ACA.")
            release_mutex(mutex)
            return 1

    configure_launcher_environment(root)

    # handle Ctrl+C / console close
    should_exit = {"flag": False}

    def _sig_handler(signum, frame):
        should_exit["flag"] = True

    try:
        signal.signal(signal.SIGINT, _sig_handler)
        if os.name == "nt":
            signal.signal(signal.SIGBREAK, _sig_handler)
    except Exception:
        pass

    # Job Object: must succeed or fail startup safely — never launch unmanaged backend
    job = create_job_object(logger)
    if job is None:
        logger.info("job_create_failed_startup_abort")
        print("ACA could not start. Please try again.")
        release_mutex(mutex)
        return 1

    last_error = None
    chosen_port = None
    proc = None

    for port in PORTS:
        env = os.environ.copy()
        env["ACA_POC_PORT"] = str(port)
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--backend"]
        else:
            cmd = [sys.executable, "-m", "backend.frozen_main", "--backend"]
        try:
            proc = subprocess.Popen(cmd, env=env, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0)
            # Assign exact child to Job Object immediately
            if not assign_process_to_job(job, proc.pid, logger):
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                logger.info("job_assign_failed_abort port=%s", port)
                print("ACA could not start. Please try again.")
                job.close()
                release_mutex(mutex)
                return 1
        except Exception as e:
            logger.info("child_spawn_failed port=%s category=%s", port, type(e).__name__)
            print("ACA could not start. Please try again.")
            job.close()
            release_mutex(mutex)
            return 1

        # wait for health, exit, or Ctrl+C
        deadline = time.monotonic() + 15
        health_ok = False
        while time.monotonic() < deadline:
            if should_exit["flag"]:
                proc.terminate()
                try:
                    proc.wait(timeout=SHUTDOWN_TIMEOUT)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                release_mutex(mutex)
                return 0
            if proc.poll() is not None:
                logger.info("child_exited port=%s code=%s", port, proc.returncode)
                break
            if check_health(port):
                health_ok = True
                break
            time.sleep(0.5)
        if health_ok:
            chosen_port = port
            logger.info("health_ok port=%s", port)
            break
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=SHUTDOWN_TIMEOUT)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            logger.info("health_timeout port=%s", port)
            last_error = "health_timeout"
            break
        last_error = "bind_failed"
        proc = None
        continue

    if chosen_port is None:
        if last_error == "health_timeout":
            print("ACA did not become ready in time. Please try again.")
            logger.info("startup_failed health_timeout")
            try:
                print("If this persists, the database may need an update.")
            except Exception:
                pass
        else:
            print("All network ports are in use. Please close other applications and try again.")
            logger.info("startup_failed ports_unavailable")
        job.close()
        release_mutex(mutex)
        return 1

    # Immutable instance — health → write → browser all use same port
    running = None
    try:
        from app.launcher_support import RunningInstance
        running = RunningInstance.from_port_pid(chosen_port, proc.pid)
    except Exception:
        running = None
    if running is None:
        logger.info("running_instance_build_failed port=%s pid=%s", chosen_port, proc.pid)
        job.close()
        release_mutex(mutex)
        return 1

    write_instance(inst_path, running.pid, running.port)
    logger.info("instance_written pid=%s port=%s url=%s", running.pid, running.port, running.url)

    if not open_browser(running.port, logger):
        print(f"ACA is running at {running.url}")

    print(f"ACA running at {running.url} - close this window to stop.")

    try:
        while True:
            if should_exit["flag"]:
                logger.info("shutdown_reason=ctrl_c")
                print("\nShutting down ACA...")
                break
            ret = proc.poll()
            if ret is not None:
                logger.info("backend_exited code=%s", ret)
                print("ACA has stopped.")
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        logger.info("shutdown_reason=ctrl_c")
        print("\nShutting down ACA...")
    finally:
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=SHUTDOWN_TIMEOUT)
                except Exception:
                    proc.kill()
                    proc.wait(timeout=2)
            except Exception:
                pass
        try:
            remove_instance_if_owned(inst_path, proc.pid if proc else -1, chosen_port if chosen_port else -1)
        except Exception:
            pass
        try:
            job.close()
        except Exception:
            pass
        release_mutex(mutex)
        logger.info("shutdown_complete")
    return 0


def _backend():
    from app.launcher_support import get_user_data_root, configure_launcher_environment
    root, _, _ = get_user_data_root()
    configure_launcher_environment(root)
    from app.main import app as fastapi_app
    import uvicorn
    port = int(os.environ.get("ACA_POC_PORT", "8010"))
    uvicorn.run(fastapi_app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    if "--backend" in sys.argv:
        _backend()
    else:
        try:
            sys.exit(_launcher())
        except KeyboardInterrupt:
            sys.exit(0)
