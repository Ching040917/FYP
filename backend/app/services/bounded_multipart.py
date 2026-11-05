"""Bounded in-memory multipart reader for the DOCX upload endpoints.

Owner decision D-03 forbids original uploaded DOCX bytes from reaching any
disk-backed temporary file.  Starlette 0.37.2 parses every ``form-data`` file
part into a ``SpooledTemporaryFile`` that rolls over to disk above 1 MiB, so the
three DOCX endpoints read their own bounded multipart body instead of declaring
``UploadFile``.

The reader streams ``request.stream()`` through the installed python-multipart
callback parser and keeps the single file part in one bounded ``bytearray``.
Nothing is written to disk, no ``UploadFile`` is created, and every bound is
enforced while the bytes are still arriving.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, List, Optional, Tuple

from multipart.exceptions import MultipartParseError
from multipart.multipart import MultipartParser
from starlette.requests import ClientDisconnect, Request

FILE_FIELD = "file"
MAX_DOCX_BYTES = 10 * 1024 * 1024

# Per-part and per-request bounds.  The total overhead allowance is derived
# from the individual bounds, so a request that respects each of them can never
# exceed it:
#   headers: MAX_PARTS * MAX_PART_HEADER_BYTES          = 128 KiB
#   scalars: MAX_SCALAR_PARTS * MAX_FIELD_BYTES         = 512 KiB
#   boundary/CRLF slack                                  =  64 KiB
MAX_PART_HEADER_BYTES = 16 * 1024
MAX_PART_HEADERS = 32
MAX_PARTS = 8
MAX_SCALAR_PARTS = 4
MAX_FIELD_BYTES = 128 * 1024
MAX_FIELD_NAME_BYTES = 64
MAX_FILENAME_BYTES = 255
MAX_BOUNDARY_BYTES = 70
MAX_TOTAL_OVERHEAD = (
    MAX_PARTS * MAX_PART_HEADER_BYTES
    + MAX_SCALAR_PARTS * MAX_FIELD_BYTES
    + 64 * 1024
)

_BOUNDARY_RE = re.compile(r"[0-9A-Za-z'()+_,\-./:=? ]{1,70}")
_PARSER_STOP = re.compile(rb"[-\n]")
_TOKEN = rb"[!#$%&'*+\-.^_`|~0-9A-Za-z]+"
_PARAMETER = re.compile(
    rb'[ \t]*;[ \t]*(' + _TOKEN + rb')[ \t]*=[ \t]*('
    + _TOKEN + rb'|"(?:[^"\\\x00-\x1f\x7f]|\\["\\])*")'
)

_DETAIL_PARSE = "The upload could not be read as multipart form data."
_DETAIL_TYPE = "Upload must be sent as multipart/form-data."
_DETAIL_BOUNDARY = "The multipart boundary is missing or invalid."
_DETAIL_TOO_LARGE = "File size exceeds the 10MB security boundary."
_DETAIL_TOO_BIG_REQUEST = "The upload exceeds the permitted request size."
_DETAIL_UNSUPPORTED_FIELD = "The upload contains an unsupported form field."
_DETAIL_MULTIPLE_FILES = "The upload must contain exactly one file."
_DETAIL_DUPLICATE_FIELD = "The upload contains duplicate form fields."
_DETAIL_MISSING_FILE = "Missing required file field."
_DETAIL_MISSING_FIELD = "Missing required form field."
_DETAIL_EXTENSION = "Unsupported file format. Only .docx files are accepted."


class BoundedMultipartError(Exception):
    """Sanitized failure raised by the bounded reader."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass
class BoundedUpload:
    """Parsed multipart form: one bounded file part plus scalar fields."""

    file_bytes: bytes
    filename: str
    fields: Dict[str, str] = field(default_factory=dict)
    file_oversize: bool = False


def _decode(value: bytes) -> str:
    return value.decode("utf-8", "replace")

def _header_options(value: bytes) -> Tuple[bytes, Dict[bytes, bytes]]:
    """Parse this endpoint's bounded header parameters without losing duplicates."""
    if len(value) > MAX_PART_HEADER_BYTES:
        raise BoundedMultipartError(400, _DETAIL_PARSE)
    separator = value.find(b";")
    if separator < 0:
        separator = len(value)
    kind = value[:separator].strip().lower()
    options: Dict[bytes, bytes] = {}
    position = separator
    while value[position:].strip(b" \t"):
        match = _PARAMETER.match(value, position)
        if match is None:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        name, item = match.groups()
        name = name.lower()
        if name in options:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        if item.startswith(b'"'):
            item = re.sub(rb'\\(["\\])', rb'\1', item[1:-1])
        options[name] = item
        position = match.end()
    return kind, options


