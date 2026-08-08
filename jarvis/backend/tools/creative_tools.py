"""
Creative tools — integration points only, not implemented.

Image generation/editing, video editing assistance, and graphic/presentation/
social-media design all require an external generative-media API (e.g.
OpenAI Images, Stability AI, Runway) that this project doesn't assume or
bundle a key for. Rather than fake a result, these are intentionally left
as named integration points: wiring one in means implementing the function
below against your chosen provider's API (reading its key from `Settings`,
the same pattern as `ai/llm.py`), then registering it as a tool in a new
`register_creative_tools()` following the pattern in `tools/browser_tools.py`.

None of this is registered into the tool registry — the agent should never
see (and try to call) a capability that doesn't exist yet.
"""
from __future__ import annotations


async def generate_image(prompt: str) -> bytes:
    raise NotImplementedError(
        "Image generation requires an external API (e.g. OpenAI Images, Stability AI) "
        "that isn't configured. Add an API key + client here to enable it."
    )


async def edit_image(image_bytes: bytes, instruction: str) -> bytes:
    raise NotImplementedError("Image editing requires an external generative-image API.")


async def generate_presentation_design(topic: str) -> bytes:
    raise NotImplementedError(
        "Rich presentation *design* (themes, layouts, imagery) needs a design/image API — "
        "plain-content decks work today via documents.create_pptx."
    )
