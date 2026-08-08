"""
Screen vision — Phase 2+.

Will capture screenshots (`computer/screen.py`) and use a vision-capable
LLM (or a dedicated OCR/UI-element-detection model) to answer questions
like "what's on my screen?" and to locate UI elements by description
("click the settings button") without hard-coded coordinates.

Not implemented yet.
"""
from __future__ import annotations


class ScreenVision:
    async def describe_screen(self) -> str:
        raise NotImplementedError("Screen vision is not implemented until Phase 2.")

    async def locate_element(self, description: str) -> tuple[int, int] | None:
        raise NotImplementedError("UI element location is not implemented until Phase 2.")
