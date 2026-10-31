"""Loopback origin validator.

Enforces strict loopback HTTP origin requirements for local services (e.g. Ollama).
Only unauthenticated http:// schemes targeting 127.0.0.1, localhost, or [::1]
without userinfo, path beyond '/', query, or fragment are accepted.
"""

from typing import Optional
from urllib.parse import urlsplit

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def loopback_origin(raw_url: Optional[str]) -> Optional[str]:
    """Return the validated loopback origin, or None when refused.

    Pure function: never reads external settings or environment.
    Accepts only an http origin whose hostname is a loopback address
    (127.0.0.1, localhost, ::1), with no username, password, query,
    fragment, or path beyond an optional trailing slash, and a syntactically
    valid port (1-65535).
    """
    if not raw_url:
        return None
    raw = raw_url.strip()
    if not raw:
        return None
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None

    if parts.scheme != "http":
        return None
    if parts.username or parts.password:
        return None
    if parts.query or parts.fragment:
        return None
    if parts.path not in ("", "/"):
        return None

    host = (parts.hostname or "").lower()
    if host not in _LOOPBACK_HOSTS:
        return None

    try:
        port = parts.port
    except ValueError:
        # Malformed or out-of-range port.
        return None
    if port is None:
        port = 80
    elif not (1 <= port <= 65535):
        return None

    # IPv6 literals must be bracketed to form a valid authority.
    authority = f"[{host}]" if ":" in host else host
    return f"http://{authority}:{port}"
