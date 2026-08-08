"""
Real (not mocked) computer-control tests.

These exercise the actual `pyautogui`/`mss`/`ewmh` calls, so they need a
real display. They skip gracefully wherever one isn't available (e.g. a
headless CI box with no `$DISPLAY` and no Xvfb) rather than failing —
computer control genuinely not working without a desktop session is
expected, not a bug.
"""
from __future__ import annotations

import pytest

from backend.computer import applications, mouse, screen, windows
from backend.computer.errors import ComputerControlError
from backend.tools.computer_tools import register_computer_tools, register_vision_tools
from backend.tools.registry import ToolRegistry


def _skip_if_no_display(exc: ComputerControlError):
    pytest.skip(f"No usable display in this environment: {exc}")


def test_screenshot_and_screen_size():
    try:
        size = screen.get_screen_size()
        png = screen.take_screenshot()
    except ComputerControlError as exc:
        _skip_if_no_display(exc)
        return
    assert size[0] > 0 and size[1] > 0
    assert png[:8] == b"\x89PNG\r\n\x1a\n"  # PNG magic bytes


def test_mouse_move_and_position():
    try:
        mouse.move(50, 60, duration=0)
    except ComputerControlError as exc:
        _skip_if_no_display(exc)
        return
    x, y = mouse.get_position()
    assert (x, y) == (50, 60)


def test_list_windows_does_not_raise_unexpectedly():
    try:
        titles = windows.list_windows()
    except ComputerControlError as exc:
        _skip_if_no_display(exc)
        return
    assert isinstance(titles, list)


def test_open_nonexistent_application_reports_clear_error():
    with pytest.raises(ComputerControlError):
        applications.open_application("definitely-not-a-real-app-xyz")


@pytest.mark.asyncio
async def test_computer_tools_registered_with_expected_permissions():
    from backend.core.permissions import PermissionLevel

    registry = ToolRegistry()
    register_computer_tools(registry)
    assert registry.get("computer.open_application").permission == PermissionLevel.LOW
    assert registry.get("computer.close_application").permission == PermissionLevel.MEDIUM
    assert registry.get("computer.click").permission == PermissionLevel.MEDIUM
    assert registry.get("computer.list_windows").permission == PermissionLevel.LOW


@pytest.mark.asyncio
async def test_open_application_tool_reports_failure_gracefully():
    registry = ToolRegistry()
    register_computer_tools(registry)
    result = await registry.get("computer.open_application").execute(name="not-a-real-app-xyz")
    assert result.success is False
    assert result.error


@pytest.mark.asyncio
async def test_vision_tools_fail_clearly_without_vision_support():
    from backend.ai.llm import MockProvider

    registry = ToolRegistry()
    register_vision_tools(registry, MockProvider())
    result = await registry.get("computer.describe_screen").execute()
    assert result.success is False
    assert "mock" in result.error.lower()
