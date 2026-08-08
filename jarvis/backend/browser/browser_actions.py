"""
Browser page actions — Phase 3.

High-level, tool-facing operations built on top of `BrowserSession`. Every
function here is defensive: Playwright/network failures are caught and
turned into a plain-English error string rather than raised, because these
functions are called directly by `tools/browser_tools.py` as tool
executions, and a tool should never crash the agent loop.

`detect_requires_human()` is a best-effort heuristic, not a guarantee — it
looks for common CAPTCHA/login signals so JARVIS can stop and hand control
back rather than pretending to push through a security check.
"""
from __future__ import annotations

from urllib.parse import quote_plus

from backend.browser.browser import BrowserError, BrowserSession

MAX_EXTRACT_CHARS = 4000

_SEARCH_URLS = {
    "google": "https://www.google.com/search?q={q}",
    "youtube": "https://www.youtube.com/results?search_query={q}",
    "bing": "https://www.bing.com/search?q={q}",
}

_CAPTCHA_SIGNALS = ("recaptcha", "hcaptcha", "captcha-delivery", "cf-turnstile")
_LOGIN_URL_SIGNALS = ("login", "signin", "sign-in", "accounts.google.com", "auth")


async def detect_requires_human(page) -> str | None:
    """Return a human-readable reason if the page looks like it needs a human, else None."""
    try:
        for frame in page.frames:
            url = (frame.url or "").lower()
            if any(signal in url for signal in _CAPTCHA_SIGNALS):
                return "This page has a security check (CAPTCHA) that needs a human to solve."

        current_url = (page.url or "").lower()
        if any(signal in current_url for signal in _LOGIN_URL_SIGNALS):
            password_fields = await page.locator('input[type="password"]').count()
            if password_fields > 0:
                return "This page needs you to sign in."
    except Exception:  # noqa: BLE001 - detection is best-effort, never fatal
        return None
    return None


def _normalize_url(url: str) -> str:
    url = url.strip()
    # Leave URLs that already name a scheme (http(s), data, file, about, ...)
    # alone; only bare hostnames like "wikipedia.org" get https:// added.
    if "://" in url or url.startswith(("data:", "about:", "file:")):
        return url
    return f"https://{url}"


async def navigate(session: BrowserSession, url: str) -> tuple[str, str | None]:
    """Navigate to `url`. Returns (result message, human-required reason or None)."""
    page = await session.ensure_started()
    target = _normalize_url(url)
    try:
        await page.goto(target, wait_until="domcontentloaded", timeout=20000)
    except Exception as exc:  # noqa: BLE001
        raise BrowserError(f"Couldn't open {target}: {exc}") from exc

    reason = await detect_requires_human(page)
    title = await page.title()
    return f"Opened {page.url} ({title or 'untitled'}).", reason


async def search(session: BrowserSession, query: str, engine: str = "google") -> tuple[str, str | None]:
    engine = engine.lower() if engine.lower() in _SEARCH_URLS else "google"
    url = _SEARCH_URLS[engine].format(q=quote_plus(query))
    message, reason = await navigate(session, url)
    return f"Searched {engine} for {query!r}. {message}", reason


async def extract_text(session: BrowserSession, max_chars: int = MAX_EXTRACT_CHARS) -> str:
    page = await session.get_page()
    try:
        text = await page.locator("body").inner_text(timeout=5000)
    except Exception as exc:  # noqa: BLE001
        raise BrowserError(f"Couldn't read the page: {exc}") from exc
    text = " ".join(text.split())
    if len(text) > max_chars:
        text = text[:max_chars] + "…"
    return text


async def click(session: BrowserSession, text: str) -> str:
    page = await session.get_page()
    locator = page.get_by_text(text, exact=False).first
    try:
        await locator.click(timeout=5000)
    except Exception as exc:  # noqa: BLE001
        raise BrowserError(f"Couldn't find or click anything matching {text!r}: {exc}") from exc
    return f"Clicked {text!r}."


async def type_text(session: BrowserSession, text: str, target: str | None = None) -> str:
    page = await session.get_page()
    try:
        if target:
            locator = page.get_by_placeholder(target, exact=False).first
            if await locator.count() == 0:
                locator = page.get_by_label(target, exact=False).first
        else:
            locator = page.locator(
                'input:not([type="hidden"]):not([type="submit"]), textarea'
            ).first
        await locator.fill(text, timeout=5000)
    except Exception as exc:  # noqa: BLE001
        raise BrowserError(f"Couldn't type into the page: {exc}") from exc
    return f"Typed {text!r}."


async def scroll(session: BrowserSession, direction: str = "down", amount: int = 800) -> str:
    page = await session.get_page()
    delta = amount if direction.lower() != "up" else -amount
    try:
        await page.mouse.wheel(0, delta)
    except Exception as exc:  # noqa: BLE001
        raise BrowserError(f"Couldn't scroll: {exc}") from exc
    return f"Scrolled {direction} by {amount}px."
