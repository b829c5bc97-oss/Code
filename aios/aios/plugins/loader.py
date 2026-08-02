"""Plugin loading.

Extensibility is a first-class requirement, so adding a tool, a model provider
or a policy rule must not require touching the kernel. A plugin is a Python
module exposing any of:

    def tools() -> list[Tool]
    def providers() -> dict[str, type[BaseProvider]]
    def policy_rules() -> list[Rule]
    def setup(registry, config) -> None

Plugins are discovered from configured directories and from the
``aios.plugins`` entry-point group. Two rules keep them from becoming a
liability:

- **Isolation.** A plugin that raises on import is logged and skipped; it can
  never prevent the OS from starting.
- **No privilege escalation.** Plugin tools declare capabilities like any other
  tool and are checked by the same policy engine, so installing a plugin does
  not widen what a session may do.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..foundation.config import Config
from ..foundation.logging import get_logger
from ..tools.base import Tool
from ..tools.registry import ToolRegistry

log = get_logger("plugins")

ENTRY_POINT_GROUP = "aios.plugins"


@dataclass(slots=True)
class LoadedPlugin:
    name: str
    origin: str
    tools: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)
    rules: int = 0
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error


class PluginLoader:
    def __init__(self, registry: ToolRegistry, config: Config) -> None:
        self.registry = registry
        self.config = config
        self.loaded: list[LoadedPlugin] = []
        self.rules: list[Any] = []

    def load_all(self) -> list[LoadedPlugin]:
        for path in self.config.plugin_paths:
            self.load_directory(Path(path).expanduser())
        self.load_entry_points()
        return self.loaded

    def load_directory(self, directory: Path) -> None:
        if not directory.is_dir():
            log.warning("plugin path is not a directory", extra={"path": str(directory)})
            return
        for candidate in sorted(directory.glob("*.py")):
            if candidate.name.startswith("_"):
                continue
            self._load_file(candidate)
        for package in sorted(directory.iterdir()):
            if package.is_dir() and (package / "__init__.py").exists():
                self._load_file(package / "__init__.py", name=package.name)

    def load_entry_points(self) -> None:
        try:
            from importlib.metadata import entry_points
        except ImportError:  # pragma: no cover - Python < 3.8
            return
        try:
            found = entry_points(group=ENTRY_POINT_GROUP)
        except TypeError:  # pragma: no cover - older API shape
            found = entry_points().get(ENTRY_POINT_GROUP, [])  # type: ignore[assignment]
        for entry in found:
            try:
                module = entry.load()
            except Exception as exc:
                log.warning("plugin entry point failed", extra={"entry": entry.name}, exc_info=True)
                self.loaded.append(LoadedPlugin(entry.name, "entry_point", error=str(exc)[:300]))
                continue
            self._register(module, entry.name, "entry_point")

    def _load_file(self, path: Path, name: str | None = None) -> None:
        module_name = f"aios_plugin_{name or path.stem}"
        try:
            spec = importlib.util.spec_from_file_location(module_name, path)
            if spec is None or spec.loader is None:
                raise ImportError(f"cannot load {path}")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        except Exception as exc:
            log.warning("plugin failed to import", extra={"path": str(path)}, exc_info=True)
            self.loaded.append(LoadedPlugin(path.stem, str(path), error=str(exc)[:300]))
            return
        self._register(module, name or path.stem, str(path))

    def _register(self, module: Any, name: str, origin: str) -> None:
        record = LoadedPlugin(name=name, origin=origin)
        try:
            if hasattr(module, "tools"):
                for tool in module.tools():
                    if not isinstance(tool, Tool):
                        raise TypeError(f"{name}.tools() returned a non-Tool: {tool!r}")
                    self.registry.register(tool, origin=f"plugin:{name}", replace=False)
                    record.tools.append(tool.name)
            if hasattr(module, "providers"):
                from ..model import register_provider

                for provider_name, factory in module.providers().items():
                    register_provider(provider_name, factory)
                    record.providers.append(provider_name)
            if hasattr(module, "policy_rules"):
                extra = list(module.policy_rules())
                self.rules.extend(extra)
                record.rules = len(extra)
            if hasattr(module, "setup"):
                module.setup(self.registry, self.config)
        except Exception as exc:
            record.error = str(exc)[:300]
            log.warning("plugin registration failed", extra={"plugin": name}, exc_info=True)
        self.loaded.append(record)
        if record.ok:
            log.info(
                "loaded plugin",
                extra={"plugin": name, "tools": len(record.tools),
                       "providers": len(record.providers)},
            )

    def report(self) -> list[dict[str, Any]]:
        return [
            {"name": p.name, "origin": p.origin, "tools": p.tools,
             "providers": p.providers, "rules": p.rules, "error": p.error or None}
            for p in self.loaded
        ]


EXAMPLE = '''"""Example aios plugin. Drop into a directory listed in config.plugin_paths."""

from aios.security import capabilities as caps
from aios.security.capabilities import RiskLevel
from aios.tools.base import Tool, ToolContext, ToolResult


class Greet(Tool):
    name = "example.greet"
    summary = "Return a greeting - the smallest possible plugin tool."
    tags = ("example",)
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {"name": {"type": "string", "default": "world"}},
        "additionalProperties": False,
    }

    async def execute(self, args, ctx: ToolContext) -> ToolResult:
        who = args.get("name", "world")
        return ToolResult.success({"greeting": f"hello, {who}"}, summary=f"greeted {who}")


def tools():
    return [Greet()]
'''
