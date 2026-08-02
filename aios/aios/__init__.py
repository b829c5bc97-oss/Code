"""AI Digital Operating System.

An autonomous goal-execution kernel: it understands a request, plans a DAG of
work, executes it in parallel under a capability-based security policy,
verifies its own output, recovers from failures, and reports honestly on what
it did.

Quick start::

    from aios import Kernel, Config

    config = Config.load(overrides={"workspace": {"root": "./project"}})
    kernel = Kernel(config)
    result = await kernel.run("profile sales.csv and write an analysis report")
    print(result.summary)

The layering is strict and one-directional::

    foundation → runtime → security → tools → model → cognition → kernel → interfaces

Nothing ever imports downward, which is what keeps the kernel testable and the
tool layer replaceable.
"""

from __future__ import annotations

__version__ = "0.1.0"

from .cognition.intent import Intent
from .cognition.plan import Check, Plan, Step
from .foundation.config import Config
from .foundation.errors import AiosError
from .kernel.kernel import Kernel, RunResult
from .runtime.events import Event, EventBus, Topic
from .security.capabilities import CapabilitySet, RiskLevel
from .tools.base import Tool, ToolContext, ToolResult
from .tools.registry import ToolRegistry

__all__ = [
    "AiosError",
    "CapabilitySet",
    "Check",
    "Config",
    "Event",
    "EventBus",
    "Intent",
    "Kernel",
    "Plan",
    "RiskLevel",
    "RunResult",
    "Step",
    "Tool",
    "ToolContext",
    "ToolRegistry",
    "ToolResult",
    "Topic",
    "__version__",
]
