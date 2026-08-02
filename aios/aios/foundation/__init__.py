"""Foundation layer: no dependencies on any other aios package."""

from .clock import SYSTEM_CLOCK, Clock, ManualClock
from .config import Config
from .errors import AiosError, Remedy, classify
from .ids import new_id, short
from .logging import configure, get_logger, log_context
from .redaction import redact, redact_text

__all__ = [
    "SYSTEM_CLOCK",
    "AiosError",
    "Clock",
    "Config",
    "ManualClock",
    "Remedy",
    "classify",
    "configure",
    "get_logger",
    "log_context",
    "new_id",
    "redact",
    "redact_text",
    "short",
]
