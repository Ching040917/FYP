"""Isolated startup status protocol behavior; no child, database, GUI or network."""
import json
import logging
import os
from dataclasses import replace
from types import SimpleNamespace

import pytest

from app import launcher_support as ls


@pytest.fixture
def approved(tmp_path):
    return ls.get_user_data_root(tmp_path / "data")


def _environment(monkeypatch, attempt):
    for key, value in attempt.environment().items():
        monkeypatch.setenv(key, value)


def _put(attempt, payload):
    if isinstance(payload, dict):
        payload = json.dumps(payload).encode("ascii")
    elif isinstance(payload, str):
        payload = payload.encode("ascii")
    fd = os.open(attempt.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)


def _record(attempt, **changes):
    return {"schema_version": 1, "attempt_nonce": attempt.nonce,
            "category": "PORT_UNAVAILABLE", **changes}


@pytest.mark.parametrize("category", sorted(ls.STARTUP_FAILURE_CATEGORIES))
def test_all_explicit_categories_round_trip(approved, monkeypatch, category):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    assert attempt.path.is_absolute()
    assert attempt.path.parent.parent == approved.path / "runtime"
    assert len(attempt.nonce) == 64
    assert len(bytes.fromhex(attempt.nonce)) == 32
    assert attempt.schema_version == 1
    assert set(attempt.environment()) == {
        "ACA_STARTUP_STATUS_PATH", "ACA_STARTUP_ATTEMPT_NONCE", "ACA_STARTUP_SCHEMA_VERSION",
    }
    assert not attempt.path.exists()
    assert not ls.startup_failure_present(attempt, approved)
    assert ls.write_startup_failure(category, approved)
    assert ls.startup_failure_present(attempt, approved)
    assert json.loads(attempt.path.read_bytes()) == _record(attempt, category=category)
    assert attempt.path.stat().st_size <= 1024
    assert ls.consume_startup_failure(attempt, approved) == category
    assert not attempt.path.parent.exists()
    assert list((approved.path / "runtime").iterdir()) == []


def test_missing_record_is_unexpected_and_cleans_directory(approved):
    attempt = ls.new_startup_attempt(approved)
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()


@pytest.mark.parametrize("changes", [
    {"schema_version": True}, {"schema_version": "1"}, {"schema_version": 2},
    {"schema_version": 1.0}, {"attempt_nonce": "f" * 64}, {"attempt_nonce": None},
    {"category": "DATABASE_FAILURE"}, {"category": 3}, {"category": []},
    {"category": {}}, {"unexpected": "field"},
])
def test_invalid_fields_are_unexpected_and_removed(approved, changes):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, _record(attempt, **changes))
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()


@pytest.mark.parametrize("payload", [
    b"", b"{", b"[]", b"true", b"null", b"\xff", b'"status"',
    b'{"schema_version":1,"attempt_nonce":"x"}',
    b'{"schema_version":1,"schema_version":1,"attempt_nonce":"x","category":"PORT_UNAVAILABLE"}',
])
def test_malformed_records_are_unexpected_and_removed(approved, payload):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, payload)
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()


def test_oversize_rejected_before_json_parse(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, b" " * 1025)
    def no_parse(*args, **kwargs):
        pytest.fail("oversized status must not reach JSON parsing")
    monkeypatch.setattr(ls.json, "loads", no_parse)
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()


def test_existence_gate_does_not_parse_or_read(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, b"not JSON")
    def no_read(*args, **kwargs):
        pytest.fail("live-child existence gate must not read a record")
    monkeypatch.setattr(ls, "_startup_read", no_read)
    assert ls.startup_failure_present(attempt, approved)
    ls.cleanup_startup_attempt(attempt, approved)


@pytest.mark.parametrize("nonce", ["", "F" * 64, "a" * 63, "g" * 64, "b" * 64])
def test_invalid_or_different_environment_nonce_cannot_write(approved, monkeypatch, nonce):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    monkeypatch.setenv("ACA_STARTUP_ATTEMPT_NONCE", nonce)
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert not attempt.path.exists()
    ls.cleanup_startup_attempt(attempt, approved)


@pytest.mark.parametrize("version", ["", "True", "01", "2", "1.0"])
def test_environment_schema_is_exact(approved, monkeypatch, version):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    monkeypatch.setenv("ACA_STARTUP_SCHEMA_VERSION", version)
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert not attempt.path.exists()
    ls.cleanup_startup_attempt(attempt, approved)