class _Collector:
    """python-multipart callbacks that enforce every bound incrementally."""

    def __init__(
        self,
        *,
        file_field: str,
        allowed_fields: FrozenSet[str],
        max_file_bytes: int,
        case_sensitive_filename: bool,
    ) -> None:
        self._file_field = file_field
        self._allowed_fields = allowed_fields
        self._max_file_bytes = max_file_bytes
        self._case_sensitive_filename = case_sensitive_filename
        self._file_field_bytes = file_field.encode("utf-8")
        self.callbacks = {
            "on_part_begin": self._part_begin,
            "on_header_field": self._header_field,
            "on_header_value": self._header_value,
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._part_data,
            "on_part_end": self._part_end,
            "on_end": self._end,
        }
        self.parts = 0
        self.scalar_parts = 0
        self.file_parts: List[Tuple[bytes, str, bytes]] = []
        self.fields: Dict[str, str] = {}
        self.ended = False
        self.file_oversize = False
        self._reset_part()

    # -- state ------------------------------------------------------------
    def _reset_part(self) -> None:
        self._header_name = bytearray()
        self._header_value = bytearray()
        self._headers: Dict[bytes, bytes] = {}
        self._header_bytes = 0
        self._reading_headers = False
        self._raw_header_bytes = 0
        self._is_file = False
        self._name: Optional[bytes] = None
        self._filename: Optional[str] = None
        self._data = bytearray()

    # -- callbacks --------------------------------------------------------
    def _part_begin(self) -> None:
        self.parts += 1
        if self.parts > MAX_PARTS:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._reset_part()
        self._reading_headers = True

    def _header_field(self, data: bytes, start: int, end: int) -> None:
        self._header_bytes += end - start
        if self._header_bytes > MAX_PART_HEADER_BYTES:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._header_name.extend(memoryview(data)[start:end])

    def _header_value(self, data: bytes, start: int, end: int) -> None:
        self._header_bytes += end - start
        if self._header_bytes > MAX_PART_HEADER_BYTES:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._header_value.extend(memoryview(data)[start:end])

    def _header_end(self) -> None:
        name = bytes(self._header_name).strip().lower()
        value = bytes(self._header_value).strip()
        if not name or len(name) > MAX_FIELD_NAME_BYTES:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        if name in self._headers:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        if len(self._headers) >= MAX_PART_HEADERS:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._headers[name] = value
        self._header_name = bytearray()
        self._header_value = bytearray()

    def _headers_finished(self) -> None:
        self._reading_headers = False
        content_type = self._headers.get(b"content-type")
        if content_type is not None:
            content_type, _ = _header_options(content_type)
            if content_type.startswith(b"multipart/"):
                raise BoundedMultipartError(400, _DETAIL_TYPE)
        disposition = self._headers.get(b"content-disposition")
        if not disposition:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        disposition_type, options = _header_options(disposition)
        if disposition_type != b"form-data":
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        name = options.get(b"name")
        if not name:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        if len(name) > MAX_FIELD_NAME_BYTES:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        if b"filename*" in options:
            # Extended filenames are not part of these endpoint contracts.
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        filename = options.get(b"filename")
        if filename is not None:
            if name != self._file_field_bytes:
                raise BoundedMultipartError(400, _DETAIL_UNSUPPORTED_FIELD)
            raw = bytes(filename)
            if len(raw) > MAX_FILENAME_BYTES:
                raise BoundedMultipartError(400, _DETAIL_PARSE)
            if b"\r" in raw or b"\n" in raw or b"\x00" in raw:
                raise BoundedMultipartError(400, _DETAIL_PARSE)
            self._is_file = True
            self._filename = _decode(raw)
            candidate = self._filename if self._case_sensitive_filename else self._filename.lower()
            if not candidate.endswith(".docx"):
                raise BoundedMultipartError(400, _DETAIL_EXTENSION)
            return
        decoded_name = _decode(name)
        if decoded_name not in self._allowed_fields:
            raise BoundedMultipartError(400, _DETAIL_UNSUPPORTED_FIELD)
        if decoded_name in self.fields:
            raise BoundedMultipartError(400, _DETAIL_DUPLICATE_FIELD)
        self._name = name

    def _part_data(self, data: bytes, start: int, end: int) -> None:
        length = end - start
        if length <= 0:
            return
        if self._is_file:
            if len(self._data) + length > self._max_file_bytes:
                self._data.clear()
                raise BoundedMultipartError(400, _DETAIL_TOO_LARGE)
        elif len(self._data) + length > MAX_FIELD_BYTES:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._data.extend(memoryview(data)[start:end])

    def _part_end(self) -> None:
        if self._is_file:
            self.file_parts.append((self._name, self._filename or "", bytes(self._data)))
            if len(self.file_parts) > 1:
                raise BoundedMultipartError(400, _DETAIL_MULTIPLE_FILES)
        elif self._name is not None:
            self.fields[_decode(self._name)] = _decode(bytes(self._data))
            self.scalar_parts += 1
            if self.scalar_parts > MAX_SCALAR_PARTS:
                raise BoundedMultipartError(400, _DETAIL_PARSE)
        self._reset_part()

    def _end(self) -> None:
        self.ended = True

    # -- results ----------------------------------------------------------
    def single_file(self) -> Tuple[bytes, str]:
        if not self.file_parts:
            raise BoundedMultipartError(422, _DETAIL_MISSING_FILE)
        _, filename, payload = self.file_parts[0]
        return payload, filename


