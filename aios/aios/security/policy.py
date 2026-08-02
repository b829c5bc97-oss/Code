"""The policy engine.

Sits between "the planner wants to do X" and "X happens". Every tool
invocation is evaluated exactly once, producing one of three verdicts:

``ALLOW``    proceed silently
``CONFIRM``  proceed only after an approval decision
``DENY``     never proceed, regardless of approval

Rules are ordered and pure functions of the request plus the session grant,
which makes the whole policy layer trivially testable and auditable: the
verdict record in the ledger names the rule that produced it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from urllib.parse import urlparse

from ..foundation.config import SecurityConfig
from ..foundation.logging import get_logger
from . import capabilities as caps
from .capabilities import CapabilitySet, RiskLevel
from .sandbox import PathJail, analyse_command

log = get_logger("security.policy")


class Verdict(str, Enum):
    ALLOW = "allow"
    CONFIRM = "confirm"
    DENY = "deny"


@dataclass(slots=True)
class ActionRequest:
    """A normalized description of a side effect about to happen."""

    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)
    capabilities: frozenset[str] = frozenset()
    risk: RiskLevel = RiskLevel.SAFE
    reversible: bool = True
    summary: str = ""
    paths: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    command: str = ""
    run_id: str | None = None
    step_id: str | None = None

    def describe(self) -> str:
        if self.summary:
            return self.summary
        target = self.command or ", ".join(self.paths + self.urls)
        return f"{self.tool}({target})" if target else self.tool


@dataclass(slots=True)
class Decision:
    verdict: Verdict
    rule: str
    reason: str
    risk: RiskLevel = RiskLevel.SAFE

    @property
    def allowed(self) -> bool:
        return self.verdict is Verdict.ALLOW

    @property
    def needs_approval(self) -> bool:
        return self.verdict is Verdict.CONFIRM

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict.value,
            "rule": self.rule,
            "reason": self.reason,
            "risk": self.risk.name,
        }


Rule = Callable[["PolicyEngine", ActionRequest], Decision | None]

# Risk floor per security mode: anything at or above this needs confirmation.
_CONFIRM_THRESHOLD = {
    "strict": RiskLevel.LOW,
    "standard": RiskLevel.HIGH,
    "permissive": RiskLevel.CRITICAL,
}


class PolicyEngine:
    def __init__(
        self,
        config: SecurityConfig,
        grant: CapabilitySet,
        jail: PathJail,
        *,
        extra_rules: list[Rule] | None = None,
    ) -> None:
        self.config = config
        self.grant = grant
        self.jail = jail
        self.rules: list[Rule] = [*DEFAULT_RULES, *(extra_rules or [])]

    def evaluate(self, request: ActionRequest) -> Decision:
        """First rule to return a verdict wins; DENY from any rule is final."""
        pending: Decision | None = None
        for rule in self.rules:
            decision = rule(self, request)
            if decision is None:
                continue
            if decision.verdict is Verdict.DENY:
                return decision
            if decision.verdict is Verdict.CONFIRM and pending is None:
                pending = decision
        if pending is not None:
            return pending
        return Decision(Verdict.ALLOW, "default", "no rule required a decision", request.risk)

    # helpers used by rules -------------------------------------------------
    def confirm_threshold(self) -> RiskLevel:
        return _CONFIRM_THRESHOLD.get(self.config.mode, RiskLevel.HIGH)


# --------------------------------------------------------------------------
# Built-in rules, most restrictive first.
# --------------------------------------------------------------------------


def rule_capability_grant(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    missing = engine.grant.missing(req.capabilities)
    if missing:
        return Decision(
            Verdict.DENY,
            "capability_grant",
            f"session lacks capability: {', '.join(sorted(missing))}",
            req.risk,
        )
    return None


def rule_sandbox(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    if caps.FS_OUTSIDE_WORKSPACE in req.capabilities:
        return None
    for path in req.paths:
        if not engine.jail.contains(path):
            return Decision(
                Verdict.DENY,
                "sandbox",
                f"path is outside the workspace: {path}",
                RiskLevel.HIGH,
            )
    return None


def rule_network(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    if not req.urls:
        return None
    if not engine.config.allow_network:
        return Decision(Verdict.DENY, "network_disabled", "network access is disabled", req.risk)
    allowed = engine.config.allowed_hosts
    for url in req.urls:
        host = (urlparse(url).hostname or "").lower()
        if not host:
            continue
        if any(_host_matches(host, blocked) for blocked in engine.config.blocked_hosts):
            return Decision(Verdict.DENY, "blocked_host", f"host is blocked: {host}", RiskLevel.HIGH)
        if allowed and not any(_host_matches(host, entry) for entry in allowed):
            return Decision(
                Verdict.CONFIRM,
                "host_not_allowlisted",
                f"host {host} is not in security.allowed_hosts",
                max(req.risk, RiskLevel.MODERATE),
            )
    return None


def rule_shell(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    if not req.command:
        return None
    if not engine.config.allow_shell:
        return Decision(Verdict.DENY, "shell_disabled", "shell execution is disabled", req.risk)
    risk = analyse_command(req.command, engine.config.shell_denylist)
    if not risk.destructive:
        return None
    hard_deny = {"recursive_root_delete", "disk_write", "fork_bomb", "perm_root"}
    hit = set(risk.reasons) & hard_deny
    if hit:
        return Decision(
            Verdict.DENY,
            "destructive_command",
            f"command matches a hard-denied pattern: {', '.join(sorted(hit))}",
            RiskLevel.CRITICAL,
        )
    return Decision(
        Verdict.CONFIRM,
        "risky_command",
        f"command is potentially destructive: {', '.join(risk.reasons)}",
        RiskLevel.HIGH,
    )


def rule_irreversible(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    if req.reversible:
        return None
    if engine.config.mode == "permissive" and req.risk < RiskLevel.HIGH:
        return None
    return Decision(
        Verdict.CONFIRM,
        "irreversible",
        "action cannot be undone",
        max(req.risk, RiskLevel.HIGH),
    )


def rule_outward_facing(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    """Sending, publishing and spending always involve a person, in every mode."""
    gated = {caps.COMM_SEND, caps.PUBLISH, caps.FINANCIAL, caps.CREDENTIALS, caps.SYSTEM_CONFIG}
    hit = gated & set(req.capabilities)
    if not hit:
        return None
    return Decision(
        Verdict.CONFIRM,
        "outward_facing",
        f"action reaches beyond this machine ({', '.join(sorted(hit))})",
        max(req.risk, RiskLevel.HIGH),
    )


def rule_risk_threshold(engine: PolicyEngine, req: ActionRequest) -> Decision | None:
    if req.risk >= engine.confirm_threshold():
        return Decision(
            Verdict.CONFIRM,
            "risk_threshold",
            f"risk {req.risk.name} meets the {engine.config.mode} confirmation threshold",
            req.risk,
        )
    return None


DEFAULT_RULES: list[Rule] = [
    rule_capability_grant,
    rule_sandbox,
    rule_network,
    rule_shell,
    rule_outward_facing,
    rule_irreversible,
    rule_risk_threshold,
]


def _host_matches(host: str, pattern: str) -> bool:
    pattern = pattern.strip().lower().lstrip("*.")
    if not pattern:
        return False
    return host == pattern or host.endswith("." + pattern)
