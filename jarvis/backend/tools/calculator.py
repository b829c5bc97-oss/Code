"""
Calculator tool — not implemented.

Not a priority: a general-purpose LLM already does arithmetic and unit
conversion directly in its replies without needing a tool call for it.
Left as a stub in case a use case needs guaranteed-exact computation
(the model doing mental math can be wrong) — implementing it means a safe
expression evaluator (not `eval`) and registering it in
`tools/registry.py` following the pattern in `tools/system_tools.py`.
"""
from __future__ import annotations


async def calculate(expression: str) -> float:
    raise NotImplementedError("The calculator tool is not implemented — see module docstring.")