async def read_bounded_form(
    request: Request,
    *,
    file_field: str = FILE_FIELD,
    allowed_fields: FrozenSet[str] = frozenset(),
    required_fields: FrozenSet[str] = frozenset(),
    case_sensitive_filename: bool = True,
    max_file_bytes: int,
) -> BoundedUpload:
    """Read one bounded multipart form without touching disk.

    Raises ``BoundedMultipartError`` with a sanitized status/detail pair for any
    rejection.  The original file bytes are held only in a bounded ``bytearray``
    until the handler finishes with the returned immutable bytes.
    """
    max_file_bytes = max(0, min(max_file_bytes, MAX_DOCX_BYTES))
    content_types = request.headers.getlist("content-type")
    if len(content_types) > 1:
        raise BoundedMultipartError(400, _DETAIL_PARSE)
    content_type, options = _header_options(
        content_types[0].encode("latin-1") if content_types else b""
    )
    if content_type != b"multipart/form-data":
        # FastAPI previously reported any non-form request as a missing required
        # file field (422); keep that contract.
        raise BoundedMultipartError(422, _DETAIL_MISSING_FILE)
    boundary = options.get(b"boundary")
    if not boundary or len(boundary) > MAX_BOUNDARY_BYTES:
        raise BoundedMultipartError(400, _DETAIL_BOUNDARY)
    try:
        boundary_text = boundary.decode("ascii")
    except UnicodeDecodeError:
        raise BoundedMultipartError(400, _DETAIL_BOUNDARY) from None
    if not _BOUNDARY_RE.fullmatch(boundary_text) or boundary_text.endswith(" "):
        raise BoundedMultipartError(400, _DETAIL_BOUNDARY)

    collector = _Collector(
        file_field=file_field,
        allowed_fields=allowed_fields,
        max_file_bytes=max_file_bytes,
        case_sensitive_filename=case_sensitive_filename,
    )
    max_total_bytes = max_file_bytes + MAX_TOTAL_OVERHEAD
    parser = MultipartParser(boundary, collector.callbacks, max_size=max_total_bytes + 1)
    # python-multipart 0.0.6 logs input bytes for malformed messages. Isolate
    # only this parser instance; unrelated multipart/application logs remain on.
    parser.logger = logging.Logger(__name__ + ".request_parser")
    parser.logger.addHandler(logging.NullHandler())
    parser.logger.propagate = False
    consumed = 0
    terminal_crlf = 0
    try:
        async for chunk in request.stream():
            position = 0
            while position < len(chunk):
                if consumed >= max_total_bytes:
                    raise BoundedMultipartError(400, _DETAIL_TOO_BIG_REQUEST)
                if collector.ended:
                    byte = chunk[position]
                    if terminal_crlf == 0 and byte == 13:
                        terminal_crlf = 1
                    elif terminal_crlf == 1 and byte == 10:
                        terminal_crlf = 2
                    else:
                        raise BoundedMultipartError(400, _DETAIL_PARSE)
                    position += 1
                    consumed += 1
                    continue

                # A completion callback occurs on a hyphen; a header callback
                # occurs on LF. End writes at those bytes so no byte beyond
                # completion or the first excess file byte reaches the parser.
                end = min(len(chunk), position + max_total_bytes - consumed)
                if collector._is_file:
                    remaining = max_file_bytes - len(collector._data)
                    end = min(end, position + remaining + 1)
                stop = _PARSER_STOP.search(chunk, position, end)
                if stop is not None:
                    end = stop.end()
                if collector._reading_headers:
                    collector._raw_header_bytes += end - position
                    if collector._raw_header_bytes > MAX_PART_HEADER_BYTES:
                        raise BoundedMultipartError(400, _DETAIL_PARSE)
                parser.write(memoryview(chunk)[position:end])
                consumed += end - position
                position = end
        if not collector.ended or terminal_crlf == 1:
            raise BoundedMultipartError(400, _DETAIL_PARSE)
        file_bytes, filename = collector.single_file()
        missing = [name for name in required_fields if name not in collector.fields]
        if missing:
            raise BoundedMultipartError(422, _DETAIL_MISSING_FIELD)
        return BoundedUpload(
            file_bytes=file_bytes,
            filename=filename,
            fields=dict(collector.fields),
        )
    except BoundedMultipartError:
        raise
    except (ClientDisconnect, MultipartParseError, OSError):
        raise BoundedMultipartError(400, _DETAIL_PARSE) from None
    finally:
        collector._data.clear()
        collector.file_parts.clear()
        collector.fields.clear()
        try:
            parser.close()
        except Exception:
            raise BoundedMultipartError(400, _DETAIL_PARSE) from None
