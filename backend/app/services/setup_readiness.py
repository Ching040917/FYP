"""Setup readiness (Build A) — read-only, presentation-safe component probe.

`GET /api/readiness` aggregates independent component states so ordinary
users can see whether ACA is ready without terminals, ports, env vars, or
process management.

Hard rules enforced by this module and its tests:
- Read-only: no directory creation, file writes, DB writes, migrations,
  process spawns, LibreOffice execution, model loads/pulls, or downloads.
- Presentation-safe payload: never contains Ollama host/port, executable
  locations, storage paths, environment values, API keys, provider
  responses, stack traces, or document data. The configured local model
  name is non-secret configuration and appears only inside a safe detail.
- Causal dependencies: an unreachable local AI service makes the model
  state `unknown` — never a second independent failure.
- Optional failures never block; only a required post-startup database
  mismatch produces `blocked`.
- Honest preview wording: availability "appears available" until a real
  audit conversion confirms it.

Startup limitation (stated honestly): this endpoint exists only when the
Backend started successfully against a compatible schema. A migration
mismatch severe enough to fail startup prevents the endpoint itself from
being served; the database probe here confirms continued head agreement
after start.
"""
import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, List, Optional, Tuple

import httpx
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from typing import Literal

from app.config import settings
from app.services.docx_pdf_converter import find_soffice
from app.services import preview_storage

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

ReadinessState = Literal[
    "ready", "unavailable", "optional", "misconfigured", "unknown"
]
OverallState = Literal["ready", "degraded", "blocked"]

COMPONENT_IDS = (
    "core_backend",
    "database",
    "docx_audit",
    "libreoffice",
    "rendered_preview",
    "ollama",
    "local_model",
    "cloud_ai",
)

REASON_APPLICATION_MIGRATION = "migration_head"

_OLLAMA_PROBE_TIMEOUT_S = 3.0
_CACHE_TTL_S = 30.0


class ReadinessComponent(BaseModel):
    """One component row. Strict: unknown internal fields are rejected."""

    model_config = ConfigDict(extra="forbid")

    id: str
    state: ReadinessState
    required: bool
    message: str
    detail: Optional[str] = None


class ReadinessResponse(BaseModel):
    """Full presentation-safe payload. Strict: no unknown fields."""

    model_config = ConfigDict(extra="forbid")

    overall: OverallState
    components: List[ReadinessComponent]
    checked_at: str


# ---------------------------------------------------------------------------
# Injected probes — tests replace these callables; production uses defaults.
# ---------------------------------------------------------------------------


def _default_expected_head() -> Optional[str]:
    """Derive the code-side Alembic head through ScriptDirectory.

    Preferred over a hand-maintained constant: drift between this value and
    the real single script head is impossible while versions/ is intact.
    """
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        backend_dir = Path(__file__).resolve().parents[2]
        cfg = Config()
        cfg.set_main_option("script_location", str(backend_dir / "alembic"))
        return ScriptDirectory.from_config(cfg).get_current_head()
    except Exception:
        return None


def _default_db_version_nums() -> List[str]:
    """Read-only SELECT of the alembic stamp. Raises when absent/unreadable."""
    from app.database import SessionLocal

    with SessionLocal() as db:
        rows = db.execute(text("SELECT version_num FROM alembic_version")).fetchall()
        return [r[0] for r in rows]


async def _default_fetch_ollama_models() -> List[str]:
    """GET {host}/api/tags with a bounded timeout; returns model names.

    Read-only: /api/tags lists installed models and never loads one.
    Raises on unreachable/timeout/non-2xx — callers translate to safe states.
    """
    async with httpx.AsyncClient(timeout=_OLLAMA_PROBE_TIMEOUT_S) as client:
        resp = await client.get(f"{settings.OLLAMA_HOST}/api/tags")
        resp.raise_for_status()
        models = resp.json().get("models", [])
        return [str(m.get("name") or "") for m in models if isinstance(m, dict)]


@dataclass
class ReadinessProbes:
    """Injected probe surface — swap any field in tests.

    Config booleans are injected too so "disabled by configuration" paths
    are testable without mutating global settings.
    """

    expected_head: Callable[[], Optional[str]] = _default_expected_head
    db_version_nums: Callable[[], List[str]] = _default_db_version_nums
    fetch_ollama_models: Callable[[], Awaitable[List[str]]] = _default_fetch_ollama_models
    find_soffice: Callable[[], Optional[str]] = field(default=find_soffice)
    storage_root_exists: Callable[[], bool] = lambda: preview_storage.storage_root().exists()
    local_ai_enabled: bool = field(default_factory=lambda: settings.LOCAL_AI_ENABLED)
    cloud_ai_configured: bool = field(default_factory=lambda: bool(settings.GEMINI_API_KEY))
    model_name: str = field(default_factory=lambda: settings.OLLAMA_MODEL)


# ---------------------------------------------------------------------------
# Pure computation
# ---------------------------------------------------------------------------


def _component(cid: str, state: ReadinessState, required: bool,
               message: str, detail: Optional[str] = None) -> dict:
    out = {"id": cid, "state": state, "required": required, "message": message}
    if detail is not None:
        out["detail"] = detail
    return out


