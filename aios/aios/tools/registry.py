"""Tool registry and capability-based lookup.

Two consumers with different needs:

- the **planner** asks "what can do X?" and gets a ranked shortlist plus model
  facing specs, so plans reference real tool names instead of invented ones;
- the **recovery engine** asks "what else could have done what this tool
  failed at?" and gets alternatives sharing the failed tool's tags, which is
  what turns a dead branch into a substitution.

Registration is explicit and versioned; re-registering the same name is an
error unless ``replace=True``, so a plugin cannot silently shadow a builtin.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from typing import Any

from ..foundation.errors import RegistryError, ToolNotFound
from ..foundation.logging import get_logger
from ..security.capabilities import CapabilitySet, RiskLevel
from .base import Tool

log = get_logger("tools.registry")


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}
        self._aliases: dict[str, str] = {}
        self._origin: dict[str, str] = {}

    # -- registration ----------------------------------------------------
    def register(
        self,
        tool: Tool,
        *,
        aliases: Iterable[str] = (),
        origin: str = "builtin",
        replace: bool = False,
    ) -> Tool:
        if not isinstance(tool, Tool):
            raise RegistryError(f"{tool!r} is not a Tool instance")
        if tool.name in self._tools and not replace:
            raise RegistryError(
                f"tool {tool.name!r} is already registered by {self._origin.get(tool.name)}"
            )
        self._tools[tool.name] = tool
        self._origin[tool.name] = origin
        for alias in aliases:
            if alias in self._tools:
                raise RegistryError(f"alias {alias!r} collides with a registered tool")
            self._aliases[alias] = tool.name
        log.debug("registered tool", extra={"tool": tool.name, "origin": origin})
        return tool

    def register_all(self, tools: Iterable[Tool], **kw: Any) -> None:
        for tool in tools:
            self.register(tool, **kw)

    def unregister(self, name: str) -> bool:
        existed = self._tools.pop(name, None) is not None
        self._origin.pop(name, None)
        self._aliases = {a: t for a, t in self._aliases.items() if t != name}
        return existed

    # -- lookup ----------------------------------------------------------
    def get(self, name: str) -> Tool:
        resolved = self._aliases.get(name, name)
        tool = self._tools.get(resolved)
        if tool is None:
            raise ToolNotFound(
                f"no tool named {name!r}",
                context={"available": self.names()[:60], "suggestions": self.suggest(name)},
            )
        return tool

    def try_get(self, name: str) -> Tool | None:
        try:
            return self.get(name)
        except ToolNotFound:
            return None

    def has(self, name: str) -> bool:
        return self._aliases.get(name, name) in self._tools

    def names(self) -> list[str]:
        return sorted(self._tools)

    def all(self) -> list[Tool]:
        return [self._tools[name] for name in self.names()]

    def __iter__(self) -> Iterator[Tool]:
        return iter(self.all())

    def __len__(self) -> int:
        return len(self._tools)

    # -- filtering -------------------------------------------------------
    def available_to(self, grant: CapabilitySet) -> list[Tool]:
        """Only the tools this session is actually permitted to invoke."""
        return [t for t in self.all() if not grant.missing(t.capabilities)]

    def by_tag(self, *tags: str) -> list[Tool]:
        wanted = set(tags)
        return [t for t in self.all() if wanted & set(t.tags)]

    def max_risk(self, level: RiskLevel) -> list[Tool]:
        return [t for t in self.all() if t.risk <= level]

    def alternatives(self, name: str, *, grant: CapabilitySet | None = None) -> list[Tool]:
        """Other tools that plausibly serve the same purpose.

        Ranked by tag overlap, then by lower risk - a substitution should not
        escalate authority.
        """
        try:
            original = self.get(name)
        except ToolNotFound:
            return []
        candidates: list[tuple[int, int, Tool]] = []
        for tool in self.all():
            if tool.name == original.name:
                continue
            overlap = len(set(tool.tags) & set(original.tags))
            if overlap == 0:
                continue
            if grant is not None and grant.missing(tool.capabilities):
                continue
            candidates.append((-overlap, int(tool.risk), tool))
        candidates.sort(key=lambda item: (item[0], item[1], item[2].name))
        return [tool for _, _, tool in candidates]

    def suggest(self, name: str, limit: int = 5) -> list[str]:
        """Fuzzy name suggestions for a miss - fed back to the planner."""
        import difflib

        pool = [*self._tools, *self._aliases]
        return difflib.get_close_matches(name, pool, n=limit, cutoff=0.5)

    # -- model-facing ----------------------------------------------------
    def specs(self, grant: CapabilitySet | None = None) -> list[dict[str, Any]]:
        tools = self.available_to(grant) if grant else self.all()
        return [t.spec() for t in tools]

    def catalog(self, grant: CapabilitySet | None = None) -> str:
        """Compact text catalog for planner prompts (token-efficient)."""
        tools = self.available_to(grant) if grant else self.all()
        lines = []
        for tool in tools:
            from .schema import describe

            lines.append(
                f"- {tool.name} {describe(tool.parameters)} "
                f"[risk={tool.risk.name.lower()}] {tool.summary}"
            )
        return "\n".join(lines)

    def manifest(self) -> list[dict[str, Any]]:
        return [{**t.manifest(), "origin": self._origin.get(t.name, "?")} for t in self.all()]
