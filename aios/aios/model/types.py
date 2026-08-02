"""Provider-neutral message and completion types.

Every provider adapter converts to and from these, so nothing above the model
layer ever sees a vendor's wire format. That is what makes "swap the model" a
config change rather than a refactor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from ..runtime.budget import Usage


class Role(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass(slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolReturn:
    call_id: str
    content: str
    is_error: bool = False


@dataclass(slots=True)
class Message:
    role: Role
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_returns: list[ToolReturn] = field(default_factory=list)
    name: str = ""

    @classmethod
    def system(cls, content: str) -> Message:
        return cls(Role.SYSTEM, content)

    @classmethod
    def user(cls, content: str) -> Message:
        return cls(Role.USER, content)

    @classmethod
    def assistant(cls, content: str, tool_calls: list[ToolCall] | None = None) -> Message:
        return cls(Role.ASSISTANT, content, tool_calls=tool_calls or [])

    @classmethod
    def tool(cls, call_id: str, content: str, *, is_error: bool = False) -> Message:
        return cls(Role.TOOL, tool_returns=[ToolReturn(call_id, content, is_error)])

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role.value,
            "content": self.content,
            "tool_calls": [{"id": c.id, "name": c.name, "arguments": c.arguments}
                           for c in self.tool_calls],
            "tool_returns": [{"call_id": r.call_id, "content": r.content, "is_error": r.is_error}
                             for r in self.tool_returns],
        }


@dataclass(slots=True)
class Completion:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    model: str = ""
    stop_reason: str = ""
    raw: dict[str, Any] = field(default_factory=dict)
    cached: bool = False

    @property
    def has_tool_calls(self) -> bool:
        return bool(self.tool_calls)

    def to_message(self) -> Message:
        return Message.assistant(self.text, self.tool_calls)


@dataclass(slots=True)
class ModelRequest:
    messages: list[Message]
    system: str = ""
    tools: list[dict[str, Any]] = field(default_factory=list)
    temperature: float | None = None
    max_tokens: int | None = None
    stop_sequences: list[str] = field(default_factory=list)
    model: str = ""
    # Some tasks must return JSON; providers that support it enforce it natively,
    # the rest fall back to prompt-level instruction plus repair.
    json_schema: dict[str, Any] | None = None

    def cache_key(self) -> str:
        import hashlib
        import json

        payload = {
            "system": self.system,
            "messages": [m.to_dict() for m in self.messages],
            "tools": [t.get("name") for t in self.tools],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "model": self.model,
            "schema": self.json_schema,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode()
        ).hexdigest()
