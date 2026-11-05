"""D-03: the three DOCX upload boundaries never spool original bytes to disk."""
import asyncio
import builtins
import hashlib
import inspect
import io
import json
import logging
import os
import pathlib
import shutil
import subprocess
import struct
import tempfile
import zipfile
import zlib

import pytest
from starlette import formparsers, requests as starlette_requests
from starlette.requests import Request

from app.api import routes as api_routes
from app.services import guided_fix_storage
from app.services import bounded_multipart
from app.services.bounded_multipart import BoundedMultipartError, read_bounded_form
from app.services.bounded_multipart import MAX_PARTS, MAX_PART_HEADER_BYTES
from tests.conftest import make_docx_bytes
from tests.test_guided_fixes import _font_fixture_bytes

MARKER = b"ACA-D03-ORIGINAL-MARKER"
BOUNDARY = b"bnd"
SIZE_DETAIL = "File size exceeds the 10MB security boundary."


def _padded_docx(padding_bytes: int) -> bytes:
    """Valid DOCX with an unreferenced stored part, so the package stays readable."""
    pad = MARKER + b"\0" * max(0, padding_bytes - len(MARKER))
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(make_docx_bytes())) as source:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
            for item in source.infolist():
                target.writestr(item, source.read(item.filename))
            target.writestr(
                zipfile.ZipInfo("word/media/pad.bin"), pad, compress_type=zipfile.ZIP_STORED
            )
    return out.getvalue()


def _part(name, data, *, filename=None, extra_headers=()):
    disposition = f'form-data; name="{name}"'
    if filename is not None:
        disposition += f'; filename="{filename}"'
    head = f"Content-Disposition: {disposition}\r\n"
    for header in extra_headers:
        head += header + "\r\n"
    return b"--" + BOUNDARY + b"\r\n" + head.encode() + b"\r\n" + data + b"\r\n"


def _body(parts, *, close=True):
    render = b"".join(parts)
    return render + (b"--" + BOUNDARY + b"--\r\n" if close else b"")


def _request(body: bytes, content_type: str = "multipart/form-data; boundary=bnd") -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(b"content-type", content_type.encode("latin-1"))],
    }
    return Request(scope, receive)


def _chunked_request(chunks, content_type="multipart/form-data; boundary=bnd"):
    received = []
    index = 0

    async def receive():
        nonlocal index
        if index >= len(chunks):
            return {"type": "http.disconnect"}
        chunk = chunks[index]
        received.append(index)
        index += 1
        return {"type": "http.request", "body": chunk, "more_body": index < len(chunks)}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(b"content-type", content_type.encode("latin-1"))],
    }
    return Request(scope, receive), received


def _raw_file(headers, payload=b"synthetic"):
    return (
        b"--bnd\r\n" + b"\r\n".join(headers) + b"\r\n\r\n"
        + payload + b"\r\n--bnd--\r\n"
    )


def _parser_logs(caplog):
    return "\n".join(
        record.getMessage() for record in caplog.records
        if record.name.startswith(("multipart.", "app.services.bounded_multipart"))
    )


async def _read(body, **kwargs):
    kwargs.setdefault("allowed_fields", frozenset({"selection", "review_id", "custom_profile"}))
    kwargs.setdefault("max_file_bytes", 10 * 1024 * 1024)
    return await read_bounded_form(_request(body), **kwargs)


@pytest.fixture
def sinks(monkeypatch):
    """Track filesystem entry points and fail immediately on spool construction."""
    hits = []

    def record(name, original, predicate=None):
        def wrapper(*args, **kwargs):
            hits.append(name)
            return original(*args, **kwargs)

        return wrapper

    def deny_spool(location):
        def denied(*args, **kwargs):
            size = kwargs.get("max_size", args[0] if args else None)
            hits.append({
                "lookup": location,
                "max_size": size if isinstance(size, int) else None,
                "positional_count": len(args),
            })
            pytest.fail("Unexpected multipart spool construction", pytrace=False)
        return denied

    monkeypatch.setattr(
        tempfile, "SpooledTemporaryFile", deny_spool("tempfile.SpooledTemporaryFile")
    )
    monkeypatch.setattr(
        formparsers, "SpooledTemporaryFile",
        deny_spool("starlette.formparsers.SpooledTemporaryFile"),
    )
    for name in (
        "TemporaryFile",
        "NamedTemporaryFile",
        "TemporaryDirectory",
        "mkstemp",
        "mkdtemp",
    ):
        monkeypatch.setattr(tempfile, name, record("tempfile." + name, getattr(tempfile, name)))
    monkeypatch.setattr(
        pathlib.Path, "write_bytes", record("Path.write_bytes", pathlib.Path.write_bytes)
    )
    real_open = builtins.open

    def guarded_open(file, mode="r", *args, **kwargs):
        if isinstance(mode, str) and set(mode) & set("wax+"):
            hits.append("open")
        return real_open(file, mode, *args, **kwargs)

    real_io_open = io.open

    def guarded_io_open(file, mode="r", *args, **kwargs):
        if not isinstance(file, int) and isinstance(mode, str) and set(mode) & set("wax+"):
            hits.append("io.open")
        return real_io_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(io, "open", guarded_io_open)
    monkeypatch.setattr(shutil, "copyfile", record("shutil.copyfile", shutil.copyfile))
    monkeypatch.setattr(shutil, "copy", record("shutil.copy", shutil.copy))
    monkeypatch.setattr(os, "replace", record("os.replace", os.replace))
    monkeypatch.setattr(os, "rename", record("os.rename", os.rename))
    monkeypatch.setattr(subprocess, "Popen", record("subprocess.Popen", subprocess.Popen))
    return hits


