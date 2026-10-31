"""In-app download of the optional Ollama citation-guidance model.

Ordinary users previously had to run `ollama pull <model>` in a terminal to
obtain the optional local model. This module lets ACA ask the user's own
loopback Ollama service to pull **only** the trusted configured model, and
reports progress to the frontend.

Security and scope boundaries enforced here (and by its tests):

- The Ollama origin is ``settings.OLLAMA_HOST`` and is accepted only when it
  is a plain http origin for a loopback host, with no credentials, query,
  fragment, or path. Nothing in an HTTP request can influence the origin or
  the model name: the start endpoint declares no application parameters.
- Only ``settings.OLLAMA_MODEL`` is pulled; ``insecure`` is always False.
- The configured model is checked through ``/api/tags`` before any pull, so an
  already-installed model completes without a redundant download.
- One active job per process; a second start request is refused, not queued.
  Packaged ACA runs a single application process, so there is no cross-process
  job coordination and none is claimed.
- Progress state is in memory only: no database write, no migration, no file,
  and nothing written to Audit History.
- Snapshots are presentation-safe: no digest, registry URL, filesystem path,
  exception text, or audit data ever appears in the payload.
- Logging records state names, error categories, and numeric counters only —
  never NDJSON payload text, digests, exception messages, or user data.

Cancellation is deliberately not offered: Ollama 0.35.1 has no cancel
endpoint (`POST /api/cancel` and `POST /api/pull/cancel` both answer 404) and
the server keeps downloading after a client disconnects (ollama/ollama issue
#13142). No cancel state is ever produced, no cancel endpoint exists, and
Ollama is never terminated to imitate one.
"""
import asyncio
import json
import logging
from typing import Dict, List, Literal, Optional

import httpx
from pydantic import BaseModel, ConfigDict

from app.config import settings
from app.services.loopback_validator import loopback_origin as _pure_loopback_origin


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

MODEL_DOWNLOAD_IDLE = "idle"
MODEL_DOWNLOAD_STARTING = "starting"
MODEL_DOWNLOAD_WAITING_FOR_OLLAMA = "waiting_for_ollama"
MODEL_DOWNLOAD_DOWNLOADING = "downloading"
MODEL_DOWNLOAD_VERIFYING = "verifying"
MODEL_DOWNLOAD_COMPLETED = "completed"
MODEL_DOWNLOAD_FAILED = "failed"
MODEL_DOWNLOAD_DISCONNECTED = "disconnected"

DownloadState = Literal[
    "idle",
    "starting",
    "waiting_for_ollama",
    "downloading",
    "verifying",
    "completed",
    "failed",
    "disconnected",
]

ErrorCategory = Literal[
    "ollama_unavailable",
    "ollama_error",
    "ollama_disconnected",
    "stalled",
    "verification_failed",
    "malformed_response",
    "unsupported_host",
    "unknown",
]

MODEL_DOWNLOAD_ACTIVE_STATES = frozenset({
    MODEL_DOWNLOAD_STARTING,
    MODEL_DOWNLOAD_WAITING_FOR_OLLAMA,
    MODEL_DOWNLOAD_DOWNLOADING,
    MODEL_DOWNLOAD_VERIFYING,
})

MODEL_DOWNLOAD_MESSAGES = {
    MODEL_DOWNLOAD_IDLE: "No model download is in progress.",
    MODEL_DOWNLOAD_STARTING: "Preparing the Citation Guidance Model download\u2026",
    MODEL_DOWNLOAD_WAITING_FOR_OLLAMA: "Waiting for Ollama to start\u2026",
    MODEL_DOWNLOAD_DOWNLOADING: "Downloading the Citation Guidance Model\u2026",
    MODEL_DOWNLOAD_VERIFYING: "Checking the downloaded model\u2026",
    MODEL_DOWNLOAD_COMPLETED: "Citation Guidance Model is ready.",
    MODEL_DOWNLOAD_FAILED: "The Citation Guidance Model could not be downloaded.",
    MODEL_DOWNLOAD_DISCONNECTED: (
        "The connection to Ollama was lost. You can try again."
    ),
}

# Deliberately generic: the configured origin is never echoed back.
UNSUPPORTED_HOST_MESSAGE = (
    "Local AI is configured to use a network address this action does not support."
)

