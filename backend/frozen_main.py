"""PyInstaller entry — Phase 2 launcher + backend."""
import os
import sys
import time
import subprocess
import signal
import logging
from pathlib import Path

def _safe_print(*args, **kwargs):
    if getattr(sys, "frozen", False):
        return
    stream = kwargs.get("file")
    if stream is None:
        stream = sys.stdout
    if stream is None:
        return
    try:
        sep = kwargs.get("sep", " ")
        end = kwargs.get("end", "\n")
        msg = sep.join(str(a) for a in args) + end
        stream.write(msg)
        if kwargs.get("flush", False):
            stream.flush()
    except Exception:
        pass


def _launcher():
    logger = None
    from app.launcher_support import (
        get_user_data_root, configure_launcher_environment, get_log_dir,
        get_instance_path, setup_launcher_logging, acquire_mutex, release_mutex,
        is_mutex_held, read_instance, write_instance, remove_instance_if_owned,
        is_pid_running, is_executable_match, check_health,
        open_browser, create_job_object, assign_process_to_job,
        RootResolutionError, revalidate_child_approved_root,
        PORTS, SHUTDOWN_TIMEOUT, DialogState, show_startup_error,
        show_startup_notice, validate_loopback_dashboard_url, _safe_log, _SafeLogger,
        _verify_instance_write, BACKEND_LOGGING_FAILURE_EXIT_CODE,
        new_startup_attempt, consume_startup_failure, cleanup_startup_attempt,
        startup_failure_present,
    )

    dialog_state = DialogState()

    try:
        approved_root = get_user_data_root()
    except RootResolutionError as e:
        try:
            logger = logging.getLogger("launcher")
            logger.setLevel(logging.INFO)
        except Exception:
            logger = None
        _safe_log(logger, logging.INFO, "root_resolution_failed category=%s", e.code)
        dialog_msg = (
            "Academic Compliance Auditor cannot safely access its application data folder.\n\n"
            "Startup was stopped to protect your data rather than creating temporary replacement data.\n"
            "Please check that your user profile folder is accessible and has normal permissions."
        )
        show_startup_error(dialog_msg, state=dialog_state, logger=logger)
        _safe_print("Academic Compliance Auditor cannot safely access its application data folder.")
        _safe_print("Startup was stopped to protect your data rather than creating temporary replacement data.")
        _safe_print("Please check that your Windows user profile folder is accessible and has normal permissions.")
        return 1
    root = approved_root.path
    log_dir = get_log_dir(root)
    try:
        logger = _SafeLogger(setup_launcher_logging(log_dir), {})
    except Exception:
        logger = None
    inst_path = get_instance_path(root)
    mutex = acquire_mutex()
    instance_state = "AMBIGUOUS_EXISTING_INSTANCE"
    reason = "metadata_invalid_or_missing"

    def refuse_instance(state, category, message=(
        "ACA may already be running, but the existing session could not be reached.\n\n"
        "Close any existing ACA windows, wait a moment, and try again."
    )):
        _safe_log(logger, logging.WARNING, "existing_instance_state=%s category=%s", state, category)
        show_startup_error(message, state=dialog_state, logger=logger)
        _safe_print(message)
        if mutex is not None:
            release_mutex(mutex)
        return 1

    try:
        data = read_instance(inst_path)
        if data:
            running = is_pid_running(data["pid"])
            if running is False:
                instance_state = "CONFIRMED_STALE_INSTANCE"
            elif running is True:
                matches = is_executable_match(data["pid"])
                if matches is False:
                    instance_state = "CONFIRMED_STALE_INSTANCE"
                elif matches is True:
                    if check_health(data["port"]) is True:
                        instance_state = "HEALTHY_EXISTING_INSTANCE"
                    else:
                        reason = "unreachable_existing_instance"
                else:
                    reason = "executable_identity_unknown"
            else:
                reason = "process_state_unknown"
        elif mutex:
            try:
                inst_path.lstat()
            except FileNotFoundError:
                instance_state = "NEW_INSTANCE"
    except (OSError, TypeError, ValueError) as exc:
        instance_state = "AMBIGUOUS_EXISTING_INSTANCE"
        reason = type(exc).__name__
    _safe_log(logger, logging.INFO, "existing_instance_state=%s", instance_state)

    if instance_state == "HEALTHY_EXISTING_INSTANCE":
        _safe_log(logger, logging.INFO, "second_launch_reuse port=%s pid=%s", data["port"], data["pid"])
        if not open_browser(data["port"], logger):
            dash_url = "http" + "://" + "127.0.0.1" + ":" + str(data["port"]) + "/dashboard"
            if validate_loopback_dashboard_url(dash_url):
                _safe_log(logger, logging.INFO, "browser_open_fallback url=%s", dash_url)
                notice_msg = (
                    "Academic Compliance Auditor is running, but the browser could not be opened automatically.\n\n"
                    "Please open your browser and go to:\n"
                    + dash_url
                )
                show_startup_notice(notice_msg, state=dialog_state, logger=logger)
            else:
                _safe_log(logger, logging.WARNING, "invalid_dashboard_url")
                notice_msg = (
                    "Academic Compliance Auditor is running, but the browser could not be opened automatically.\n\n"
                    "Please open your web browser and navigate to the ACA Dashboard."
                )
                show_startup_notice(notice_msg, state=dialog_state, logger=logger)
            _safe_print("ACA is running at http://127.0.0.1:" + str(data["port"]) + "/dashboard")
        if mutex is not None:
            release_mutex(mutex)
        return 0
    if instance_state == "AMBIGUOUS_EXISTING_INSTANCE":
        return refuse_instance(instance_state, reason)
    if instance_state == "CONFIRMED_STALE_INSTANCE":
        if not mutex and is_mutex_held() is not False:
            return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "mutex_ownership_unproven")
        try:
            if read_instance(inst_path) != data:
                return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "metadata_changed")
            inst_path.unlink()
            try:
                inst_path.lstat()
            except FileNotFoundError:
                pass
            else:
                raise OSError("stale metadata still present")
        except OSError as exc:
            return refuse_instance(
                "STALE_CLEANUP_FAILED", type(exc).__name__,
                "ACA could not safely remove stale session metadata.\n\n"
                "Close any existing ACA windows, wait a moment, and try again.",
            )
        if not mutex:
            mutex = acquire_mutex()
        if not mutex:
            return refuse_instance("MUTEX_REACQUISITION_FAILED", "mutex_unavailable")
        try:
            inst_path.lstat()
        except FileNotFoundError:
            pass
        except OSError as exc:
            return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", type(exc).__name__)
        else:
            return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "metadata_reappeared")

    if not mutex:
        return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "exclusive_ownership_unproven")
    metadata_ready = _verify_instance_write(inst_path, logger)
    if not metadata_ready:
        return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "metadata_write_unproven")

    _safe_log(logger, logging.INFO, "mutex_acquired")
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        cands = []
        if meipass:
            cands.append(Path(meipass) / "frontend-dist")
        cands.append(Path(sys.executable).resolve().parent / "frontend-dist")
        if not any((c / "index.html").is_file() for c in cands):
            _safe_log(logger, logging.INFO, "missing_frontend_resources")
            msg = "Installation files are missing. Please reinstall Academic Compliance Auditor."
            show_startup_error(msg, state=dialog_state, logger=logger)
            _safe_print("Installation files are missing. Please reinstall ACA.")
            release_mutex(mutex)
            return 1

    configure_launcher_environment(approved_root)

    # --- Phase 3A: database preflight before backend import ---
    from pathlib import Path as _P
    from app.db_lifecycle import inspect_state, init_fresh_database, verify_after_init

    db_url = os.environ["DATABASE_URL"]
    # Derive filesystem path from sqlite url
    if db_url.startswith("sqlite:///"):
        raw = db_url[len("sqlite:///"):]
        db_path = _P(raw) if raw.startswith("/") else _P(raw).resolve()
        # Handle sqlite://// case (absolute with extra /)
        if db_url.startswith("sqlite:////") :
            db_path = _P("/" + raw.lstrip("/"))
    else:
        db_path = None

    if db_path is not None:
        from app.db_lifecycle import startup_action, recovery_message

        state = inspect_state(db_path)
        action = startup_action(state)
        if action == "fresh":
            msg = init_fresh_database(db_path, db_url, logger)
            if msg:
                _safe_print(msg)
                _safe_log(logger, logging.INFO, "db_init_failed state=%s", state)
                dialog_msg = "Database initialization could not be completed. Please check permissions and restart Academic Compliance Auditor."
                show_startup_error(dialog_msg, state=dialog_state, logger=logger)
                release_mutex(mutex)
                return 1
            _safe_log(logger, logging.INFO, "db_fresh_initialized")
        elif action == "verify":
            vmsg = verify_after_init(db_path)
            if vmsg:
                _safe_print(recovery_message(root))
                _safe_log(logger, logging.INFO, "db_verify_failed msg=%s", vmsg)
                dialog_msg = "Academic Compliance Auditor could not safely verify its database. Startup was stopped to protect your data. Technical details are recorded in launcher.log."
                show_startup_error(dialog_msg, state=dialog_state, logger=logger)
                release_mutex(mutex)
                return 1
            _safe_log(logger, logging.INFO, "db_at_head_verified")
        elif action == "upgrade":
            from app.db_lifecycle import upgrade_existing_database
            msg = upgrade_existing_database(db_path, db_url, root, logger)
            if msg:
                _safe_print(msg)
                _safe_log(logger, logging.INFO, "db_upgrade_failed")
                dialog_msg = "Database upgrade could not be completed. Startup was stopped to protect your data. Technical details are recorded in launcher.log."
                show_startup_error(dialog_msg, state=dialog_state, logger=logger)
                release_mutex(mutex)
                return 1
            _safe_log(logger, logging.INFO, "db_upgraded")
            # Re-verify after upgrade already done inside upgrade_existing_database
        else:
            # Fail closed before any database write: no fresh initialization,
            # no Alembic upgrade, no sidecar cleanup.
            _safe_print(recovery_message(root))
            _safe_log(logger, logging.INFO, "db_startup_refused state=%s", state)
            dialog_msg = "Academic Compliance Auditor stopped startup to protect your database. Technical details are recorded in launcher.log."
            show_startup_error(dialog_msg, state=dialog_state, logger=logger)
            release_mutex(mutex)
            return 1

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
        _safe_log(logger, logging.INFO, "job_create_failed_startup_abort")
        dialog_msg = "Academic Compliance Auditor could not start. Please try restarting your computer or reinstalling ACA."
        show_startup_error(dialog_msg, state=dialog_state, logger=logger)
        _safe_print("ACA could not start. Please try again.")
        release_mutex(mutex)
        return 1

    last_error = None
    chosen_port = None
    proc = None
    attempt = None

    def refuse_startup(category, code=1):
        try:
            if attempt is not None:
                cleanup_startup_attempt(attempt, approved_root)
        except OSError:
            category = "UNEXPECTED_STARTUP_FAILURE"
            _safe_log(logger, logging.ERROR, "startup_status_cleanup_failed")
        _safe_log(logger, logging.ERROR, "startup_failure category=%s", category)
        if category in ("DATABASE_RECONCILIATION_REFUSAL", "DATABASE_UPGRADE_OR_VERIFICATION_FAILURE"):
            message = (
                "ACA could not safely open or verify your existing data. "
                "Startup stopped to protect your data. Your existing data was preserved.\n\n"
                "Close ACA and consult the troubleshooting recovery guidance or launcher logs for help."
            )
        else:
            message = (
                "Academic Compliance Auditor could not start its background process. "
                "Please close ACA and consult the troubleshooting guidance or launcher logs for help."
            )
        show_startup_error(message, state=dialog_state, logger=logger)
        job.close()
        release_mutex(mutex)
        return code

    for port in PORTS:
        env = os.environ.copy()
        env["ACA_POC_PORT"] = str(port)
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--backend"]
        else:
            cmd = [sys.executable, "-m", "backend.frozen_main", "--backend"]

        if os.name == "nt":
            base_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            if getattr(sys, "frozen", False):
                no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                creationflags = base_flags | no_window
            else:
                creationflags = base_flags
        else:
            creationflags = 0

        if not mutex or not metadata_ready or instance_state not in ("NEW_INSTANCE", "CONFIRMED_STALE_INSTANCE"):
            job.close()
            return refuse_instance("AMBIGUOUS_EXISTING_INSTANCE", "pre_spawn_ownership_unproven")

        try:
            attempt = new_startup_attempt(approved_root)
            env.update(attempt.environment())
            proc = subprocess.Popen(cmd, env=env, creationflags=creationflags)
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
                _safe_log(logger, logging.INFO, "job_assign_failed_abort port=%s", port)
                cleanup_startup_attempt(attempt, approved_root)
                dialog_msg = "Academic Compliance Auditor could not start its background process. Please try restarting ACA."
                show_startup_error(dialog_msg, state=dialog_state, logger=logger)
                _safe_print("ACA could not start. Please try again.")
                job.close()
                release_mutex(mutex)
                return 1
        except Exception as e:
            if attempt is not None:
                try:
                    cleanup_startup_attempt(attempt, approved_root)
                except OSError:
                    _safe_log(logger, logging.ERROR, "startup_status_cleanup_failed")
            _safe_log(logger, logging.INFO, "child_spawn_failed port=%s category=%s", port, type(e).__name__)
            dialog_msg = "Academic Compliance Auditor could not start its background process. Please try restarting ACA."
            show_startup_error(dialog_msg, state=dialog_state, logger=logger)
            _safe_print("ACA could not start. Please try again.")
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
                try:
                    cleanup_startup_attempt(attempt, approved_root)
                except OSError:
                    return refuse_startup("UNEXPECTED_STARTUP_FAILURE")
                release_mutex(mutex)
                job.close()
                return 0
            if proc.poll() is not None:
                proc.wait(timeout=SHUTDOWN_TIMEOUT)
                _safe_log(logger, logging.INFO, "child_exited port=%s code=%s", port, proc.returncode)
                if proc.returncode == BACKEND_LOGGING_FAILURE_EXIT_CODE:
                    try:
                        cleanup_startup_attempt(attempt, approved_root)
                    except OSError:
                        return refuse_startup("UNEXPECTED_STARTUP_FAILURE", BACKEND_LOGGING_FAILURE_EXIT_CODE)
                    _safe_log(logger, logging.ERROR, "backend_logging_init_failed")
                    show_startup_error(
                        "Academic Compliance Auditor could not initialize background logging.\n\n"
                        "Startup was stopped. Please check application data folder permissions and try again.",
                        state=dialog_state, logger=logger,
                    )
                    job.close()
                    release_mutex(mutex)
                    return BACKEND_LOGGING_FAILURE_EXIT_CODE
                break
            if check_health(port):
                health_ok = True
                break
            time.sleep(0.5)
        if health_ok:
            if startup_failure_present(attempt, approved_root):
                proc.terminate()
                try:
                    proc.wait(timeout=SHUTDOWN_TIMEOUT)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
                try:
                    category = consume_startup_failure(attempt, approved_root)
                    attempt = None
                except OSError:
                    category = "UNEXPECTED_STARTUP_FAILURE"
                return refuse_startup(category)
            try:
                cleanup_startup_attempt(attempt, approved_root)
            except OSError:
                proc.terminate()
                proc.wait(timeout=SHUTDOWN_TIMEOUT)
                return refuse_startup("UNEXPECTED_STARTUP_FAILURE")
            chosen_port = port
            _safe_log(logger, logging.INFO, "health_ok port=%s", port)
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
            _safe_log(logger, logging.INFO, "health_timeout port=%s", port)
            try:
                cleanup_startup_attempt(attempt, approved_root)
            except OSError:
                return refuse_startup("UNEXPECTED_STARTUP_FAILURE")
            last_error = "health_timeout"
            break
        try:
            category = consume_startup_failure(attempt, approved_root)
            attempt = None
        except OSError:
            return refuse_startup("UNEXPECTED_STARTUP_FAILURE")
        if category != "PORT_UNAVAILABLE":
            return refuse_startup(category)
        _safe_log(logger, logging.INFO, "startup_failure category=PORT_UNAVAILABLE")
        last_error = "bind_failed"
        proc = None
        continue

    if chosen_port is None:
        if last_error == "health_timeout":
            _safe_print("ACA did not become ready in time. Please try again.")
            _safe_log(logger, logging.INFO, "startup_failed health_timeout")
            dialog_msg = "Academic Compliance Auditor did not become ready in time. Please try restarting ACA. If this persists, technical details are recorded in launcher.log."
            show_startup_error(dialog_msg, state=dialog_state, logger=logger)
            try:
                _safe_print("If this persists, the database may need an update.")
            except Exception:
                pass
        else:
            _safe_print("All network ports are in use. Please close other applications and try again.")
            _safe_log(logger, logging.INFO, "startup_failed ports_unavailable")
            dialog_msg = "All network ports reserved for Academic Compliance Auditor are in use. Please close other applications and try again."
            show_startup_error(dialog_msg, state=dialog_state, logger=logger)
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
        _safe_log(logger, logging.INFO, "running_instance_build_failed port=%s pid=%s", chosen_port, proc.pid)
        dialog_msg = "Academic Compliance Auditor encountered an unexpected startup error. Please try restarting ACA."
        show_startup_error(dialog_msg, state=dialog_state, logger=logger)
        job.close()
        release_mutex(mutex)
        return 1

    write_instance(inst_path, running.pid, running.port)
    _safe_log(logger, logging.INFO, "instance_written pid=%s port=%s url=%s", running.pid, running.port, running.url)

    dash_url = "http" + "://" + "127.0.0.1" + ":" + str(running.port) + "/dashboard"
    if not open_browser(running.port, logger):
        if validate_loopback_dashboard_url(dash_url):
            _safe_log(logger, logging.INFO, "browser_open_fallback url=%s", dash_url)
            notice_msg = (
                "Academic Compliance Auditor is running, but the browser could not be opened automatically.\n\n"
                "Please open your browser and go to:\n"
                + dash_url
            )
            show_startup_notice(notice_msg, state=dialog_state, logger=logger)
        else:
            _safe_log(logger, logging.WARNING, "invalid_dashboard_url")
            notice_msg = (
                "Academic Compliance Auditor is running, but the browser could not be opened automatically.\n\n"
                "Please open your web browser and navigate to the ACA Dashboard."
            )
            show_startup_notice(notice_msg, state=dialog_state, logger=logger)
        _safe_print("ACA is running at " + dash_url)

    _safe_print("ACA running at " + running.url + " - press Ctrl+C to stop.")

    try:
        while True:
            if should_exit["flag"]:
                _safe_log(logger, logging.INFO, "shutdown_reason=ctrl_c")
                _safe_print("\nShutting down ACA...")
                break
            ret = proc.poll()
            if ret is not None:
                _safe_log(logger, logging.INFO, "backend_exited code=%s", ret)
                _safe_print("ACA has stopped.")
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        _safe_log(logger, logging.INFO, "shutdown_reason=ctrl_c")
        _safe_print("\nShutting down ACA...")
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
        _safe_log(logger, logging.INFO, "shutdown_complete")
    return 0


