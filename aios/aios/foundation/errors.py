"""Error taxonomy.

Recovery is only as good as the classification that feeds it, so every failure
in the system is expressed as an :class:`AiosError` carrying three machine
readable facts:

``code``       stable string for logs, metrics and policy rules
``retryable``  whether the *same* action could plausibly succeed again
``remedy``     the recovery family that should be attempted first

Third-party exceptions are funnelled through :func:`classify` which maps them
onto this taxonomy, so the kernel never has to pattern-match on stringly-typed
exception messages.
"""

from __future__ import annotations

import asyncio
import errno
import json
import socket
import subprocess
from enum import Enum
from typing import Any


class Remedy(str, Enum):
    """The recovery family a failure suggests."""

    RETRY = "retry"  # transient; try the same thing again after backoff
    REPAIR_INPUT = "repair_input"  # arguments were malformed; fix and retry
    SUBSTITUTE = "substitute"  # this tool cannot do it; try an alternative
    DECOMPOSE = "decompose"  # step too large/ambiguous; re-plan it smaller
    ESCALATE = "escalate"  # needs a human decision
    ABORT = "abort"  # unrecoverable; fail the branch


class AiosError(Exception):
    """Base class for every error the OS raises deliberately."""

    code: str = "aios_error"
    retryable: bool = False
    remedy: Remedy = Remedy.ABORT

    def __init__(
        self,
        message: str,
        *,
        context: dict[str, Any] | None = None,
        cause: BaseException | None = None,
        retryable: bool | None = None,
        remedy: Remedy | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.context = context or {}
        self.cause = cause
        if retryable is not None:
            self.retryable = retryable
        if remedy is not None:
            self.remedy = remedy

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "remedy": self.remedy.value,
            "context": self.context,
            "cause": repr(self.cause) if self.cause else None,
        }

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.context:
            return f"{self.message} ({json.dumps(self.context, default=str)[:200]})"
        return self.message


# --------------------------------------------------------------------------
# Configuration / programming errors - never retried.
# --------------------------------------------------------------------------


class ConfigError(AiosError):
    code = "config_error"


class RegistryError(AiosError):
    code = "registry_error"


class ToolNotFound(RegistryError):
    code = "tool_not_found"
    remedy = Remedy.SUBSTITUTE


# --------------------------------------------------------------------------
# Tool execution.
# --------------------------------------------------------------------------


class ToolError(AiosError):
    code = "tool_error"


class InvalidArguments(ToolError):
    """Schema validation or semantic argument failure - the LLM can fix this."""

    code = "invalid_arguments"
    remedy = Remedy.REPAIR_INPUT


class ToolExecutionError(ToolError):
    """The tool ran and failed for a reason the tool understands."""

    code = "tool_execution_error"


class ToolTimeout(ToolError):
    code = "tool_timeout"
    retryable = True
    remedy = Remedy.RETRY


class TransientError(AiosError):
    """Network blips, locked files, rate limits - the classic retry case."""

    code = "transient_error"
    retryable = True
    remedy = Remedy.RETRY


class RateLimited(TransientError):
    code = "rate_limited"

    def __init__(self, message: str, *, retry_after: float | None = None, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.retry_after = retry_after


# --------------------------------------------------------------------------
# Security / policy.
# --------------------------------------------------------------------------


class SecurityError(AiosError):
    code = "security_error"
    remedy = Remedy.ABORT


class PermissionDenied(SecurityError):
    code = "permission_denied"
    remedy = Remedy.ESCALATE


class SandboxViolation(SecurityError):
    """An attempt to touch something outside the granted workspace."""

    code = "sandbox_violation"
    remedy = Remedy.ABORT


class ApprovalRequired(SecurityError):
    code = "approval_required"
    remedy = Remedy.ESCALATE


class ApprovalDenied(SecurityError):
    code = "approval_denied"
    remedy = Remedy.ABORT


# --------------------------------------------------------------------------
# Model providers.
# --------------------------------------------------------------------------


class ProviderError(AiosError):
    code = "provider_error"


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"
    retryable = True
    remedy = Remedy.SUBSTITUTE


class ContextOverflow(ProviderError):
    code = "context_overflow"
    remedy = Remedy.DECOMPOSE


class StructuredOutputError(ProviderError):
    code = "structured_output_error"
    remedy = Remedy.REPAIR_INPUT


# --------------------------------------------------------------------------
# Planning / verification / budgets.
# --------------------------------------------------------------------------


class PlanError(AiosError):
    code = "plan_error"


class CyclicPlan(PlanError):
    code = "cyclic_plan"


class VerificationFailed(AiosError):
    """The step reported success but its output did not satisfy its contract."""

    code = "verification_failed"
    remedy = Remedy.RETRY

    def __init__(self, message: str, *, checks: list[dict[str, Any]] | None = None, **kw: Any):
        super().__init__(message, **kw)
        self.checks = checks or []


class BudgetExceeded(AiosError):
    code = "budget_exceeded"
    remedy = Remedy.ABORT


class Cancelled(AiosError):
    code = "cancelled"
    remedy = Remedy.ABORT


_ERRNO_TRANSIENT = {
    errno.EAGAIN,
    errno.EBUSY,
    errno.EINTR,
    errno.ETIMEDOUT,
    errno.ECONNRESET,
    errno.ECONNREFUSED,
    errno.EHOSTUNREACH,
    errno.ENETUNREACH,
    errno.EPIPE,
}


def classify(exc: BaseException) -> AiosError:
    """Map an arbitrary exception onto the taxonomy.

    Everything the kernel catches goes through here exactly once, which means
    recovery logic only ever reasons about :class:`AiosError`.
    """
    if isinstance(exc, AiosError):
        return exc
    if isinstance(exc, asyncio.CancelledError):
        return Cancelled("operation cancelled", cause=exc)
    if isinstance(exc, TimeoutError | asyncio.TimeoutError):
        return ToolTimeout("operation timed out", cause=exc)
    if isinstance(exc, subprocess.TimeoutExpired):
        return ToolTimeout(f"command timed out after {exc.timeout}s", cause=exc)
    if isinstance(exc, PermissionError):
        return PermissionDenied(str(exc), cause=exc)
    if isinstance(exc, FileNotFoundError):
        return ToolExecutionError(str(exc), cause=exc, remedy=Remedy.REPAIR_INPUT)
    if isinstance(exc, IsADirectoryError | NotADirectoryError):
        return InvalidArguments(str(exc), cause=exc)
    if isinstance(exc, OSError):
        if exc.errno in _ERRNO_TRANSIENT:
            return TransientError(str(exc), cause=exc)
        return ToolExecutionError(str(exc), cause=exc)
    if isinstance(exc, socket.timeout):
        return TransientError(str(exc), cause=exc)
    if isinstance(exc, json.JSONDecodeError):
        return StructuredOutputError(f"invalid JSON: {exc}", cause=exc)
    if isinstance(exc, ValueError | TypeError | KeyError):
        return InvalidArguments(f"{type(exc).__name__}: {exc}", cause=exc)
    if isinstance(exc, MemoryError | RecursionError):
        return AiosError(f"{type(exc).__name__}: {exc}", cause=exc)
    return ToolExecutionError(f"{type(exc).__name__}: {exc}", cause=exc)
