"""Secret detection and scrubbing.

The OS writes an append-only ledger of everything it does, streams events to
the UI and persists memories across sessions. Any of those paths can leak a
credential that happened to be sitting in a tool result, so *every* record that
leaves the process is scrubbed here first.

Design notes:
- Patterns are ordered most-specific first; the generic assignment pattern is
  the catch-all and is deliberately conservative to limit false positives.
- Redaction preserves a short fingerprint (``sk-…a1b2``) so operators can still
  correlate "the same secret" across logs without recovering the value.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from typing import Any

# (name, compiled pattern, group index holding the secret)
_PATTERNS: list[tuple[str, re.Pattern[str], int]] = [
    ("anthropic_key", re.compile(r"\b(sk-ant-[A-Za-z0-9\-_]{20,})"), 1),
    ("openai_key", re.compile(r"\b(sk-(?:proj-)?[A-Za-z0-9]{20,})"), 1),
    ("github_token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,})"), 1),
    ("slack_token", re.compile(r"\b(xox[abprs]-[A-Za-z0-9\-]{10,})"), 1),
    ("google_key", re.compile(r"\b(AIza[A-Za-z0-9\-_]{30,})"), 1),
    ("aws_access_key", re.compile(r"\b((?:AKIA|ASIA)[A-Z0-9]{16})\b"), 1),
    ("jwt", re.compile(r"\b(eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,})"), 1),
    ("private_key", re.compile(r"(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----)"), 1),
    ("bearer", re.compile(r"(?i)\b(?:authorization\s*[:=]\s*)?bearer\s+([A-Za-z0-9\-._~+/]{16,}=*)"), 1),
    ("url_credentials", re.compile(r"://[^/\s:@]+:([^/\s@]{3,})@"), 1),
    (
        "assignment",
        re.compile(
            r"(?i)\b(?:[A-Z0-9_]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|"
            r"credential|private[_-]?key)[A-Z0-9_]*)\s*[:=]\s*[\"']?([^\s\"',;]{8,})"
        ),
        1,
    ),
]

# Keys whose *values* are always masked regardless of shape.
_SENSITIVE_KEYS = re.compile(
    r"(?i)(secret|password|passwd|token|api[_-]?key|access[_-]?key|auth|credential|"
    r"private[_-]?key|session[_-]?id|cookie)"
)

_PLACEHOLDER_SAFE = re.compile(r"(?i)^(\$\{?[a-z_][a-z0-9_]*\}?|<[^>]+>|\*+|x{3,}|none|null|)$")


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:4]


def _mask(name: str, value: str) -> str:
    head = value[:3] if len(value) > 12 else ""
    return f"[REDACTED:{name}:{head}…{fingerprint(value)}]"


def redact_text(text: str) -> str:
    """Replace every credential-looking substring with a stable placeholder."""
    if not text:
        return text
    out = text
    for name, pattern, group in _PATTERNS:
        def _sub(m: re.Match[str], _n: str = name, _g: int = group) -> str:
            secret = m.group(_g)
            if not secret or _PLACEHOLDER_SAFE.match(secret):
                return m.group(0)
            return m.group(0).replace(secret, _mask(_n, secret))

        out = pattern.sub(_sub, out)
    return out


def redact(value: Any, *, _depth: int = 0) -> Any:
    """Recursively scrub a JSON-like structure.

    Depth-limited so a pathological nested payload cannot stall the logger.
    """
    if _depth > 12:
        return "[REDACTED:depth-limit]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and _SENSITIVE_KEYS.search(k):
                if (isinstance(v, str) and _PLACEHOLDER_SAFE.match(v)) or v is None or isinstance(v, bool):
                    out[k] = v
                else:
                    out[k] = _mask("field", str(v))
            else:
                out[k] = redact(v, _depth=_depth + 1)
        return out
    if isinstance(value, list | tuple):
        return type(value)(redact(v, _depth=_depth + 1) for v in value)
    if isinstance(value, set):
        return {redact(v, _depth=_depth + 1) for v in value}
    return value


def contains_secret(value: Any) -> bool:
    """True when redaction would change the value - used by memory writes."""
    return redact(value) != value


def scrub_env(env: dict[str, str], allow: Iterable[str] = ()) -> dict[str, str]:
    """Strip credential-ish variables out of an environment about to be handed
    to a subprocess. Explicitly allowed names pass through."""
    allowed = set(allow)
    return {k: v for k, v in env.items() if k in allowed or not _SENSITIVE_KEYS.search(k)}