@pytest.mark.parametrize("category", [None, 3, True, [], {}, "exception: private detail"])
def test_writer_rejects_non_category_values_without_files(approved, monkeypatch, category):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    assert not ls.write_startup_failure(category, approved)
    assert list(attempt.path.parent.iterdir()) == []
    ls.cleanup_startup_attempt(attempt, approved)


def test_stale_attempt_cannot_write_to_new_attempt(approved, monkeypatch):
    old = ls.new_startup_attempt(approved)
    _environment(monkeypatch, old)
    ls.cleanup_startup_attempt(old, approved)
    current = ls.new_startup_attempt(approved)
    assert old.nonce != current.nonce
    assert old.path != current.path
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert not current.path.exists()
    ls.cleanup_startup_attempt(current, approved)


def test_stale_record_nonce_cannot_authorize_category(approved):
    old = ls.new_startup_attempt(approved)
    current = ls.new_startup_attempt(approved)
    _put(current, _record(old))
    assert ls.consume_startup_failure(current, approved) == "UNEXPECTED_STARTUP_FAILURE"
    ls.cleanup_startup_attempt(old, approved)


@pytest.mark.parametrize("existing_nonce", [None, "0" * 64])
def test_existing_record_never_overwritten(approved, monkeypatch, existing_nonce):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    prior = _record(attempt, attempt_nonce=existing_nonce or attempt.nonce)
    _put(attempt, prior)
    original = attempt.path.read_bytes()
    identity = (attempt.path.stat().st_dev, attempt.path.stat().st_ino)
    assert not ls.write_startup_failure("DATABASE_RECONCILIATION_REFUSAL", approved)
    assert attempt.path.read_bytes() == original
    assert (attempt.path.stat().st_dev, attempt.path.stat().st_ino) == identity
    assert [p.name for p in attempt.path.parent.iterdir()] == ["status.json"]
    ls.cleanup_startup_attempt(attempt, approved)


