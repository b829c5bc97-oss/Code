"""Structured logging.

Human-readable on a TTY, newline-delimited JSON everywhere else, and always
redacted. A contextvar carries the current run/step so every line emitted deep
inside a tool is automatically correlated without threading a logger around.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from .redaction import redact

# Default is None, not {}: a mutable default on a ContextVar is shared across
# every context, so one accidental in-place update would leak fields into
# unrelated runs.
_context: ContextVar[dict[str, Any] | None] = ContextVar("aios_log_context", default=None)

_LEVEL_COLORS = {
    "DEBUG": "\x1b[38;5;244m",
    "INFO": "\x1b[38;5;39m",
    "WARNING": "\x1b[38;5;214m",
    "ERROR": "\x1b[38;5;203m",
    "CRITICAL": "\x1b[48;5;203;38;5;231m",
}
_RESET = "\x1b[0m"
_DIM = "\x1b[38;5;244m"

_RESERVED = frozenset(
    set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime", "taskName"}
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        payload.update(_context.get() or {})
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(redact(payload), default=str, ensure_ascii=False)


class ConsoleFormatter(logging.Formatter):
    def __init__(self, color: bool = True) -> None:
        super().__init__()
        self.color = color

    def format(self, record: logging.LogRecord) -> str:
        level = record.levelname
        ts = time.strftime("%H:%M:%S", time.localtime(record.created))
        ctx = _context.get() or {}
        tag = ctx.get("step") or ctx.get("run") or record.name.replace("aios.", "")
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _RESERVED and not k.startswith("_")
        }
        suffix = ""
        if extras:
            rendered = redact(extras)
            suffix = " " + " ".join(f"{k}={_compact(v)}" for k, v in rendered.items())
        msg = redact(record.getMessage())
        if self.color:
            c = _LEVEL_COLORS.get(level, "")
            line = (
                f"{_DIM}{ts}{_RESET} {c}{level[:4]:<4}{_RESET} "
                f"{_DIM}{tag}{_RESET} {msg}{_DIM}{suffix}{_RESET}"
            )
        else:
            line = f"{ts} {level[:4]:<4} {tag} {msg}{suffix}"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def _compact(value: Any, limit: int = 80) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    text = text.replace("\n", "\\n")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def configure(level: str = "INFO", *, json_output: bool | None = None, stream: Any = None) -> None:
    """Install the root handler. Idempotent - safe to call from tests."""
    stream = stream or sys.stderr
    if json_output is None:
        json_output = not (hasattr(stream, "isatty") and stream.isatty())
    handler = logging.StreamHandler(stream)
    handler.setFormatter(
        JsonFormatter()
        if json_output
        else ConsoleFormatter(color=os.environ.get("NO_COLOR") is None)
    )
    root = logging.getLogger("aios")
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.propagate = False


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name if name.startswith("aios") else f"aios.{name}")


@contextmanager
def log_context(**fields: Any):
    """Attach fields to every log line emitted inside the block."""
    current = _context.get() or {}
    token = _context.set({**current, **{k: v for k, v in fields.items() if v is not None}})
    try:
        yield
    finally:
        _context.reset(token)


def current_context() -> dict[str, Any]:
    return dict(_context.get() or {})
