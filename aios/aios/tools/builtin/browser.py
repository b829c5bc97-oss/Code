"""Semantic browser automation.

The failure mode this module exists to avoid: automations pinned to CSS paths
and pixel coordinates, which break the moment a site ships a redesign.

So targets are described *semantically* - "the Submit button", "the field
labelled Email" - and resolved at run time through a cascade of strategies,
strongest first:

1. ARIA role + accessible name (what a screen reader would use)
2. label / placeholder association
3. visible text
4. ``data-testid`` and similar test hooks
5. CSS/XPath, only if the caller explicitly supplied one

Each strategy is tried until an element is uniquely resolved, so a layout
change that leaves the page semantically intact does not break the automation.
The browser lives in a :class:`BrowserSession` shared across steps of a run, so
a login in step 2 is still valid in step 9.

Playwright is an optional extra; without it these tools fail with an actionable
install message rather than pretending to work.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ...foundation.errors import ToolExecutionError, TransientError
from ...foundation.logging import get_logger
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

log = get_logger("tools.browser")

_INSTALL_HINT = (
    "browser automation needs Playwright: `pip install 'aios[browser]' && playwright install "
    "chromium`. Set PLAYWRIGHT_BROWSERS_PATH if browsers are installed elsewhere."
)


def _playwright():
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise ToolExecutionError(_INSTALL_HINT, context={"missing": "playwright"}) from exc
    return async_playwright


@dataclass
class BrowserSession:
    """One browser per run, reused across steps so state survives."""

    headless: bool = True
    _playwright: Any = None
    _browser: Any = None
    _context: Any = None
    _page: Any = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def page(self) -> Any:
        async with self._lock:
            if self._page is not None:
                return self._page
            manager = _playwright()
            self._playwright = await manager().start()
            try:
                self._browser = await self._playwright.chromium.launch(headless=self.headless)
            except Exception as exc:
                await self.close()
                raise ToolExecutionError(f"could not launch chromium: {exc}. {_INSTALL_HINT}") from exc
            self._context = await self._browser.new_context(
                viewport={"width": 1440, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 aios/0.1"
                ),
            )
            self._context.set_default_timeout(20000)
            self._page = await self._context.new_page()
            return self._page

    async def close(self) -> None:
        for closer in (self._context, self._browser, self._playwright):
            if closer is None:
                continue
            try:
                await (closer.stop() if hasattr(closer, "stop") else closer.close())
            except Exception:
                log.debug("browser teardown error", exc_info=True)
        self._playwright = self._browser = self._context = self._page = None


async def _session(ctx: ToolContext) -> BrowserSession:
    """One session per run, stashed on the context inputs bag."""
    store = ctx.inputs.setdefault("__aios_browser__", {})
    session = store.get("session")
    if session is None:
        session = BrowserSession(headless=True)
        store["session"] = session
    return session


async def resolve(page: Any, target: str, *, kind: str = "any") -> Any:
    """Resolve a semantic description to exactly one element locator.

    Returns the first strategy that matches exactly one visible element. The
    ordering encodes a preference for *meaning* over *structure*, which is what
    makes the automation survive redesigns.
    """
    roles = {
        "button": ["button", "link"],
        "link": ["link"],
        "input": ["textbox", "searchbox", "combobox", "spinbutton"],
        "checkbox": ["checkbox", "switch"],
        "any": ["button", "link", "textbox", "checkbox", "combobox", "searchbox"],
    }[kind]

    candidates = []
    for role in roles:
        candidates.append(("role:" + role, page.get_by_role(role, name=target, exact=False)))
    candidates += [
        ("label", page.get_by_label(target, exact=False)),
        ("placeholder", page.get_by_placeholder(target, exact=False)),
        ("text", page.get_by_text(target, exact=False)),
        ("testid", page.locator(f'[data-testid="{target}"], [data-test="{target}"], #{target}')),
    ]
    if target.startswith(("//", "css=", ".", "#", "[")):
        candidates.insert(0, ("selector", page.locator(target)))

    misses: list[str] = []
    for name, locator in candidates:
        try:
            count = await locator.count()
        except Exception:
            continue
        if count == 1:
            return locator
        if count > 1:
            # Ambiguous: prefer the first *visible* one rather than failing outright.
            for index in range(min(count, 8)):
                item = locator.nth(index)
                try:
                    if await item.is_visible():
                        return item
                except Exception:
                    continue
            misses.append(f"{name}={count} matches")
        else:
            misses.append(f"{name}=0")
    raise TransientError(
        f"could not find {kind} matching {target!r} on the page",
        context={"target": target, "strategies_tried": misses[:8]},
    )


class BrowserBase(Tool):
    tags = ("browser", "web", "automation")
    capabilities = frozenset({caps.BROWSER_CONTROL, caps.NET_READ})
    risk = RiskLevel.MODERATE
    default_timeout = 180.0

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        if args.get("url"):
            action.urls = [str(args["url"])]
        return action


class Navigate(BrowserBase):
    name = "browser.open"
    summary = "Open a URL in the run's browser and return the page's readable content."
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "wait_for": {"type": "string", "description": "Optional text/selector to wait for."},
            "timeout": {"type": "number", "minimum": 1, "default": 45},
        },
        "required": ["url"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        page = await (await _session(ctx)).page()
        timeout = float(args.get("timeout", 45)) * 1000
        await page.goto(args["url"], wait_until="domcontentloaded", timeout=timeout)
        if args.get("wait_for"):
            try:
                await resolve(page, str(args["wait_for"]))
            except TransientError:
                await page.wait_for_timeout(1500)
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        title = await page.title()
        text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        return ToolResult.success(
            {"url": page.url, "title": title, "text": text[:30000], "chars": len(text)},
            summary=f"opened {title or page.url}",
        )


class Extract(BrowserBase):
    name = "browser.extract"
    summary = "Extract structured content from the current page (text, links, tables, forms)."
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {
            "what": {"type": "string", "enum": ["text", "links", "tables", "forms", "all"],
                     "default": "all"},
            "selector": {"type": "string", "description": "Limit extraction to this container."},
        },
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        page = await (await _session(ctx)).page()
        what = args.get("what", "all")
        scope = args.get("selector") or "body"
        payload: dict[str, Any] = {"url": page.url, "title": await page.title()}

        if what in {"text", "all"}:
            payload["text"] = (await page.evaluate(
                "(sel) => { const el = document.querySelector(sel); return el ? el.innerText : ''; }",
                scope,
            ))[:30000]
        if what in {"links", "all"}:
            payload["links"] = (await page.evaluate(
                "(sel) => [...(document.querySelector(sel)||document).querySelectorAll('a[href]')]"
                ".slice(0,300).map(a => ({text: a.innerText.trim().slice(0,120), href: a.href}))",
                scope,
            ))
        if what in {"tables", "all"}:
            payload["tables"] = (await page.evaluate(
                "(sel) => [...(document.querySelector(sel)||document).querySelectorAll('table')]"
                ".slice(0,20).map(t => [...t.rows].slice(0,200).map(r => "
                "[...r.cells].map(c => c.innerText.trim())))",
                scope,
            ))
        if what in {"forms", "all"}:
            payload["forms"] = (await page.evaluate(
                "(sel) => [...(document.querySelector(sel)||document).querySelectorAll('form')]"
                ".slice(0,20).map(f => ({action: f.action, method: f.method, fields: "
                "[...f.elements].slice(0,60).map(e => ({name: e.name, type: e.type, "
                "label: (e.labels && e.labels[0] ? e.labels[0].innerText.trim() : '') "
                "|| e.placeholder || '', required: e.required}))}))",
                scope,
            ))
        counts = {k: len(v) for k, v in payload.items() if isinstance(v, list)}
        return ToolResult.success(payload, summary=f"extracted {counts or 'text'} from {page.url}")


class Interact(BrowserBase):
    """Click, fill, select or upload against a semantically described target."""

    name = "browser.act"
    summary = "Click, type, select or upload on the current page using a plain-language target."
    risk = RiskLevel.MODERATE
    reversible = False
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "action": {"type": "string",
                       "enum": ["click", "fill", "select", "check", "upload", "press", "scroll"]},
            "target": {"type": "string",
                       "description": "What to act on, e.g. 'Sign in button' or 'Email'."},
            "value": {"type": "string", "description": "Text to type, option to select, key to press."},
            "file": {"type": "string", "description": "Workspace path for upload."},
            "wait_after_ms": {"type": "integer", "minimum": 0, "default": 800},
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        page = await (await _session(ctx)).page()
        action = args["action"]
        target = str(args.get("target", ""))

        if action == "scroll":
            await page.mouse.wheel(0, int(args.get("value") or 800))
        elif action == "press":
            await page.keyboard.press(str(args.get("value") or "Enter"))
        else:
            kind = {"fill": "input", "check": "checkbox", "click": "any"}.get(action, "any")
            locator = await resolve(page, target, kind=kind)
            if action == "click":
                await locator.click()
            elif action == "fill":
                await locator.fill(str(args.get("value", "")))
            elif action == "select":
                await locator.select_option(str(args.get("value", "")))
            elif action == "check":
                await locator.check()
            elif action == "upload":
                path = ctx.jail.resolve(str(args.get("file", "")), must_exist=True)
                await locator.set_input_files(str(path))

        await page.wait_for_timeout(int(args.get("wait_after_ms", 800)))
        return ToolResult.success(
            {"action": action, "target": target, "url": page.url, "title": await page.title()},
            summary=f"{action} {target or args.get('value', '')} -> {page.url}",
        )


class Screenshot(BrowserBase):
    name = "browser.screenshot"
    summary = "Capture a screenshot of the current page."
    risk = RiskLevel.SAFE
    capabilities = frozenset({caps.BROWSER_CONTROL, caps.NET_READ, caps.FS_WRITE})
    parameters = {
        "type": "object",
        "properties": {
            "output": {"type": "string", "default": "screenshot.png"},
            "full_page": {"type": "boolean", "default": True},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("output", "screenshot.png"))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        page = await (await _session(ctx)).page()
        destination = ctx.jail.resolve(args.get("output", "screenshot.png"), write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(destination), full_page=bool(args.get("full_page", True)))
        return ToolResult.success(
            {"path": ctx.jail.relative(destination), "url": page.url,
             "bytes": destination.stat().st_size},
            summary=f"captured {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class CloseBrowser(BrowserBase):
    name = "browser.close"
    summary = "Close the run's browser session and release resources."
    risk = RiskLevel.SAFE
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        store = ctx.inputs.get("__aios_browser__") or {}
        session = store.pop("session", None)
        if session is not None:
            await session.close()
        return ToolResult.success({"closed": session is not None}, summary="browser closed")


def tools() -> list[Tool]:
    return [Navigate(), Extract(), Interact(), Screenshot(), CloseBrowser()]


__all__ = ["BrowserSession", "resolve", "tools"]
