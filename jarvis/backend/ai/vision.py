"""
Screen vision — Phase 2.

Rather than a separate OCR/UI-detection model, this sends a real screenshot
to whichever AI provider is configured and asks it to describe the screen
or locate an element by description — real multimodal LLMs (GPT-4o,
Claude) are already good at this, and it means no hard-coded coordinates
and no extra model to maintain. The `mock` provider (and any future
provider that doesn't implement `describe_image`) fails with a clear
message rather than fabricating a description — see `LLMProvider.
describe_image`'s default in `ai/llm.py`.
"""
from __future__ import annotations

import json
import re

from backend.ai.llm import LLMError, LLMProvider
from backend.computer import screen


class VisionError(RuntimeError):
    """Raised when screen vision can't produce an answer."""


_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_json_lenient(text: str) -> dict | None:
    match = _JSON_OBJECT_RE.search(text)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


async def describe_screen(llm: LLMProvider) -> str:
    """Take a screenshot and ask the LLM to describe what's on it."""
    png = screen.take_screenshot()
    prompt = (
        "Describe concisely what's currently visible on this computer screen: "
        "open windows/apps, key visible text, and general layout. 2-3 sentences."
    )
    try:
        return await llm.describe_image(png, prompt)
    except LLMError as exc:
        raise VisionError(str(exc)) from exc


async def locate_element(llm: LLMProvider, description: str) -> tuple[int, int] | None:
    """Ask the LLM to find a described UI element; returns its center in screen pixels."""
    png = screen.take_screenshot()
    width, height = screen.get_screen_size()
    prompt = (
        f"This is a screenshot of a {width}x{height}px computer screen. Find the UI "
        f"element described as: {description!r}. Respond with ONLY compact JSON and "
        'nothing else: {"found": true, "x_pct": <0-100, center X as %% of width>, '
        '"y_pct": <0-100, center Y as %% of height>} — or {"found": false} if you '
        "can't find it."
    )
    try:
        raw = await llm.describe_image(png, prompt)
    except LLMError as exc:
        raise VisionError(str(exc)) from exc

    data = _parse_json_lenient(raw)
    if not data or not data.get("found"):
        return None
    try:
        x = round(width * float(data["x_pct"]) / 100)
        y = round(height * float(data["y_pct"]) / 100)
    except (KeyError, TypeError, ValueError) as exc:
        raise VisionError(f"Got an unexpected response while locating the element: {raw!r}") from exc
    return (x, y)
