"""Capability model.

Tools do not get ambient authority. Each one declares the capabilities it
needs, a session is granted a capability set, and the policy engine refuses any
invocation whose declared needs exceed the grant. This is what makes it safe to
load a third-party plugin: a plugin that never declared ``shell.exec`` can
never spawn a process, whatever its code tries to do at the tool boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class Capability(str):
    """Dotted capability name. Grants match on prefix: ``fs`` implies ``fs.write``."""

    __slots__ = ()


# -- filesystem
FS_READ = Capability("fs.read")
FS_WRITE = Capability("fs.write")
FS_DELETE = Capability("fs.delete")
FS_OUTSIDE_WORKSPACE = Capability("fs.outside_workspace")

# -- process / system
SHELL_EXEC = Capability("shell.exec")
PROCESS_SPAWN = Capability("process.spawn")
SYSTEM_CONFIG = Capability("system.config")
PACKAGE_INSTALL = Capability("system.install")

# -- network
NET_READ = Capability("net.read")
NET_WRITE = Capability("net.write")
BROWSER_CONTROL = Capability("net.browser")

# -- outward-facing side effects (the ones users care most about)
COMM_SEND = Capability("comm.send")  # email, chat, SMS
PUBLISH = Capability("publish")  # deploy, post, push to a public place
FINANCIAL = Capability("financial")  # payments, purchases
CREDENTIALS = Capability("credentials")  # read or write secrets

# -- model
MODEL_CALL = Capability("model.call")

ALL_CAPABILITIES: tuple[Capability, ...] = (
    FS_READ, FS_WRITE, FS_DELETE, FS_OUTSIDE_WORKSPACE,
    SHELL_EXEC, PROCESS_SPAWN, SYSTEM_CONFIG, PACKAGE_INSTALL,
    NET_READ, NET_WRITE, BROWSER_CONTROL,
    COMM_SEND, PUBLISH, FINANCIAL, CREDENTIALS, MODEL_CALL,
)


class RiskLevel(IntEnum):
    """How much damage a *successful* invocation could do."""

    SAFE = 0  # pure reads, no side effects
    LOW = 1  # writes inside the workspace
    MODERATE = 2  # process spawn, network writes, package installs
    HIGH = 3  # deletes, deploys, outbound comms, system config
    CRITICAL = 4  # irreversible, public or financial

    @classmethod
    def parse(cls, value: str | int | RiskLevel) -> RiskLevel:
        if isinstance(value, RiskLevel):
            return value
        if isinstance(value, int):
            return cls(max(0, min(4, value)))
        return cls[str(value).upper()]


@dataclass(frozen=True, slots=True)
class CapabilitySet:
    """An immutable grant. ``granted`` entries match by dotted prefix."""

    granted: frozenset[str] = field(default_factory=frozenset)

    @classmethod
    def of(cls, *names: str) -> CapabilitySet:
        return cls(frozenset(names))

    @classmethod
    def all(cls) -> CapabilitySet:
        return cls(frozenset(ALL_CAPABILITIES))

    @classmethod
    def readonly(cls) -> CapabilitySet:
        return cls(frozenset({FS_READ, NET_READ, MODEL_CALL}))

    @classmethod
    def standard(cls) -> CapabilitySet:
        """The default developer-workstation grant.

        Everything a build/research task needs; nothing that reaches the outside
        world irreversibly. Outward-facing capabilities stay ungranted until the
        user asks for them explicitly.
        """
        return cls(
            frozenset(
                {
                    FS_READ, FS_WRITE, FS_DELETE,
                    SHELL_EXEC, PROCESS_SPAWN,
                    NET_READ, NET_WRITE, BROWSER_CONTROL,
                    MODEL_CALL,
                }
            )
        )

    def has(self, capability: str) -> bool:
        if capability in self.granted:
            return True
        # A grant of "fs" implies "fs.read"; a grant of "fs.read" never implies "fs".
        parts = capability.split(".")
        return any(".".join(parts[:i]) in self.granted for i in range(1, len(parts)))

    def missing(self, required: frozenset[str] | set[str] | tuple[str, ...]) -> set[str]:
        return {c for c in required if not self.has(c)}

    def with_(self, *names: str) -> CapabilitySet:
        return CapabilitySet(self.granted | set(names))

    def without(self, *names: str) -> CapabilitySet:
        return CapabilitySet(self.granted - set(names))

    def __contains__(self, capability: object) -> bool:
        return isinstance(capability, str) and self.has(capability)

    def __iter__(self):
        return iter(sorted(self.granted))