def test_publication_is_complete_fsynced_and_no_clobber(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    events = []
    real_fsync = ls.os.fsync
    def fsync(fd):
        real_fsync(fd)
        events.append("fsync")
    monkeypatch.setattr(ls.os, "fsync", fsync)
    operation = "rename" if os.name == "nt" else "link"
    real_publish = getattr(ls.os, operation)
    def publish(source, destination, **kwargs):
        assert events == ["fsync"]
        assert not attempt.path.exists()
        pending = list(attempt.path.parent.glob(".pending-*"))
        assert len(pending) == 1
        assert json.loads(pending[0].read_bytes()) == _record(attempt)
        result = real_publish(source, destination, **kwargs)
        assert json.loads(attempt.path.read_bytes()) == _record(attempt)
        events.append("published")
        return result
    monkeypatch.setattr(ls.os, operation, publish)
    assert ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert events == ["fsync", "published"]
    assert [p.name for p in attempt.path.parent.iterdir()] == ["status.json"]
    ls.cleanup_startup_attempt(attempt, approved)


def test_racing_destination_is_not_overwritten(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    operation = "rename" if os.name == "nt" else "link"
    real_publish = getattr(ls.os, operation)
    prior = _record(attempt, attempt_nonce="e" * 64)
    def publish(source, destination, **kwargs):
        _put(attempt, prior)
        return real_publish(source, destination, **kwargs)
    monkeypatch.setattr(ls.os, operation, publish)
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert json.loads(attempt.path.read_bytes()) == prior
    assert [p.name for p in attempt.path.parent.iterdir()] == ["status.json"]
    ls.cleanup_startup_attempt(attempt, approved)


def test_environment_path_escape_is_rejected(approved, tmp_path, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    external = tmp_path / "outside.json"
    monkeypatch.setenv("ACA_STARTUP_STATUS_PATH", str(external))
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert not external.exists()
    with pytest.raises(OSError):
        ls.startup_failure_present(replace(attempt, path=external), approved)
    ls.cleanup_startup_attempt(attempt, approved)


def _reparse_metadata(st):
    return SimpleNamespace(
        st_mode=st.st_mode, st_dev=st.st_dev, st_ino=st.st_ino,
        st_file_attributes=getattr(st, "st_file_attributes", 0) | 0x400,
    )


def test_final_reparse_attribute_is_not_read_or_unlinked(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    _put(attempt, _record(attempt))
    original = attempt.path.read_bytes()
    real_lstat = ls.os.lstat
    def lstat(path, *args, **kwargs):
        st = real_lstat(path, *args, **kwargs)
        return _reparse_metadata(st) if path == attempt.path else st
    def forbidden_read(*args, **kwargs):
        pytest.fail("a reparse-marked status must never be opened")
    with monkeypatch.context() as patch:
        patch.setattr(ls.os, "lstat", lstat)
        patch.setattr(ls, "_startup_open_read", forbidden_read)
        assert ls.startup_failure_present(attempt, approved)
        assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
        with pytest.raises(OSError):
            ls.consume_startup_failure(attempt, approved)
        with pytest.raises(OSError):
            ls.cleanup_startup_attempt(attempt, approved)
        assert attempt.path.read_bytes() == original
    ls.cleanup_startup_attempt(attempt, approved)


def test_attempt_directory_reparse_attribute_blocks_consume_and_cleanup(
        approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    _put(attempt, _record(attempt))
    original = attempt.path.read_bytes()
    real_lstat = ls.os.lstat
    def lstat(path, *args, **kwargs):
        st = real_lstat(path, *args, **kwargs)
        return _reparse_metadata(st) if path == attempt.path.parent else st
    def forbidden_read(*args, **kwargs):
        pytest.fail("an unsafe attempt directory must never permit record reads")
    with monkeypatch.context() as patch:
        patch.setattr(ls.os, "lstat", lstat)
        patch.setattr(ls, "_startup_open_read", forbidden_read)
        assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
        with pytest.raises(OSError):
            ls.consume_startup_failure(attempt, approved)
        with pytest.raises(OSError):
            ls.cleanup_startup_attempt(attempt, approved)
        assert attempt.path.read_bytes() == original
    ls.cleanup_startup_attempt(attempt, approved)


def test_root_replacement_rejected_without_mutating_replacement(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    original = approved.path.with_name("original-data")
    approved.path.rename(original)
    approved.path.mkdir()
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    with pytest.raises(OSError):
        ls.consume_startup_failure(attempt, approved)
    assert list(approved.path.iterdir()) == []
    assert list((original / "runtime" / attempt.path.parent.name).iterdir()) == []


def test_reparse_attribute_rejected_even_when_directory_bit_is_set(approved, monkeypatch):
    real_lstat, real_fstat = ls.os.lstat, ls.os.fstat
    def marked(st):
        if (st.st_dev, st.st_ino) != (approved.dev, approved.ino):
            return st
        return SimpleNamespace(
            st_mode=st.st_mode, st_dev=st.st_dev, st_ino=st.st_ino,
            st_file_attributes=0x400,
        )
    monkeypatch.setattr(ls.os, "lstat", lambda *a, **kw: marked(real_lstat(*a, **kw)))
    monkeypatch.setattr(ls.os, "fstat", lambda *a, **kw: marked(real_fstat(*a, **kw)))
    with pytest.raises(OSError):
        ls.new_startup_attempt(approved)
    assert not (approved.path / "runtime").exists()




def test_cleanup_failure_is_not_reported_as_consumed(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, _record(attempt))
    def refuse(*args, **kwargs):
        raise PermissionError("sensitive filesystem text")
    monkeypatch.setattr(ls, "_startup_unlink", refuse)
    with pytest.raises(OSError):
        ls.consume_startup_failure(attempt, approved)
    assert attempt.path.exists()


def test_cleanup_refuses_unknown_entries(approved):
    attempt = ls.new_startup_attempt(approved)
    unknown = attempt.path.parent / "unrelated.txt"
    unknown.write_text("leave intact")
    with pytest.raises(OSError):
        ls.cleanup_startup_attempt(attempt, approved)
    assert unknown.read_text() == "leave intact"
    unknown.unlink()
    ls.cleanup_startup_attempt(attempt, approved)


def test_logging_failure_does_not_change_category_or_failure_outcome(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    def fail_logging(*args, **kwargs):
        raise RuntimeError("sensitive logging text")
    monkeypatch.setattr(logging.Logger, "_log", fail_logging)
    original_failure = RuntimeError("sensitive original failure")
    with pytest.raises(RuntimeError) as raised:
        try:
            raise original_failure
        except RuntimeError:
            assert ls.write_startup_failure("DATABASE_RECONCILIATION_REFUSAL", approved)
            raise
    assert raised.value is original_failure
    assert b"sensitive" not in attempt.path.read_bytes()
    assert ls.consume_startup_failure(attempt, approved) == "DATABASE_RECONCILIATION_REFUSAL"


def test_writer_io_failure_is_best_effort_and_preserves_original_error(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    def refuse(fd):
        raise OSError("sensitive disk failure")
    monkeypatch.setattr(ls.os, "fsync", refuse)
    assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert list(attempt.path.parent.iterdir()) == []
    ls.cleanup_startup_attempt(attempt, approved)


def test_writer_without_root_revalidates_child_approval(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    calls = []
    def revalidate():
        calls.append(True)
        return approved
    monkeypatch.setattr(ls, "revalidate_child_approved_root", revalidate)
    assert ls.write_startup_failure("PORT_UNAVAILABLE")
    assert calls == [True]
    ls.cleanup_startup_attempt(attempt, approved)


def test_existing_private_attempt_name_is_never_reused(approved, monkeypatch):
    first = ls.new_startup_attempt(approved)
    monkeypatch.setattr(ls.secrets, "token_hex", lambda count: first.nonce)
    with pytest.raises(OSError):
        ls.new_startup_attempt(approved)
    assert list(first.path.parent.iterdir()) == []
    ls.cleanup_startup_attempt(first, approved)




def test_pending_only_child_crash_is_cleaned(approved):
    attempt = ls.new_startup_attempt(approved)
    pending = attempt.path.with_name(".pending-" + "a" * 64)
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(b"incomplete")
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()






def test_windows_root_pin_prevents_replacement_during_publication(approved, monkeypatch):
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    real_fsync = ls.os.fsync
    events = []
    def fsync(fd):
        real_fsync(fd)
        with pytest.raises(OSError):
            approved.path.rename(approved.path.with_name("moved-data"))
        events.append("root-pinned")
    monkeypatch.setattr(ls.os, "fsync", fsync)
    assert ls.write_startup_failure("PORT_UNAVAILABLE", approved)
    assert events == ["root-pinned"]
    assert ls.consume_startup_failure(attempt, approved) == "PORT_UNAVAILABLE"


def test_windows_inherited_unprotected_runtime_is_rejected(approved):
    runtime = approved.path / "runtime"
    runtime.mkdir()
    with pytest.raises(OSError):
        ls.new_startup_attempt(approved)
    assert list(runtime.iterdir()) == []


@pytest.mark.parametrize("missing", [
    None, "ACA_STARTUP_STATUS_PATH", "ACA_STARTUP_ATTEMPT_NONCE",
    "ACA_STARTUP_SCHEMA_VERSION",
])
def test_absent_protocol_never_resolves_root_or_touches_filesystem(
        tmp_path, monkeypatch, missing):
    fields = {
        "ACA_STARTUP_STATUS_PATH": str(tmp_path / "status.json"),
        "ACA_STARTUP_ATTEMPT_NONCE": "a" * 64,
        "ACA_STARTUP_SCHEMA_VERSION": "1",
    }
    for name, value in fields.items():
        if missing is None or name == missing:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    def forbidden(*args, **kwargs):
        pytest.fail("absent protocol must have no root or filesystem effects")
    monkeypatch.setattr(ls, "revalidate_child_approved_root", forbidden)
    monkeypatch.setattr(ls, "_startup_root", forbidden)
    assert not ls.write_startup_failure("UNEXPECTED_STARTUP_FAILURE")
    assert list(tmp_path.iterdir()) == []


def test_windows_junction_directory_is_rejected(approved, tmp_path, monkeypatch):
    import _winapi
    create_junction = _winapi.CreateJunction
    attempt = ls.new_startup_attempt(approved)
    _environment(monkeypatch, attempt)
    outside = tmp_path / "outside-junction"
    outside.mkdir()
    attempt.path.parent.rmdir()
    create_junction(str(outside), str(attempt.path.parent))
    try:
        assert not ls.write_startup_failure("PORT_UNAVAILABLE", approved)
        with pytest.raises(OSError):
            ls.cleanup_startup_attempt(attempt, approved)
        assert list(outside.iterdir()) == []
    finally:
        os.rmdir(attempt.path.parent)


def test_legacy_nonce_field_is_not_an_alias(approved):
    attempt = ls.new_startup_attempt(approved)
    _put(attempt, {"schema_version": 1, "nonce": attempt.nonce,
                   "category": "PORT_UNAVAILABLE"})
    assert ls.consume_startup_failure(attempt, approved) == "UNEXPECTED_STARTUP_FAILURE"
    assert not attempt.path.parent.exists()