async def compute_readiness(probes: ReadinessProbes) -> dict:
    """Build the presentation-safe readiness payload.

    Every probe is independently failure-isolated: an optional probe error
    becomes `unknown`, never an exception, never another component's state.
    """
    components: List[dict] = []
    ollama_reachable: Optional[bool] = None

    # -- core backend -------------------------------------------------------
    # Serving this response proves the process is up.
    components.append(_component(
        "core_backend", "ready", True,
        "Ready to audit documents",
    ))

    # -- database schema ----------------------------------------------------
    try:
        expected = probes.expected_head()
        actual_list = probes.db_version_nums()
        if expected is not None and actual_list == [expected]:
            components.append(_component(
                "database", "ready", True,
                "The database is up to date.",
            ))
        else:
            # Missing stamp, drifted head, or multiple heads — all mean the
            # active schema does not match this application build.
            components.append(_component(
                "database", "misconfigured", True,
                "The database requires an application update. Follow the "
                "setup instructions before continuing.",
                detail=None,
            ))
    except Exception:
        components.append(_component(
            "database", "misconfigured", True,
            "The database requires an application update. Follow the "
            "setup instructions before continuing.",
            detail=None,
        ))

    # -- deterministic DOCX audit -------------------------------------------
    components.append(_component(
        "docx_audit", "ready", True,
        "Deterministic document checks are built into the application.",
    ))

    # -- LibreOffice ---------------------------------------------------------
    lo_ready = False
    try:
        found = probes.find_soffice()
        if found:
            lo_ready = True
            components.append(_component(
                "libreoffice", "ready", False,
                "Rendered-page conversion support was found.",
            ))
        else:
            components.append(_component(
                "libreoffice", "unavailable", False,
                "Rendered-page preview is unavailable. Extracted-text "
                "evidence remains available.",
            ))
    except Exception:
        components.append(_component(
            "libreoffice", "unknown", False,
            "Rendered-page conversion support could not be checked.",
        ))

    # -- rendered preview ----------------------------------------------------
    # Provisional by contract: never claims write access or a proven
    # conversion before a real Audit runs.
    if lo_ready:
        try:
            root_configured = probes.storage_root_exists() or True  # default root derivable
            del root_configured
            components.append(_component(
                "rendered_preview", "ready", False,
                "Rendered-page preview appears available. Availability is "
                "confirmed during an audit.",
            ))
        except Exception:
            components.append(_component(
                "rendered_preview", "unknown", False,
                "Rendered-page preview availability will be confirmed during an audit.",
            ))
    else:
        components.append(_component(
            "rendered_preview", "unavailable", False,
            "Rendered-page preview is unavailable. Extracted-text evidence "
            "remains available.",
        ))

    # -- Ollama + configured local model (causal pair) -----------------------
    if probes.local_ai_enabled:
        names: Optional[List[str]] = None
        reachable = False
        try:
            names = await probes.fetch_ollama_models()
            reachable = True
        except Exception:
            reachable = False

        if reachable:
            ollama_reachable = True
            components.append(_component(
                "ollama", "ready", False,
                "Local AI citation review is available.",
            ))
            wanted = probes.model_name
            present = wanted in names
            if present:
                components.append(_component(
                    "local_model", "ready", False,
                    "The configured local AI model is installed.",
                    detail=f"Configured model: {wanted}",
                ))
            else:
                components.append(_component(
                    "local_model", "unavailable", False,
                    "The configured local AI model is not installed.",
                    detail=f"Configured model: {wanted}",
                ))
        else:
            ollama_reachable = False
            components.append(_component(
                "ollama", "unavailable", False,
                "Local AI citation review is unavailable. Deterministic "
                "checks remain available.",
            ))
            components.append(_component(
                "local_model", "unknown", False,
                "Model availability could not be checked because the local "
                "AI service is unavailable.",
            ))
    else:
        components.append(_component(
            "ollama", "optional", False,
            "Local AI citation review is turned off in settings.",
        ))
        components.append(_component(
            "local_model", "optional", False,
            "Local AI review is turned off in settings.",
        ))

    # -- cloud AI -------------------------------------------------------------
    cloud_configured = probes.cloud_ai_configured
    if cloud_configured:
        # No paid generation request in readiness — configured state only.
        components.append(_component(
            "cloud_ai", "ready", False,
            "Cloud AI review is configured.",
        ))
    else:
        components.append(_component(
            "cloud_ai", "optional", False,
            "Cloud AI review is optional and is not configured.",
        ))

    overall = _overall(components)
    return {
        "overall": overall,
        "components": components,
        "checked_at": datetime.utcnow().isoformat(),
    }


def _overall(components: List[dict]) -> OverallState:
    """blocked iff a required component is not ready; degraded iff any
    optional component is unavailable; otherwise ready."""
    for c in components:
        if c["required"] and c["state"] != "ready":
            return "blocked"
    for c in components:
        if not c["required"] and c["state"] == "unavailable":
            return "degraded"
    return "ready"


# ---------------------------------------------------------------------------
# Cached endpoint entry point — single-flight, 30s TTL
# ---------------------------------------------------------------------------

_cache_lock = asyncio.Lock()
_cached_payload: Optional[dict] = None
_cached_at_monotonic: float = 0.0

_default_probes = ReadinessProbes()


async def get_readiness(force_refresh: bool = False) -> dict:
    """Return the cached payload, recomputing when stale or forced.

    Single-flight: concurrent cache misses share one computation (one
    Ollama probe). The cache is replaced only after a successful compute;
    it never stores exceptions or raw provider data.
    """
    global _cached_payload, _cached_at_monotonic

    async with _cache_lock:
        now = time.monotonic()
        if (
            not force_refresh
            and _cached_payload is not None
            and (now - _cached_at_monotonic) < _CACHE_TTL_S
        ):
            return _cached_payload

        payload = await compute_readiness(_default_probes)
        _cached_payload = payload
        _cached_at_monotonic = time.monotonic()
        return payload


def reset_cache() -> None:
    """Test helper — clears the cached payload."""
    global _cached_payload, _cached_at_monotonic
    _cached_payload = None
    _cached_at_monotonic = 0.0