@pytest.fixture
def route_probe(monkeypatch, sinks, tmp_path):
    """Observe the actual endpoint lookup paths, scoped to one test."""
    stats = {
        "adapter_calls": 0,
        "stream_calls": 0,
        "chunks": 0,
        "request_bytes": 0,
        "file_bytes": 0,
        "form_calls": 0,
        "starlette_parser_calls": 0,
        "file_writes": [],
        "original_digest": None,
    }
    original_adapter = api_routes.read_bounded_form
    original_stream = Request.stream
    original_data = bounded_multipart._Collector._part_data
    original_os_open = os.open
    original_fdopen = os.fdopen
    writable_fds = {}

    async def adapter(request, *args, **kwargs):
        stats["adapter_calls"] += 1
        return await original_adapter(request, *args, **kwargs)

    async def stream(request):
        stats["stream_calls"] += 1
        async for chunk in original_stream(request):
            if chunk:
                stats["chunks"] += 1
                stats["request_bytes"] += len(chunk)
            yield chunk

    def part_data(collector, data, start, end):
        if collector._is_file:
            stats["file_bytes"] += end - start
        return original_data(collector, data, start, end)

    def deny_form(*args, **kwargs):
        stats["form_calls"] += 1
        pytest.fail("Unexpected Request.form call", pytrace=False)

    def deny_parser(*args, **kwargs):
        stats["starlette_parser_calls"] += 1
        pytest.fail("Unexpected Starlette multipart parser construction", pytrace=False)

    def observed_os_open(path, flags, *args, **kwargs):
        fd = original_os_open(path, flags, *args, **kwargs)
        if flags & (os.O_WRONLY | os.O_RDWR):
            try:
                owned = pathlib.Path(path).resolve().is_relative_to(tmp_path.resolve())
            except (OSError, TypeError, ValueError):
                owned = False
            writable_fds[fd] = "task-owned" if owned else "other"
        return fd

    class ObservedWriter:
        def __init__(self, handle, destination):
            self.handle = handle
            self.destination = destination
            self.digest = hashlib.sha256()
            self.size = 0

        def __enter__(self):
            self.handle.__enter__()
            return self

        def __exit__(self, *args):
            try:
                return self.handle.__exit__(*args)
            finally:
                stats["file_writes"].append({
                    "lookup": "os.fdopen",
                    "destination": self.destination,
                    "bytes": self.size,
                    "matches_original": self.digest.digest() == stats["original_digest"],
                })

        def write(self, data):
            written = self.handle.write(data)
            self.digest.update(memoryview(data)[:written])
            self.size += written
            return written

        def __getattr__(self, name):
            return getattr(self.handle, name)

    def observed_fdopen(fd, mode="r", *args, **kwargs):
        handle = original_fdopen(fd, mode, *args, **kwargs)
        if fd in writable_fds and "b" in mode and set(mode) & set("wax+"):
            return ObservedWriter(handle, writable_fds.pop(fd))
        return handle

    monkeypatch.setattr(api_routes, "read_bounded_form", adapter)
    monkeypatch.setattr(Request, "stream", stream)
    monkeypatch.setattr(Request, "form", deny_form)
    monkeypatch.setattr(bounded_multipart._Collector, "_part_data", part_data)
    monkeypatch.setattr(starlette_requests, "MultiPartParser", deny_parser)
    monkeypatch.setattr(formparsers, "MultiPartParser", deny_parser)
    monkeypatch.setattr(os, "open", observed_os_open)
    monkeypatch.setattr(os, "fdopen", observed_fdopen)
    return stats


def test_alias_instrumentation_denies_both_runtime_lookups(sinks):
    with pytest.raises(pytest.fail.Exception):
        tempfile.SpooledTemporaryFile(max_size=1048576)
    with pytest.raises(pytest.fail.Exception):
        formparsers.SpooledTemporaryFile(max_size=1048576)
    assert sinks == [
        {"lookup": "tempfile.SpooledTemporaryFile", "max_size": 1048576, "positional_count": 0},
        {
            "lookup": "starlette.formparsers.SpooledTemporaryFile",
            "max_size": 1048576,
            "positional_count": 0,
        },
    ]


@pytest.mark.asyncio
async def test_accepts_small_docx_in_memory(sinks):
    source = make_docx_bytes()
    form = await _read(_body([_part("file", source, filename="thesis.docx")]))
    assert form.file_bytes == source
    assert form.filename == "thesis.docx"
    assert sinks == []


@pytest.mark.asyncio
async def test_accepts_above_rollover_without_disk(sinks):
    source = _padded_docx(1_400_000)
    assert 1024 * 1024 < len(source) < 10 * 1024 * 1024
    form = await _read(
        _body(
            [
                _part("file", source, filename="large.docx"),
                _part("selection", b'{"violation_ids": []}'),
            ]
        ),
        required_fields=frozenset({"selection"}),
    )
    assert form.file_bytes == source
    assert form.fields["selection"] == '{"violation_ids": []}'
    assert sinks == []


@pytest.mark.asyncio
async def test_exact_limit_is_accepted():
    payload = MARKER + b"\0" * (10 * 1024 * 1024 - len(MARKER))
    form = await _read(_body([_part("file", payload, filename="exact.docx")]))
    assert len(form.file_bytes) == 10 * 1024 * 1024


@pytest.mark.asyncio
async def test_one_byte_over_limit_is_rejected_immediately(sinks):
    payload = MARKER + b"\0" * (10 * 1024 * 1024 + 1 - len(MARKER))
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(_body([_part("file", payload, filename="over.docx")]))
    assert exc.value.status_code == 400
    assert exc.value.detail == SIZE_DETAIL
    assert sinks == []


@pytest.mark.asyncio
async def test_immediate_abort_caps_configured_limit_at_ten_megabytes(sinks):
    payload = b"x" * (10 * 1024 * 1024 + 1)
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(
            _body([_part("file", payload, filename="over.docx")]),
            max_file_bytes=20 * 1024 * 1024,
        )
    assert exc.value.status_code == 400
    assert exc.value.detail == SIZE_DETAIL
    assert sinks == []