# Connection is bounded tightly; the read timeout doubles as the inactivity
# timeout between streamed NDJSON events. There is no total timeout: a
# legitimate multi-gigabyte pull may take hours.
_PULL_CONNECT_TIMEOUT_S = 5.0
_PULL_READ_TIMEOUT_S = 120.0
_PROBE_TIMEOUT_S = 3.0
# Bounded start retries so a just-started Ollama can become reachable.
# Never an unbounded retry loop.
_PULL_START_ATTEMPTS = 3
_PULL_RETRY_DELAY_S = 2.0


_VERIFYING_STATUSES = frozenset({
    "verifying sha256 digest",
    "writing manifest",
    "removing any unused layers",
})

_PROBE_TIMEOUT = httpx.Timeout(_PROBE_TIMEOUT_S)
_PULL_TIMEOUT = httpx.Timeout(_PULL_READ_TIMEOUT_S, connect=_PULL_CONNECT_TIMEOUT_S)


class LocalModelDownloadStatus(BaseModel):
    """One snapshot of the local-model download job.

    Strict and presentation-safe: exactly these eight fields, nothing else.
    """

    # `model_name` is part of the mandated public contract, so the pydantic
    # `model_` protected namespace must be disabled for this model.
    model_config = ConfigDict(extra="forbid", protected_namespaces=())

    state: DownloadState
    message: str
    model_name: str
    bytes_completed: Optional[int] = None
    bytes_total: Optional[int] = None
    percentage: Optional[int] = None
    retryable: bool = False
    error_category: Optional[ErrorCategory] = None


# ---------------------------------------------------------------------------
# In-memory job state
#
# One job per process. Each job owns its snapshot dict and publishes through
# `_publish`, which is a no-op once that job has been superseded — so a
# cancelled or stale task can never overwrite a newer job's status.
# ---------------------------------------------------------------------------

_lock = asyncio.Lock()
_status: Optional[Dict[str, object]] = None
_task: Optional["asyncio.Task[None]"] = None


def _new_status(state: str, *, retryable: bool = False,
                error_category: Optional[str] = None,
                message: Optional[str] = None) -> Dict[str, object]:
    return {
        "state": state,
        "message": message or MODEL_DOWNLOAD_MESSAGES[state],
        "model_name": settings.OLLAMA_MODEL,
        "bytes_completed": None,
        "bytes_total": None,
        "percentage": None,
        "retryable": retryable,
        "error_category": error_category,
    }


def _publish(job: Dict[str, object], state: str, *, retryable: bool = False,
             error_category: Optional[str] = None,
             message: Optional[str] = None) -> None:
    """Set a job's state, preserving byte counters. No-op if superseded."""
    if _status is not job:
        return

    counters = {
        "bytes_completed": job.get("bytes_completed"),
        "bytes_total": job.get("bytes_total"),
        "percentage": job.get("percentage"),
    }
    job.update(_new_status(state, retryable=retryable,
                           error_category=error_category, message=message))
    job.update(counters)
    logger.info(
        "local_model_download state=%s category=%s completed_bytes=%s total_bytes=%s",
        state, error_category, job.get("bytes_completed"), job.get("bytes_total"),
    )


def get_status() -> Dict[str, object]:
    """Return the current snapshot. Never raises, never touches the network."""
    if _status is None:
        return _new_status(MODEL_DOWNLOAD_IDLE)
    return dict(_status)


def reset_state() -> None:
    """Test helper — drop the job snapshot and cancel any in-flight task.

    Mirrors ``setup_readiness.reset_cache``. Safe to call between tests: the
    superseded job can no longer publish because its snapshot identity no
    longer matches the module-level status.
    """
    global _status, _task

    task, _task = _task, None
    _status = None
    if task is not None and not task.done():
        task.cancel()


# ---------------------------------------------------------------------------
# Origin validation — loopback only, never influenced by a request
# ---------------------------------------------------------------------------

def loopback_origin() -> Optional[str]:
    """Return the validated loopback Ollama origin, or None when refused.

    Accepts only an http origin whose hostname is a loopback address, with no
    username, password, query, fragment, or path beyond an optional trailing
    slash, and a syntactically valid port. The configured value is never
    echoed back to a caller or into an error message.
    """
    return _pure_loopback_origin(settings.OLLAMA_HOST)

# ---------------------------------------------------------------------------
# Progress accounting
# ---------------------------------------------------------------------------


