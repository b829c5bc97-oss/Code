from .base import Tool, ToolContext, ToolResult
from .registry import ToolRegistry
from .schema import ValidationError, validate, validate_and_coerce


def default_registry() -> ToolRegistry:
    """A registry populated with every builtin this environment supports."""
    from .builtin import load

    registry = ToolRegistry()
    registry.register_all(load())
    return registry


__all__ = [
    "Tool",
    "ToolContext",
    "ToolRegistry",
    "ToolResult",
    "ValidationError",
    "default_registry",
    "validate",
    "validate_and_coerce",
]