def _backend():
    from app.launcher_support import (
        revalidate_child_approved_root, configure_launcher_environment,
        get_log_dir, setup_backend_logging, setup_launcher_logging, _safe_log,
        write_startup_failure,
        BACKEND_LOGGING_FAILURE_EXIT_CODE,
    )
    approved_root = revalidate_child_approved_root()
    configure_launcher_environment(approved_root)
    frozen = bool(getattr(sys, "frozen", False))
    if frozen:
        log_dir = get_log_dir(approved_root.path)
        try:
            setup_backend_logging(log_dir)
        except (OSError, ValueError, TypeError) as exc:
            try:
                logger = setup_launcher_logging(log_dir)
            except Exception:
                logger = None
            _safe_log(logger, logging.ERROR, "backend_logging_init_failed category=%s", type(exc).__name__, exc_info=True)
            return BACKEND_LOGGING_FAILURE_EXIT_CODE
    bind_failure_owner = None
    try:
        import uvicorn
        bind_failure_owner = uvicorn.Server.startup.__code__
        from app.main import app as fastapi_app
        port = int(os.environ.get("ACA_POC_PORT", "8010"))
        uvicorn.run(
            fastapi_app, host="127.0.0.1", port=port, log_level="info",
            log_config=None if frozen else uvicorn.config.LOGGING_CONFIG,
        )
    except SystemExit as exc:
        import errno
        cause = exc.__context__
        category = "UNEXPECTED_STARTUP_FAILURE"
        # An errno in an unrelated lifespan failure does not prove a bind failure.
        origin = exc.__traceback__
        while origin is not None and origin.tb_next is not None:
            origin = origin.tb_next
        if (exc.code == 1 and origin is not None
                and origin.tb_frame.f_code is bind_failure_owner
                and isinstance(cause, OSError)
                and (cause.errno == errno.EADDRINUSE or getattr(cause, "winerror", None) == 10048)):
            category = "PORT_UNAVAILABLE"
        write_startup_failure(category, approved_root)
        return exc.code if isinstance(exc.code, int) and exc.code != 0 else 1
    except Exception:
        write_startup_failure("UNEXPECTED_STARTUP_FAILURE", approved_root)
        _safe_log(logging.getLogger("uvicorn.error"), logging.ERROR, "backend_startup_failed category=UNEXPECTED_STARTUP_FAILURE")
        return 1

if __name__ == "__main__":
    if "--backend" in sys.argv:
        sys.exit(_backend())
    else:
        try:
            sys.exit(_launcher())
        except KeyboardInterrupt:
            sys.exit(0)