def _aggregate(layers: Dict[str, Dict[str, int]]) -> Dict[str, Optional[int]]:
    """Sum per-blob counters across every digest seen so far.

    Ollama reports ``total``/``completed`` per blob, not cumulatively, so a
    naive per-event percentage resets at every layer. Summing across all
    observed digests removes that artifact. A newly discovered layer grows the
    denominator, so the percentage may legitimately ease downward once — it is
    never forced monotonic, because that would falsify progress. Only
    mathematically invalid output is clamped, to 0-100.
    """
    if not layers:
        return {"bytes_completed": None, "bytes_total": None, "percentage": None}

    completed = sum(max(0, int(layer.get("completed") or 0)) for layer in layers.values())
    totals = [max(0, int(layer["total"])) for layer in layers.values() if layer.get("total")]
    total = sum(totals) if totals else None

    percentage: Optional[int] = None
    if total:
        percentage = min(100, max(0, (100 * completed) // total))

    return {
        "bytes_completed": completed,
        "bytes_total": total,
        "percentage": percentage,
    }


def _state_for_status(status: str) -> Optional[str]:
    """Map an Ollama status string to a state.

    Unknown status strings return None, which keeps the current state — they
    never fail the job, and raw provider text is never surfaced to the user.
    """
    if status == "pulling manifest":
        return MODEL_DOWNLOAD_STARTING
    if status.startswith("pulling ") or status == "downloading":
        return MODEL_DOWNLOAD_DOWNLOADING
    if status in _VERIFYING_STATUSES:
        return MODEL_DOWNLOAD_VERIFYING
    return None


def _apply_event(job: Dict[str, object], event: Dict[str, object],
                 layers: Dict[str, Dict[str, int]]) -> None:
    """Fold one parsed NDJSON status event into the job snapshot."""
    digest = event.get("digest")
    if isinstance(digest, str) and digest:
        # Digests are aggregation keys only — never persisted or returned.
        layer = layers.setdefault(digest, {})
        completed = event.get("completed")
        total = event.get("total")
        if isinstance(completed, int):
            layer["completed"] = completed
        if isinstance(total, int):
            layer["total"] = total

    # Fold the byte counters in first, so a state transition published below
    # carries the freshly reported progress rather than the previous value.
    if _status is job:
        job.update(_aggregate(layers))

    status = event.get("status")
    if isinstance(status, str):
        mapped = _state_for_status(status)
        if mapped is not None and job.get("state") != mapped:
            _publish(job, mapped)


# ---------------------------------------------------------------------------
# Ollama calls
# ---------------------------------------------------------------------------


async def _make_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    """Build the HTTP client. Monkeypatched in tests.

    Redirects are never followed: a redirect could not be allowed to move the
    request to a non-loopback host.
    """
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False)


async def _fetch_installed_models(origin: str) -> List[str]:
    """GET {origin}/api/tags and return the installed model names.

    Deliberately self-contained rather than reusing a private readiness
    helper: `setup_readiness` stays a read-only, single-flight readiness probe
    with no download coupling, and no underscore-private readiness symbol is
    adopted here as a permanent service contract.
    """
    async with await _make_client(_PROBE_TIMEOUT) as client:
        response = await client.get(f"{origin}/api/tags")
        response.raise_for_status()
        payload = response.json()

    models = payload.get("models", []) if isinstance(payload, dict) else []
    return [str(m.get("name") or "") for m in models if isinstance(m, dict)]


def _fail(job: Dict[str, object], category: str, *, retryable: bool,
          state: str = MODEL_DOWNLOAD_FAILED) -> None:
    _publish(job, state, retryable=retryable, error_category=category)


async def _check_configured_model(job: Dict[str, object], origin: str) -> Optional[bool]:
    """Bounded connectivity check plus installed-model pre-check.

    Returns True when the configured model is already installed, False when
    Ollama is reachable but the model is missing, or None when Ollama could
    not be reached within the bounded retry window. Failures inside the window
    publish `waiting_for_ollama` so a just-started service is tolerated.
    """
    for attempt in range(_PULL_START_ATTEMPTS):
        try:
            names = await _fetch_installed_models(origin)
            return settings.OLLAMA_MODEL in names
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.info(
                "local_model_download connectivity attempt=%d category=ollama_unavailable",
                attempt + 1,
            )
            if attempt == _PULL_START_ATTEMPTS - 1:
                return None
            _publish(job, MODEL_DOWNLOAD_WAITING_FOR_OLLAMA)
            await asyncio.sleep(_PULL_RETRY_DELAY_S)
    return None


async def _verify_then_complete(job: Dict[str, object], origin: str) -> None:
    """Confirm the configured model through the installed-model list.

    Completion is never derived from a `success` status event alone.
    """
    _publish(job, MODEL_DOWNLOAD_VERIFYING)
    try:
        names = await _fetch_installed_models(origin)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.info("local_model_download verify category=verification_failed")
        _fail(job, "verification_failed", retryable=True)
        return

    if settings.OLLAMA_MODEL in names:
        _publish(job, MODEL_DOWNLOAD_COMPLETED)
    else:
        _fail(job, "verification_failed", retryable=True)


async def _run_pull(job: Dict[str, object]) -> None:
    """Run one download job. Never lets an exception escape the task."""
    layers: Dict[str, Dict[str, int]] = {}
    try:
        origin = loopback_origin()
        if origin is None:
            _publish(job, MODEL_DOWNLOAD_FAILED, retryable=False,
                     error_category="unsupported_host",
                     message=UNSUPPORTED_HOST_MESSAGE)
            return

        # Pre-check before pulling: an already-installed configured model is
        # verified and completed without a redundant /api/pull request.
        installed = await _check_configured_model(job, origin)
        if installed is None:
            _fail(job, "ollama_unavailable", retryable=True)
            return
        if installed:
            await _verify_then_complete(job, origin)
            return

        # This exact body is the only thing ever sent to Ollama: a trusted
        # model name, explicit streaming, and insecure=False. No document,
        # finding, citation, prompt, or identifier is transmitted.
        body = {"model": settings.OLLAMA_MODEL, "stream": True, "insecure": False}
        saw_event = False

        async with await _make_client(_PULL_TIMEOUT) as client:
            async with client.stream("POST", f"{origin}/api/pull", json=body) as response:
                if response.status_code >= 400:
                    await response.aread()
                    _fail(job, "ollama_error", retryable=True)
                    return

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError):
                        # Individually malformed lines are skipped.
                        continue
                    if not isinstance(event, dict):
                        continue

                    error = event.get("error")
                    if isinstance(error, str) and error:
                        # Ollama reports registry/network failures this way,
                        # sometimes alongside HTTP 200. The text is never
                        # surfaced or logged.
                        _fail(job, "ollama_error", retryable=True)
                        return

                    saw_event = True
                    if event.get("status") == "success":
                        await _verify_then_complete(job, origin)
                        return
                    _apply_event(job, event, layers)

        # The stream ended without any terminal event.
        if saw_event:
            _fail(job, "ollama_disconnected", retryable=True,
                  state=MODEL_DOWNLOAD_DISCONNECTED)
        else:
            _fail(job, "malformed_response", retryable=True)

    except asyncio.CancelledError:
        raise
    except httpx.ReadTimeout:
        _fail(job, "stalled", retryable=True)
    except (httpx.ReadError, httpx.RemoteProtocolError):
        _fail(job, "ollama_disconnected", retryable=True,
              state=MODEL_DOWNLOAD_DISCONNECTED)
    except (httpx.ConnectError, httpx.ConnectTimeout):
        _fail(job, "ollama_unavailable", retryable=True)
    except httpx.HTTPError:
        logger.info("local_model_download http category=ollama_error")
        _fail(job, "ollama_error", retryable=True)
    except Exception:
        logger.info("local_model_download unexpected category=unknown")
        _fail(job, "unknown", retryable=True)
    finally:
        global _task
        # Clear the retained reference, but only if it still belongs to this
        # job — a newer job may already own it.
        if _task is asyncio.current_task():
            _task = None
        # Defensive: never leave the snapshot looking permanently active.
        if _status is job and job.get("state") in MODEL_DOWNLOAD_ACTIVE_STATES:
            _fail(job, "unknown", retryable=True)


async def start_download() -> Optional[Dict[str, object]]:
    """Start one download job. Returns None when a job is already active."""
    global _task, _status

    async with _lock:
        if (
            _status is not None
            and _status.get("state") in MODEL_DOWNLOAD_ACTIVE_STATES
        ):
            # Refuse rather than queue: never start a second concurrent pull.
            return None

        job = _new_status(MODEL_DOWNLOAD_STARTING)
        _status = job
        # Retain a strong reference so the task is not garbage-collected
        # mid-flight; `_run_pull` clears it when it finishes.
        _task = asyncio.create_task(_run_pull(job))
        logger.info("local_model_download state=%s category=None", MODEL_DOWNLOAD_STARTING)
        return dict(job)
