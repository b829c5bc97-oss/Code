"""
Browser session management — Phase 3.

Wraps Playwright's async API in a small singleton `BrowserSession` so tool
functions (`browser_actions.py`) don't each have to manage their own
browser/page lifecycle. Launches a real, visible Chromium window by default
(`Settings.browser_headless = False`) so automation stays observable, per
the project's safety principle — the user should always be able to see what
JARVIS is doing in the browser.
"""
from __future__ import annotations

import asyncio

from backend.core.config import Settings, get_settings


class BrowserError(RuntimeError):
    """Raised when the browser can't be launched or a page action fails."""


class BrowserSession:
    """Lazily-launched, reusable Playwright browser + single page.

    Phase 3 keeps this to one page at a time — enough for "open a site,
    search, read, click, type" style tasks. Multi-tab management can be
    added later without changing the tool-facing API in
    `browser_actions.py`.
    """

    def __init__(self, settings: Settings | None = None):
        self._settings = settings or get_settings()
        self._playwright = None
        self._browser = None
        self._page = None
        self._lock = asyncio.Lock()

    @property
    def is_open(self) -> bool:
        return self._page is not None

    async def ensure_started(self):
        """Launch the browser if it isn't already running, and return the active page."""
        async with self._lock:
            if self._page is not None:
                return self._page
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:  # pragma: no cover - dependency guard
                raise BrowserError(
                    "The 'playwright' package is not installed. Run "
                    "`pip install -r requirements.txt` and then "
                    "`playwright install chromium`."
                ) from exc

            try:
                self._playwright = await async_playwright().start()
                launch_kwargs: dict = {"headless": self._settings.browser_headless}
                if self._settings.browser_executable_path:
                    launch_kwargs["executable_path"] = self._settings.browser_executable_path
                if self._settings.browser_proxy_server:
                    launch_kwargs["proxy"] = {"server": self._settings.browser_proxy_server}
                self._browser = await self._playwright.chromium.launch(**launch_kwargs)
                context = await self._browser.new_context()
                self._page = await context.new_page()
            except Exception as exc:  # noqa: BLE001
                await self._cleanup()
                raise BrowserError(
                    f"Couldn't launch the browser: {exc}. If Chromium isn't installed, run "
                    "`playwright install chromium`."
                ) from exc
            return self._page

    async def get_page(self):
        if self._page is None:
            return await self.ensure_started()
        return self._page

    async def _cleanup(self):
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception:  # noqa: BLE001
                pass
        if self._playwright is not None:
            try:
                await self._playwright.stop()
            except Exception:  # noqa: BLE001
                pass
        self._browser = None
        self._playwright = None
        self._page = None

    async def close(self):
        async with self._lock:
            await self._cleanup()


_session: BrowserSession | None = None


def get_browser_session() -> BrowserSession:
    global _session
    if _session is None:
        _session = BrowserSession()
    return _session
