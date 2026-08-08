import pytest

from backend.ai import vision
from backend.ai.llm import ChatMessage, LLMProvider
from backend.computer.errors import ComputerControlError


class StubVisionProvider(LLMProvider):
    name = "stub-vision"

    def __init__(self, image_response: str):
        self._image_response = image_response

    async def chat(self, messages: list[ChatMessage]) -> str:
        return "unused"

    async def describe_image(self, image_bytes: bytes, prompt: str) -> str:
        return self._image_response


@pytest.fixture(autouse=True)
def _fake_screenshot(monkeypatch):
    monkeypatch.setattr(vision.screen, "take_screenshot", lambda: b"fake-png-bytes")
    monkeypatch.setattr(vision.screen, "get_screen_size", lambda: (1000, 500))


@pytest.mark.asyncio
async def test_describe_screen_returns_provider_text():
    provider = StubVisionProvider("You're looking at a code editor.")
    result = await vision.describe_screen(provider)
    assert result == "You're looking at a code editor."


@pytest.mark.asyncio
async def test_locate_element_parses_percent_coordinates():
    provider = StubVisionProvider('{"found": true, "x_pct": 50, "y_pct": 10}')
    point = await vision.locate_element(provider, "the settings gear")
    assert point == (500, 50)  # 50% of 1000, 10% of 500


@pytest.mark.asyncio
async def test_locate_element_returns_none_when_not_found():
    provider = StubVisionProvider('{"found": false}')
    point = await vision.locate_element(provider, "a unicorn")
    assert point is None


@pytest.mark.asyncio
async def test_locate_element_handles_garbage_response():
    provider = StubVisionProvider("I'm not sure what you mean.")
    point = await vision.locate_element(provider, "the settings gear")
    assert point is None


@pytest.mark.asyncio
async def test_describe_screen_propagates_screenshot_failure(monkeypatch):
    def boom():
        raise ComputerControlError("no display")

    monkeypatch.setattr(vision.screen, "take_screenshot", boom)
    provider = StubVisionProvider("irrelevant")
    with pytest.raises(ComputerControlError):
        await vision.describe_screen(provider)