@pytest.mark.asyncio
async def test_missing_file_is_rejected():
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(_body([_part("selection", b"{}")]))
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_duplicate_file_field_is_rejected():
    body = _body(
        [
            _part("file", b"one", filename="a.docx"),
            _part("file", b"two", filename="b.docx"),
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_multiple_file_parts_are_rejected():
    body = _body(
        [
            _part("file", b"one", filename="a.docx"),
            _part("other", b"two", filename="b.docx"),
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_unexpected_file_field_is_rejected():
    body = _body([_part("attachment", b"one", filename="a.docx")])
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_duplicate_scalar_field_is_rejected():
    body = _body(
        [
            _part("file", b"one", filename="a.docx"),
            _part("selection", b"a"),
            _part("selection", b"b"),
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_oversized_scalar_is_rejected():
    body = _body(
        [
            _part("file", b"one", filename="a.docx"),
            _part("selection", b"x" * (128 * 1024 + 1)),
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_oversized_headers_are_rejected():
    body = _body(
        [
            _part(
                "file",
                b"one",
                filename="a.docx",
                extra_headers=("X-Filler: " + "y" * (MAX_PART_HEADER_BYTES + 1),),
            )
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_excess_part_count_is_rejected():
    parts = [_part("file", b"one", filename="a.docx")]
    parts += [_part(f"f{index}", b"v") for index in range(MAX_PARTS)]
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(_body(parts))
    assert exc.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content_type, expected",
    [
        ("text/plain", 422),
        ("application/x-www-form-urlencoded", 422),
        ("multipart/form-data", 400),
        ("multipart/form-data; boundary=bad boundary!", 400),
    ],
)
async def test_bad_content_type_or_boundary_is_rejected(content_type, expected):
    with pytest.raises(BoundedMultipartError) as exc:
        await read_bounded_form(
            _request(_body([_part("file", b"one", filename="a.docx")]), content_type),
            max_file_bytes=1024,
        )
    assert exc.value.status_code == expected


@pytest.mark.asyncio
async def test_truncated_body_is_rejected():
    body = _body([_part("file", b"one", filename="a.docx")], close=False)
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_nested_multipart_part_is_rejected():
    body = _body(
        [
            _part(
                "file",
                b"one",
                filename="a.docx",
                extra_headers=("Content-Type: multipart/mixed; boundary=inner",),
            )
        ]
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_total_request_cap_rejects_early(monkeypatch):
    monkeypatch.setattr(bounded_multipart, "MAX_TOTAL_OVERHEAD", 1024)
    body = _body([
        _part("file", b"x" * 1024, filename="a.docx"),
        _part("selection", b"y" * 1024),
    ])
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body, max_file_bytes=1024)
    assert exc.value.status_code == 400
    assert exc.value.detail == "The upload exceeds the permitted request size."


def test_audit_endpoint_accepts_above_rollover_without_disk(client, sinks):
    source = _padded_docx(1_200_000)
    response = client.post(
        "/api/audit",
        files={"file": ("large.docx", source, "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "Success"
    assert sinks == []


def test_audit_endpoint_rejects_oversize_without_partial_record(client, sinks):
    payload = b"\0" * (10 * 1024 * 1024 + 1)
    response = client.post(
        "/api/audit",
        files={"file": ("over.docx", payload, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == SIZE_DETAIL
    assert client.get("/api/audits").json() == []
    assert sinks == []


def test_audit_endpoint_keeps_invalid_docx_rejection(client, sinks):
    response = client.post(
        "/api/audit",
        files={"file": ("broken.docx", b"PK\x03\x04not-a-real-docx", "application/octet-stream")},
    )
    assert response.status_code == 400
    assert "not a valid or readable DOCX" in response.json()["detail"]
    assert sinks == []


def test_audit_endpoint_keeps_encrypted_rejection(client, sinks):
    payload = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 64
    response = client.post(
        "/api/audit",
        files={"file": ("locked.docx", payload, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert "encrypted or password-protected" in response.json()["detail"]
    assert sinks == []


def test_audit_endpoint_rejects_duplicate_file_field(client, sinks):
    response = client.post(
        "/api/audit",
        files=[
            ("file", ("one.docx", make_docx_bytes(), "application/octet-stream")),
            ("file", ("two.docx", make_docx_bytes(), "application/octet-stream")),
        ],
    )
    assert response.status_code == 400
    assert client.get("/api/audits").json() == []
    assert sinks == []


def test_audit_endpoint_missing_body_returns_422(client):
    assert client.post("/api/audit").status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [1024, 1024 * 1024 + 1, 10 * 1024 * 1024])
async def test_adapter_peak_memory_stays_bounded(size):
    import tracemalloc

    body = _body([_part("file", MARKER + b"\0" * (size - len(MARKER)), filename="x.docx")])
    tracemalloc.start()
    try:
        form = await _read(body)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert len(form.file_bytes) == size
    # One bounded buffer plus the returned immutable copy.
    assert peak <= size * 2 + 256 * 1024
    print(f"accepted size={size} peak={peak}")


@pytest.mark.parametrize("filename", ["bad.DOCX", "bad.docx ", "bad.doc", "bad.docm"])
def test_extension_error_precedes_size_error(client_with_small_cap, filename):
    response = client_with_small_cap.post(
        "/api/audit",
        files={"file": (filename, b"invalid" * 1024, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported file format. Only .docx files are accepted."


def _docx_exactly(total_bytes: int) -> bytes:
    """Valid DOCX padded with an unreferenced stored part to an exact size."""
    padding = total_bytes
    for _ in range(4):
        payload = _padded_docx(padding)
        delta = len(payload) - total_bytes
        if delta == 0:
            return payload
        padding -= delta
    raise AssertionError("could not build an exact-size DOCX")


def test_audit_endpoint_accepts_exactly_ten_megabytes(client, sinks):
    source = _docx_exactly(10 * 1024 * 1024)
    response = client.post(
        "/api/audit",
        files={"file": ("exact.docx", source, "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    assert sinks == []


def test_audit_endpoint_rejects_one_byte_over_ten_megabytes(client, sinks):
    source = _docx_exactly(10 * 1024 * 1024 + 1)
    response = client.post(
        "/api/audit",
        files={"file": ("over.docx", source, "application/octet-stream")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == SIZE_DETAIL
    assert client.get("/api/audits").json() == []
    assert sinks == []


@pytest.mark.asyncio
async def test_immediate_abort_does_not_consume_later_chunks(monkeypatch, sinks):
    limit = 10 * 1024 * 1024
    prefix = b'--bnd\r\nContent-Disposition: form-data; name="file"; filename="x.docx"\r\n\r\n'
    request, received = _chunked_request(
        [prefix + b"x" * limit, b"!", b"UNCONSUMED-SYNTHETIC-SENTINEL"]
    )
    collectors = []
    callback_sizes = []
    original_init = bounded_multipart._Collector.__init__
    original_data = bounded_multipart._Collector._part_data

    def capture_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        collectors.append(self)

    def capture_data(self, data, start, end):
        callback_sizes.append(end - start)
        return original_data(self, data, start, end)

    monkeypatch.setattr(bounded_multipart._Collector, "__init__", capture_init)
    monkeypatch.setattr(bounded_multipart._Collector, "_part_data", capture_data)
    import tracemalloc

    tracemalloc.start()
    try:
        with pytest.raises(BoundedMultipartError) as exc:
            await read_bounded_form(request, max_file_bytes=limit)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert exc.value.status_code == 400
    assert exc.value.detail == SIZE_DETAIL
    assert received == [0, 1]
    assert callback_sizes == [limit, 1]
    assert collectors[0]._data == bytearray()
    assert collectors[0].file_parts == []
    assert peak <= limit * 2 + 256 * 1024
    assert sinks == []
    print(f"abort chunks={len(received)} callbacks={len(callback_sizes)} peak={peak}")


@pytest.mark.asyncio
@pytest.mark.parametrize("final_crlf", [False, True])
async def test_terminal_boundary_accepts_only_canonical_completion(final_crlf):
    body = _body([_part("file", b"data", filename="x.docx")])
    if not final_crlf:
        body = body[:-2]
    form = await _read(body)
    assert form.file_bytes == b"data"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "suffix",
    [b"X", b"\r\n", b"\x00", b"\xff\x80", b"--bnd--\r\n", b"PRIVATE-TRAILER-SENTINEL"],
    ids=["ascii", "extra-crlf", "nul", "binary", "second-boundary", "sentinel"],
)
async def test_terminal_boundary_rejects_all_trailing_bytes(suffix, caplog, sinks):
    body = _body([_part("file", b"data", filename="x.docx")]) + suffix
    with caplog.at_level(logging.DEBUG), pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400
    assert exc.value.detail == "The upload could not be read as multipart form data."
    assert "PRIVATE-TRAILER-SENTINEL" not in caplog.text
    assert "0x" not in _parser_logs(caplog).lower()
    assert "PRIVATE-TRAILER-SENTINEL" not in str(exc.value)
    assert sinks == []


@pytest.mark.asyncio
async def test_terminal_boundary_rejects_split_chunk_trailer(caplog, sinks):
    body = _body([_part("file", b"data", filename="x.docx")])
    request, received = _chunked_request([body, b"PRIVATE-TRAILER-SENTINEL"])
    with caplog.at_level(logging.DEBUG), pytest.raises(BoundedMultipartError) as exc:
        await read_bounded_form(request, max_file_bytes=1024)
    assert received == [0, 1]
    assert exc.value.status_code == 400
    assert "PRIVATE-TRAILER-SENTINEL" not in caplog.text + str(exc.value)
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []


@pytest.mark.asyncio
async def test_terminal_boundary_accepts_split_canonical_crlf():
    body = _body([_part("file", b"data", filename="x.docx")])
    request, received = _chunked_request([body[:-1], body[-1:]])
    result = await read_bounded_form(request, max_file_bytes=1024)
    assert received == [0, 1]
    assert result.file_bytes == b"data"


_VALID_DISPOSITION = b'Content-Disposition: form-data; name="file"; filename="x.docx"'
_AMBIGUOUS_HEADERS = [
    [_VALID_DISPOSITION, _VALID_DISPOSITION],
    [_VALID_DISPOSITION, b"Content-Type: application/octet-stream", b"content-type: text/plain"],
    [b'Content-Disposition: form-data; name="file"; NAME=file; filename="x.docx"'],
    [b'Content-Disposition: form-data; name=file; filename="x.docx"; FILENAME=x.docx'],
    [b"Content-Disposition: form-data; name=file; filename*=utf-8''x.docx; FILENAME*=utf-8''x.docx"],
    [b'Content-Disposition: form-data; name=file; filename="x.docx"; filename*=utf-8\'\'x.docx'],
    [b'Content-Disposition: form-data; name=file; filename="PRIVATE-HEADER\\q.docx"'],
    [b'Content-Disposition: form-data; name=file; filename="x.docx"; extra=a; EXTRA=b'],
    [_VALID_DISPOSITION, b"Content-Type: application/octet-stream; charset=a; CHARSET=b"],
]


@pytest.mark.parametrize(
    "headers",
    _AMBIGUOUS_HEADERS,
    ids=[
        "disposition-header", "content-type-header", "name-parameter", "filename-parameter",
        "extended-filename-parameter", "filename-and-extended", "bad-escape",
        "other-parameter", "part-content-type-parameter",
    ],
)
def test_header_ambiguity_rejected_without_audit_or_private_logs(client, headers, caplog, sinks):
    body = _raw_file(headers, make_docx_bytes())
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            "/api/audit",
            content=body,
            headers={"content-type": "multipart/form-data; boundary=bnd"},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "The upload could not be read as multipart form data."
    assert client.get("/api/audits").json() == []
    assert "PRIVATE-HEADER" not in caplog.text + response.text
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []


@pytest.mark.parametrize(
    "content_type",
    [
        "multipart/form-data; boundary=bnd; boundary=bnd",
        "multipart/form-data; boundary=bnd; BOUNDARY=other",
        "multipart/form-data; boundary=bnd; charset=a; CHARSET=b",
    ],
)
def test_header_ambiguity_in_request_type_is_rejected(client, content_type, caplog, sinks):
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            "/api/audit", content=_raw_file([_VALID_DISPOSITION], make_docx_bytes()),
            headers={"content-type": content_type},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "The upload could not be read as multipart form data."
    assert client.get("/api/audits").json() == []
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []


@pytest.mark.asyncio
async def test_header_ambiguity_duplicate_request_content_type_is_rejected():
    request = _request(_raw_file([_VALID_DISPOSITION]))
    request.scope["headers"].append((b"content-type", b"multipart/form-data; boundary=other"))
    with pytest.raises(BoundedMultipartError) as exc:
        await read_bounded_form(request, max_file_bytes=1024)
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_logging_safety_isolated_from_other_parser_logs(caplog):
    body = b'--bnd\r\nContent-Disposition: form-data; name="file"\rXPRIVATE-HEADER'
    with caplog.at_level(logging.DEBUG):
        logging.getLogger("multipart.multipart").warning("independent parser warning")
        with pytest.raises(BoundedMultipartError) as exc:
            await _read(body)
    assert "independent parser warning" in caplog.text
    assert "PRIVATE-HEADER" not in caplog.text + str(exc.value)
    assert "found 88" not in caplog.text


@pytest.mark.asyncio
async def test_cleanup_after_cancelled_request(monkeypatch, sinks):
    collectors = []
    original_init = bounded_multipart._Collector.__init__

    def capture_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        collectors.append(self)

    async def receive():
        raise asyncio.CancelledError()

    monkeypatch.setattr(bounded_multipart._Collector, "__init__", capture_init)
    request = _request(b"")
    request._receive = receive
    with pytest.raises(asyncio.CancelledError):
        await read_bounded_form(request, max_file_bytes=1024)
    assert collectors[0]._data == bytearray()
    assert collectors[0].file_parts == []
    assert sinks == []


@pytest.mark.asyncio
async def test_cleanup_exception_is_sanitized(monkeypatch, caplog, sinks):
    def fail_close(self):
        raise RuntimeError("PRIVATE-CLEANUP-SENTINEL")

    monkeypatch.setattr(bounded_multipart.MultipartParser, "close", fail_close)
    with caplog.at_level(logging.DEBUG), pytest.raises(BoundedMultipartError) as exc:
        await _read(_body([_part("file", b"data", filename="x.docx")]))
    assert exc.value.status_code == 400
    assert "PRIVATE-CLEANUP-SENTINEL" not in caplog.text + str(exc.value)
    assert sinks == []


@pytest.mark.parametrize(
    "path",
    [
        "/api/audit",
        "/api/audit/00000000-0000-0000-0000-000000000000/guided-fixes/review",
        "/api/audit/00000000-0000-0000-0000-000000000000/guided-fixes",
    ],
)
def test_all_three_endpoints_reject_trailing_payload_without_audit(client, path, caplog, sinks):
    body = _raw_file([_VALID_DISPOSITION], make_docx_bytes()) + b"PRIVATE-TRAILER-SENTINEL"
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            path, content=body, headers={"content-type": "multipart/form-data; boundary=bnd"}
        )
    assert response.status_code == 400
    assert client.get("/api/audits").json() == []
    assert "PRIVATE-TRAILER-SENTINEL" not in response.text + caplog.text
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []


@pytest.mark.asyncio
async def test_header_raw_leading_whitespace_is_bounded(sinks):
    body = _raw_file([
        _VALID_DISPOSITION,
        b"Content-Type:" + b" " * (MAX_PART_HEADER_BYTES + 1) + b"text/plain",
    ])
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(body)
    assert exc.value.status_code == 400
    assert sinks == []


@pytest.mark.asyncio
async def test_header_count_is_bounded(sinks):
    headers = [_VALID_DISPOSITION]
    headers.extend(
        f"X-{chr(65 + index // 26)}{chr(65 + index % 26)}: value".encode()
        for index in range(33)
    )
    with pytest.raises(BoundedMultipartError) as exc:
        await _read(_raw_file(headers))
    assert exc.value.status_code == 400
    assert sinks == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["trailing", "ambiguous-header"])
async def test_failure_peak_memory_stays_bounded(failure, caplog, sinks):
    import tracemalloc

    limit = 10 * 1024 * 1024
    if failure == "trailing":
        body = _raw_file([_VALID_DISPOSITION], b"x" * limit) + b"PRIVATE-TRAILER-SENTINEL"
    else:
        body = _raw_file(_AMBIGUOUS_HEADERS[2], b"x" * limit)
    tracemalloc.start()
    try:
        with caplog.at_level(logging.WARNING), pytest.raises(BoundedMultipartError):
            await _read(body)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak <= limit * 2 + 256 * 1024
    assert "PRIVATE-TRAILER-SENTINEL" not in caplog.text
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []
    print(f"failure={failure} peak={peak}")


@pytest.mark.parametrize(
    "suffix",
    [b"X", b"\r\n", b"\x00", b"\xff\x80", b"--bnd--\r\n", b"PRIVATE-TRAILER-SENTINEL"],
    ids=["ascii", "extra-crlf", "nul", "binary", "second-boundary", "sentinel"],
)
def test_terminal_boundary_api_rejection_has_no_audit(client, suffix, caplog, sinks):
    body = _raw_file([_VALID_DISPOSITION], make_docx_bytes()) + suffix
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            "/api/audit", content=body, headers={"content-type": "multipart/form-data; boundary=bnd"}
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "The upload could not be read as multipart form data."
    assert client.get("/api/audits").json() == []
    assert "PRIVATE-TRAILER-SENTINEL" not in response.text + caplog.text
    assert "0x" not in _parser_logs(caplog).lower()
    assert sinks == []


def _fixable_docx(target_size=None):
    """Synthetic DOCX with a referenced image; stored PNG padding survives correction."""
    source = _font_fixture_bytes(make_docx_bytes(
        paragraphs=["PRIVATE-SYNTHETIC-PARAGRAPH"], body_size=11,
        images=1, with_image_caption=False,
    ))
    if target_size is None:
        return source
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        parts = [(info, archive.read(info.filename)) for info in archive.infolist()]
    image = next(info.filename for info, _ in parts if info.filename.startswith("word/media/"))

    def render(padding_size):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for info, content in parts:
                if info.filename == image:
                    padding = b"x" * padding_size
                    kind = b"zzZZ"
                    checksum = zlib.crc32(padding, zlib.crc32(kind)) & 0xFFFFFFFF
                    chunk = struct.pack(">I", padding_size) + kind + padding + struct.pack(">I", checksum)
                    content = content[:-12] + chunk + content[-12:]
                    archive.writestr(info, content, compress_type=zipfile.ZIP_STORED)
                else:
                    archive.writestr(info, content)
        return output.getvalue()

    overhead = len(render(0))
    assert target_size >= overhead
    result = render(target_size - overhead)
    assert len(result) == target_size
    return result


def _trace_snapshot(probe):
    return {
        key: probe[key]
        for key in (
            "adapter_calls", "stream_calls", "chunks", "request_bytes", "file_bytes",
            "form_calls", "starlette_parser_calls",
        )
    }, len(probe["file_writes"])


def _record_endpoint_trace(probe, before, sinks, endpoint, case, response, before_audits, after_audits):
    counts, write_start = before
    delta = {key: probe[key] - value for key, value in counts.items()}
    writes = probe["file_writes"][write_start:]
    assert delta["adapter_calls"] == 1
    assert delta["form_calls"] == 0
    assert delta["starlette_parser_calls"] == 0
    assert all(not event["matches_original"] for event in writes)
    assert all(event["destination"] == "task-owned" for event in writes)
    assert sinks == []
    print("ALIAS_TRACE " + json.dumps({
        "endpoint": endpoint,
        "case": case,
        "status": response.status_code,
        **delta,
        "starlette_spool_constructions": 0,
        "tempfile_spool_constructions": 0,
        "other_instrumented_sink_calls": 0,
        "low_level_writes": writes,
        "audits_before": before_audits,
        "audits_after": after_audits,
    }, sort_keys=True))


@pytest.mark.parametrize(
    "handler",
    [
        api_routes.audit_document,
        api_routes.review_guided_fixes_endpoint,
        api_routes.apply_guided_fixes_endpoint,
    ],
)
def test_alias_route_signatures_use_request_without_uploadfile(handler):
    from fastapi import UploadFile
    from fastapi.params import File

    parameters = inspect.signature(handler).parameters.values()
    assert any(parameter.annotation is Request for parameter in parameters)
    assert all(parameter.annotation is not UploadFile for parameter in parameters)
    assert all(not isinstance(parameter.default, File) for parameter in parameters)


@pytest.mark.parametrize("endpoint", ["audit", "review", "apply"])
@pytest.mark.parametrize("size", ["small", "above-one-mib", "exact-ten-mib"])
def test_alias_three_endpoints_accept_valid_docx_without_spooling(
    client, monkeypatch, route_probe, sinks, tmp_path, caplog, endpoint, size,
):
    target = {"small": None, "above-one-mib": 1100000, "exact-ten-mib": 10 * 1024 * 1024}[size]
    source = _fixable_docx(target)
    filename = "PRIVATE-SYNTHETIC-NAME.docx"
    monkeypatch.setattr(guided_fix_storage.settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path / "approved"))
    monkeypatch.setattr(guided_fix_storage, "_outputs", {})
    monkeypatch.setattr(api_routes, "_reviews", {})
    audit_id = None
    fields = {}
    if endpoint != "audit":
        initial = client.post("/api/audit", files={"file": (filename, source, "application/octet-stream")})
        assert initial.status_code == 200
        audit_id = initial.json()["audit_id"]
        ids = [v["id"] for v in initial.json()["physical_layout_errors"] if v["rule_code"] == "FONT_SIZE"]
        assert ids
        fields["selection"] = json.dumps({"violation_ids": ids})
        if endpoint == "apply":
            review = client.post(
                f"/api/audit/{audit_id}/guided-fixes/review",
                files={"file": (filename, source, "application/octet-stream")}, data=fields,
            )
            assert review.status_code == 200
            fields["review_id"] = review.json()["review_id"]
    path = {
        "audit": "/api/audit",
        "review": f"/api/audit/{audit_id}/guided-fixes/review",
        "apply": f"/api/audit/{audit_id}/guided-fixes",
    }[endpoint]
    before_audits = len(client.get("/api/audits").json())
    before = _trace_snapshot(route_probe)
    route_probe["original_digest"] = hashlib.sha256(source).digest()
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(path, files={"file": (filename, source, "application/octet-stream")}, data=fields)
    assert response.status_code == 200
    after_audits = len(client.get("/api/audits").json())
    assert after_audits == before_audits + (endpoint == "audit")
    assert filename not in response.text + caplog.text
    assert "PRIVATE-SYNTHETIC-PARAGRAPH" not in response.text + caplog.text
    _record_endpoint_trace(route_probe, before, sinks, endpoint, size, response, before_audits, after_audits)
    if endpoint == "apply":
        token = response.json()["download_token"]
        assert client.get(f"/api/audit/{audit_id}/guided-fixes/download/{token}").status_code == 200
        assert not list((tmp_path / "approved").glob("*.docx"))


_TRACE_FILENAME = "PRIVATE-SYNTHETIC-NAME.docx"
_TRACE_BOUNDARY = b"PRIVATE-SYNTHETIC-BOUNDARY"


def _trace_part(name, payload, *, file=False, duplicate_name=False):
    disposition = f'form-data; name="{name}"'
    if duplicate_name:
        disposition += f'; NAME="{name}"'
    if file:
        disposition += f'; filename="{_TRACE_FILENAME}"'
    return (
        b"--" + _TRACE_BOUNDARY + b"\r\nContent-Disposition: "
        + disposition.encode("ascii") + b"\r\n\r\n" + payload + b"\r\n"
    )


def _trace_body(parts, trailer=b""):
    return b"".join(parts) + b"--" + _TRACE_BOUNDARY + b"--\r\n" + trailer


@pytest.mark.parametrize("endpoint", ["audit", "review", "apply"])
@pytest.mark.parametrize(
    "case",
    ["over-limit", "invalid", "encrypted", "missing", "duplicate-file",
     "malformed-boundary", "trailing", "duplicate-parameter"],
)
def test_alias_three_endpoints_reject_without_spooling_or_state(
    client, monkeypatch, route_probe, sinks, tmp_path, caplog, endpoint, case,
):
    monkeypatch.setattr(guided_fix_storage.settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path / "approved"))
    monkeypatch.setattr(guided_fix_storage, "_outputs", {})
    monkeypatch.setattr(api_routes, "_reviews", {})
    valid_source = _fixable_docx()
    if case == "over-limit":
        payload = b"x" * (10 * 1024 * 1024 + 1)
    elif case == "invalid":
        payload = b"PRIVATE-SYNTHETIC-DOCUMENT-BYTES"
    elif case == "encrypted":
        payload = bytes.fromhex("D0CF11E0A1B11AE1") + b"PRIVATE-SYNTHETIC-DOCUMENT-BYTES"
    else:
        payload = valid_source
    file_part = _trace_part("file", payload, file=True, duplicate_name=case == "duplicate-parameter")
    parts = [] if case == "missing" else [file_part]
    if case == "duplicate-file":
        parts.append(file_part)
    if endpoint != "audit":
        parts.append(_trace_part("selection", b'{"violation_ids":[]}'))
    if endpoint == "apply":
        parts.append(_trace_part("review_id", b"synthetic-review"))
    if endpoint == "audit" and case == "missing":
        parts.append(_trace_part("custom_profile", b"{}"))
    trailer = b"PRIVATE-SYNTHETIC-TRAILER" if case == "trailing" else b""
    body = _trace_body(parts, trailer)
    content_type = (
        "multipart/form-data" if case == "malformed-boundary"
        else "multipart/form-data; boundary=" + _TRACE_BOUNDARY.decode("ascii")
    )
    path = {
        "audit": "/api/audit",
        "review": "/api/audit/00000000-0000-0000-0000-000000000000/guided-fixes/review",
        "apply": "/api/audit/00000000-0000-0000-0000-000000000000/guided-fixes",
    }[endpoint]
    before_audits = len(client.get("/api/audits").json())
    before_tokens = set(guided_fix_storage._outputs)
    before = _trace_snapshot(route_probe)
    route_probe["original_digest"] = hashlib.sha256(payload).digest()
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(path, content=body, headers={"content-type": content_type})
    assert response.status_code == (422 if case == "missing" else 400)
    if case == "over-limit":
        assert response.json()["detail"] == SIZE_DETAIL
    if case == "encrypted" and endpoint == "audit":
        assert "encrypted or password-protected" in response.json()["detail"]
    after_audits = len(client.get("/api/audits").json())
    assert after_audits == before_audits
    assert set(guided_fix_storage._outputs) == before_tokens
    combined = response.text + caplog.text
    assert _TRACE_FILENAME not in combined
    assert _TRACE_BOUNDARY.decode("ascii") not in combined
    assert "PRIVATE-SYNTHETIC-TRAILER" not in combined
    assert "PRIVATE-SYNTHETIC-DOCUMENT-BYTES" not in combined
    assert "0x" not in _parser_logs(caplog).lower()
    _record_endpoint_trace(route_probe, before, sinks, endpoint, case, response, before_audits, after_audits)


_SENTINELS = {
    "exception_message": "PRIVATE-EXCEPTION-MESSAGE-SENTINEL",
    "windows_user_path": r"C:\Users\JohnDoe\Confidential\thesis.docx",
    "temporary_path": r"C:\Temp\localappdata\temp_doc.tmp",
    "original_filename": "Confidential_Thesis_2026.docx",
    "document_text": "PRIVATE-DOCUMENT-TEXT-CONFIDENTIAL-FINDINGS",
    "multipart_boundary": "----WebKitFormBoundaryX9zQ7vL2kM4p1wR",
    "secret_token": "sec_live_9948201a8fbc4d20892a7e41",
    "sql_statement": "SELECT * FROM users WHERE ssn='000-12-3456'",
    "hex_payload": "0x48656c6c6f20576f726c6421",
}
_SENTINEL_PAYLOAD = " ".join(f"{k}={v}" for k, v in _SENTINELS.items())


def _assert_five_path_logging_safety(caplog, response, expected_name, expected_message, tmp_path=None):
    error_records = [
        record for record in caplog.records if record.levelno >= logging.ERROR
    ]
    assert len(error_records) == 1, (
        f"Expected exactly 1 error log record, found {len(error_records)}: "
        f"{[r.name + ':' + r.getMessage() for r in error_records]}"
    )
    record = error_records[0]
    assert record.name == expected_name
    assert record.getMessage() == expected_message
    assert record.exc_info is None
    assert record.stack_info is None
    assert not any(v in str(record.msg) for v in _SENTINELS.values())
    if record.args:
        args_str = " ".join(str(a) for a in (record.args if isinstance(record.args, tuple) else [record.args]))
        assert not any(v in args_str for v in _SENTINELS.values())
    combined = response.text + caplog.text
    for sentinel_name, sentinel_val in _SENTINELS.items():
        assert sentinel_val not in combined, f"Sentinel {sentinel_name} leaked in response or logs!"
    assert "Traceback" not in caplog.text
    assert "RuntimeError" not in caplog.text
    assert "OSError" not in caplog.text
    if tmp_path is not None:
        assert str(tmp_path) not in combined
    assert str(pathlib.Path(api_routes.__file__).resolve()) not in combined


@pytest.mark.parametrize("endpoint", ["audit", "review", "apply"])
def test_alias_postparse_handler_failure_is_private_and_creates_no_state(
    client, monkeypatch, route_probe, sinks, tmp_path, caplog, endpoint,
):
    source = _fixable_docx()
    filename = _TRACE_FILENAME
    monkeypatch.setattr(guided_fix_storage.settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path / "approved"))
    monkeypatch.setattr(guided_fix_storage, "_outputs", {})
    monkeypatch.setattr(api_routes, "_reviews", {})
    audit_id = None
    fields = {}
    if endpoint != "audit":
        initial = client.post("/api/audit", files={"file": (filename, source, "application/octet-stream")})
        assert initial.status_code == 200
        audit_id = initial.json()["audit_id"]
        ids = [v["id"] for v in initial.json()["physical_layout_errors"] if v["rule_code"] == "FONT_SIZE"]
        assert ids
        fields["selection"] = json.dumps({"violation_ids": ids})
        if endpoint == "apply":
            review = client.post(
                f"/api/audit/{audit_id}/guided-fixes/review",
                files={"file": (filename, source, "application/octet-stream")}, data=fields,
            )
            assert review.status_code == 200
            fields["review_id"] = review.json()["review_id"]

    def fail_after_parse(*args, **kwargs):
        raise RuntimeError(f"PRIVATE-HANDLER-SENTINEL {_SENTINEL_PAYLOAD} {tmp_path / 'private.docx'}")

    failure_site = {
        "audit": "parse_document",
        "review": "review_targets",
        "apply": "verify_reaudit",
    }[endpoint]
    monkeypatch.setattr(api_routes, failure_site, fail_after_parse)
    path = {
        "audit": "/api/audit",
        "review": f"/api/audit/{audit_id}/guided-fixes/review",
        "apply": f"/api/audit/{audit_id}/guided-fixes",
    }[endpoint]
    before_audits = len(client.get("/api/audits").json())
    before_tokens = set(guided_fix_storage._outputs)
    before = _trace_snapshot(route_probe)
    route_probe["original_digest"] = hashlib.sha256(source).digest()
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(path, files={"file": (filename, source, "application/octet-stream")}, data=fields)
    assert response.status_code == (500 if endpoint == "audit" else 422)
    after_audits = len(client.get("/api/audits").json())
    assert after_audits == before_audits
    assert set(guided_fix_storage._outputs) == before_tokens
    _record_endpoint_trace(route_probe, before, sinks, endpoint, "postparse-handler-failure", response, before_audits, after_audits)
    expected = {
        "audit": "Audit document opening failed before persistence",
        "review": f"guided review failed audit={audit_id}",
        "apply": f"guided verification failed audit={audit_id}",
    }[endpoint]
    _assert_five_path_logging_safety(caplog, response, api_routes.logger.name, expected, tmp_path)
    assert filename not in response.text + caplog.text
    assert "PRIVATE-SYNTHETIC-PARAGRAPH" not in response.text + caplog.text
    assert "0x" not in _parser_logs(caplog).lower()


def test_audit_processing_failure_logs_no_private_exception_details(
    client, monkeypatch, route_probe, sinks, tmp_path, caplog,
):
    source = _fixable_docx()
    monkeypatch.setattr(guided_fix_storage, "_outputs", {})

    def fail_processing(*args, **kwargs):
        raise RuntimeError(f"PRIVATE-PROCESSING-SENTINEL {_SENTINEL_PAYLOAD} {tmp_path / 'private.docx'}")

    monkeypatch.setattr(api_routes, "run_static_rules_engine", fail_processing)
    before = _trace_snapshot(route_probe)
    route_probe["original_digest"] = hashlib.sha256(source).digest()
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            "/api/audit", files={"file": (_TRACE_FILENAME, source, "application/octet-stream")}
        )
    assert response.status_code == 500
    audits = client.get("/api/audits").json()
    assert len(audits) == 1
    assert audits[0]["status"] == "failed"
    assert not guided_fix_storage._outputs
    expected = f"Audit processing failed for audit_id={audits[0]['id']}"
    _assert_five_path_logging_safety(caplog, response, api_routes.logger.name, expected, tmp_path)
    assert _TRACE_FILENAME not in response.text + caplog.text
    assert "PRIVATE-SYNTHETIC-PARAGRAPH" not in response.text + caplog.text
    _record_endpoint_trace(route_probe, before, sinks, "audit", "processing-failure", response, 0, 1)


def test_guided_storage_failure_logs_no_private_exception_details(
    client, monkeypatch, route_probe, sinks, tmp_path, caplog,
):
    source = _fixable_docx()
    monkeypatch.setattr(guided_fix_storage.settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path / "approved"))
    monkeypatch.setattr(guided_fix_storage, "_outputs", {})
    monkeypatch.setattr(api_routes, "_reviews", {})
    initial = client.post(
        "/api/audit", files={"file": (_TRACE_FILENAME, source, "application/octet-stream")}
    )
    assert initial.status_code == 200
    audit_id = initial.json()["audit_id"]
    ids = [v["id"] for v in initial.json()["physical_layout_errors"] if v["rule_code"] == "FONT_SIZE"]
    assert ids
    fields = {"selection": json.dumps({"violation_ids": ids})}
    review = client.post(
        f"/api/audit/{audit_id}/guided-fixes/review",
        files={"file": (_TRACE_FILENAME, source, "application/octet-stream")}, data=fields,
    )
    assert review.status_code == 200
    fields["review_id"] = review.json()["review_id"]

    def fail_storage(*args, **kwargs):
        raise OSError(f"PRIVATE-STORAGE-SENTINEL {_SENTINEL_PAYLOAD} {tmp_path / 'private.docx'}")

    monkeypatch.setattr(guided_fix_storage, "store", fail_storage)
    before = _trace_snapshot(route_probe)
    route_probe["original_digest"] = hashlib.sha256(source).digest()
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            f"/api/audit/{audit_id}/guided-fixes",
            files={"file": (_TRACE_FILENAME, source, "application/octet-stream")}, data=fields,
        )
    assert response.status_code == 503
    assert response.json()["detail"] == "Verified copy could not be stored. Try again."
    assert "download_token" not in response.json()
    assert not guided_fix_storage._outputs
    expected = f"guided output storage failed audit={audit_id}"
    _assert_five_path_logging_safety(caplog, response, api_routes.logger.name, expected, tmp_path)
    assert _TRACE_FILENAME not in response.text + caplog.text
    assert "PRIVATE-SYNTHETIC-PARAGRAPH" not in response.text + caplog.text
    _record_endpoint_trace(route_probe, before, sinks, "apply", "storage-failure", response, 1, 1)


def test_outer_middleware_and_duplicate_logging_verification(
    client, monkeypatch, sinks, tmp_path, caplog,
):
    """Verify outer middleware does not reintroduce unsanitized exception logs or duplicate dumps."""
    source = _fixable_docx()

    def fail_open(*args, **kwargs):
        raise RuntimeError(f"PRIVATE-OUTER-CHECK-SENTINEL {_SENTINEL_PAYLOAD}")

    monkeypatch.setattr(api_routes, "parse_document", fail_open)
    caplog.clear()
    with caplog.at_level(logging.DEBUG):
        response = client.post(
            "/api/audit", files={"file": (_TRACE_FILENAME, source, "application/octet-stream")}
        )
    assert response.status_code == 500
    all_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(all_records) == 1
    assert all_records[0].name == api_routes.logger.name
    assert not any("middleware" in r.name.lower() for r in caplog.records if r.levelno >= logging.ERROR)
    assert "Traceback" not in caplog.text
    assert not any(v in caplog.text for v in _SENTINELS.values())
    assert not any(v in response.text for v in _SENTINELS.values())
