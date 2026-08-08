import pytest

from backend.browser.browser import BrowserSession
from backend.core.config import Settings
from backend.core.permissions import PermissionLevel
from backend.tools.registry import ToolRegistry
from backend.tools.browser_tools import register_browser_tools


def test_register_browser_tools_populates_registry():
    registry = ToolRegistry()
    register_browser_tools(registry, session=BrowserSession())

    names = {t.name for t in registry.list()}
    assert names == {
        "browser.open",
        "browser.navigate",
        "browser.search",
        "browser.extract_text",
        "browser.click",
        "browser.type",
        "browser.scroll",
        "browser.close",
    }


def test_click_and_type_are_medium_permission_others_are_low():
    registry = ToolRegistry()
    register_browser_tools(registry, session=BrowserSession())

    assert registry.get("browser.click").permission == PermissionLevel.MEDIUM
    assert registry.get("browser.type").permission == PermissionLevel.MEDIUM
    assert registry.get("browser.open").permission == PermissionLevel.LOW
    assert registry.get("browser.navigate").permission == PermissionLevel.LOW
    assert registry.get("browser.search").permission == PermissionLevel.LOW
    assert registry.get("browser.extract_text").permission == PermissionLevel.LOW
    assert registry.get("browser.scroll").permission == PermissionLevel.LOW
    assert registry.get("browser.close").permission == PermissionLevel.LOW


@pytest.mark.asyncio
async def test_navigate_tool_reports_failure_gracefully_when_browser_unavailable():
    """Even if Playwright/Chromium isn't installed, the tool must not raise."""
    registry = ToolRegistry()
    session = BrowserSession(Settings(browser_executable_path="/nonexistent/chromium-binary"))
    register_browser_tools(registry, session=session)

    result = await registry.get("browser.navigate").execute(url="example.com")

    assert result.success is False
    assert result.error


@pytest.mark.asyncio
async def test_real_browser_can_navigate_and_extract_text():
    """Best-effort integration test against the real, pre-installed Chromium.

    Skips instead of failing if no working browser binary is available in
    this environment (e.g. CI without Playwright's browsers installed).
    """
    import os
    import shutil

    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or shutil.which("chromium")
    settings = Settings(browser_headless=True, browser_executable_path=executable or "")

    registry = ToolRegistry()
    session = BrowserSession(settings)
    register_browser_tools(registry, session=session)

    try:
        open_result = await registry.get("browser.navigate").execute(
            url="data:text/html,<html><body><h1>Hello JARVIS</h1></body></html>"
        )
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"No usable browser in this environment: {exc}")

    if not open_result.success:
        pytest.skip(f"No usable browser in this environment: {open_result.error}")

    try:
        text_result = await registry.get("browser.extract_text").execute()
        assert text_result.success
        assert "Hello JARVIS" in text_result.output
    finally:
        await session.close()
