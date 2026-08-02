"""Network tools: HTTP, page reading and web search.

Uses ``urllib`` rather than ``requests`` to keep the kernel dependency-free.
The parts that matter are not the transport but the guards around it:

- redirects are followed manually so every hop is re-checked against the host
  policy (an allowlisted host must not be able to bounce us to a blocked one);
- SSRF defence: hosts resolving to loopback, link-local or private ranges are
  refused unless the workspace explicitly allowlists them, which is what keeps
  a "summarise this URL" task from reading cloud instance metadata;
- responses are size-capped and streamed to disk for downloads.

Web search is a pluggable backend: the OS ships the interface and a
Brave/SearXNG/Tavily adapter selected by environment, and reports honestly when
no backend is configured instead of inventing results.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any

from ...foundation.errors import (
    InvalidArguments,
    RateLimited,
    Remedy,
    ToolExecutionError,
    TransientError,
)
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

USER_AGENT = "aios/0.1 (+autonomous-agent)"
MAX_REDIRECTS = 5
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _assert_public_host(url: str, *, allowed_hosts: list[str]) -> str:
    """Reject URLs that resolve into private space (SSRF guard)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise InvalidArguments(f"unsupported URL scheme: {parsed.scheme or '(none)'}")
    host = parsed.hostname
    if not host:
        raise InvalidArguments(f"URL has no host: {url}")
    if any(host == entry or host.endswith("." + entry.lstrip("*.")) for entry in allowed_hosts):
        return host  # operator opted in explicitly
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise TransientError(f"cannot resolve host {host}: {exc}", cause=exc) from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise InvalidArguments(
                f"refusing to fetch {host}: resolves to non-public address {address}. "
                "Add it to security.allowed_hosts to permit this deliberately.",
                context={"host": host, "address": str(address)},
            )
    return host


def _request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 30.0,
    max_bytes: int = 5_000_000,
    allowed_hosts: list[str],
) -> dict[str, Any]:
    """Blocking HTTP with manual redirect handling. Run via ``asyncio.to_thread``."""
    current = url
    history: list[str] = []
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_host(current, allowed_hosts=allowed_hosts)
        request = urllib.request.Request(current, method=method, data=body)
        request.add_header("User-Agent", USER_AGENT)
        request.add_header("Accept-Encoding", "identity")
        for key, value in (headers or {}).items():
            request.add_header(key, value)

        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=timeout) as response:
                payload = response.read(max_bytes + 1)
                truncated = len(payload) > max_bytes
                return {
                    "url": current,
                    "status": response.status,
                    "headers": dict(response.headers),
                    "body": payload[:max_bytes],
                    "truncated": truncated,
                    "redirects": history,
                }
        except urllib.error.HTTPError as exc:
            if exc.code in {301, 302, 303, 307, 308} and exc.headers.get("Location"):
                history.append(current)
                current = urllib.parse.urljoin(current, exc.headers["Location"])
                if exc.code == 303 or (exc.code in {301, 302} and method == "POST"):
                    method, body = "GET", None
                continue
            payload = exc.read(max_bytes) if hasattr(exc, "read") else b""
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After")
                raise RateLimited(
                    f"rate limited by {current}",
                    retry_after=float(retry_after) if (retry_after or "").isdigit() else None,
                    context={"url": current, "status": 429},
                ) from exc
            if exc.code >= 500:
                raise TransientError(
                    f"server error {exc.code} from {current}",
                    context={"url": current, "status": exc.code,
                             "body": payload[:500].decode("utf-8", "replace")},
                ) from exc
            return {
                "url": current,
                "status": exc.code,
                "headers": dict(exc.headers),
                "body": payload,
                "truncated": False,
                "redirects": history,
            }
        except (urllib.error.URLError, TimeoutError) as exc:
            raise TransientError(f"request to {current} failed: {exc}", cause=exc) from exc
    raise ToolExecutionError(f"too many redirects starting at {url}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kw: Any) -> None:
        return None


class HttpRequest(Tool):
    name = "net.http"
    summary = "Make an HTTP request and return status, headers and body."
    tags = ("network", "http", "api", "integration")
    capabilities = frozenset({caps.NET_READ})
    risk = RiskLevel.LOW
    default_timeout = 120.0
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "method": {"type": "string",
                       "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "default": "GET"},
            "headers": {"type": "object"},
            "json": {"description": "JSON-serializable request body."},
            "body": {"type": "string"},
            "timeout": {"type": "number", "minimum": 1, "default": 30},
            "max_bytes": {"type": "integer", "minimum": 1024, "default": 5000000},
        },
        "required": ["url"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        method = str(args.get("method", "GET")).upper()
        writes = method not in SAFE_METHODS
        return ActionRequest(
            tool=self.name,
            arguments=args,
            capabilities=frozenset({caps.NET_READ} | ({caps.NET_WRITE} if writes else set())),
            risk=RiskLevel.MODERATE if writes else RiskLevel.LOW,
            reversible=not writes,
            summary=f"{method} {args.get('url', '')}",
            urls=[str(args.get("url", ""))],
        )

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        method = str(args.get("method", "GET")).upper()
        headers = {str(k): str(v) for k, v in (args.get("headers") or {}).items()}
        body: bytes | None = None
        if args.get("json") is not None:
            body = json.dumps(args["json"]).encode()
            headers.setdefault("Content-Type", "application/json")
        elif args.get("body"):
            body = str(args["body"]).encode()

        response = await asyncio.to_thread(
            _request,
            args["url"],
            method=method,
            headers=headers,
            body=body,
            timeout=float(args.get("timeout", 30)),
            max_bytes=int(args.get("max_bytes", 5_000_000)),
            allowed_hosts=ctx.config.security.allowed_hosts,
        )
        raw: bytes = response["body"]
        content_type = str(response["headers"].get("Content-Type", ""))
        parsed: Any = None
        text = raw.decode("utf-8", "replace")
        if "json" in content_type:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = None
        ok = 200 <= response["status"] < 400
        payload = {
            "url": response["url"],
            "status": response["status"],
            "headers": response["headers"],
            "json": parsed,
            "text": text if parsed is None else "",
            "truncated": response["truncated"],
            "redirects": response["redirects"],
        }
        if not ok:
            return ToolResult.failure(
                ToolExecutionError(
                    f"HTTP {response['status']} from {response['url']}",
                    context={"status": response["status"], "body": text[:600]},
                ),
                summary=f"HTTP {response['status']}",
                metrics={"status": response["status"]},
            )
        return ToolResult.success(
            payload,
            summary=f"HTTP {response['status']} · {len(raw)} bytes from {response['url']}",
            metrics={"status": response["status"], "bytes": len(raw)},
        )


class _TextExtractor(HTMLParser):
    """Turn HTML into readable text, keeping structure that carries meaning."""

    _DROP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "iframe"}
    _BLOCK = {"p", "div", "section", "article", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[dict[str, str]] = []
        self.title = ""
        self._skip = 0
        self._in_title = False
        self._href: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._DROP:
            self._skip += 1
            return
        if tag == "title":
            self._in_title = True
        if tag in self._BLOCK:
            self.parts.append("\n")
        if tag in {"h1", "h2", "h3"}:
            self.parts.append("\n## ")
        if tag == "a":
            self._href = dict(attrs).get("href") or None
            self._link_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag in self._DROP:
            self._skip = max(0, self._skip - 1)
            return
        if tag == "title":
            self._in_title = False
        if tag == "a" and self._href:
            text = "".join(self._link_text).strip()
            if text:
                self.links.append({"text": text[:120], "href": self._href})
            self._href = None
        if tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        if self._in_title:
            self.title += data.strip()
            return
        if self._href is not None:
            self._link_text.append(data)
        if data.strip():
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [" ".join(line.split()) for line in raw.split("\n")]
        return "\n".join(line for line in lines if line).strip()


class FetchPage(Tool):
    name = "net.read_page"
    summary = "Fetch a web page and return its readable text, title and links."
    tags = ("network", "http", "research", "read")
    capabilities = frozenset({caps.NET_READ})
    risk = RiskLevel.SAFE
    default_timeout = 120.0
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "max_chars": {"type": "integer", "minimum": 500, "default": 40000},
            "include_links": {"type": "boolean", "default": True},
        },
        "required": ["url"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.urls = [str(args.get("url", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        response = await asyncio.to_thread(
            _request,
            args["url"],
            timeout=30.0,
            max_bytes=8_000_000,
            allowed_hosts=ctx.config.security.allowed_hosts,
        )
        if response["status"] >= 400:
            return ToolResult.failure(
                ToolExecutionError(f"HTTP {response['status']} fetching {args['url']}"),
                summary=f"HTTP {response['status']}",
            )
        charset = "utf-8"
        content_type = str(response["headers"].get("Content-Type", ""))
        if "charset=" in content_type:
            charset = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        try:
            raw = response["body"].decode(charset, "replace")
        except LookupError:
            raw = response["body"].decode("utf-8", "replace")

        parser = _TextExtractor()
        try:
            parser.feed(raw)
        except Exception:
            pass
        text = parser.text()[: int(args.get("max_chars", 40000))]
        links = parser.links[:100] if args.get("include_links", True) else []
        artifact = ctx.keep_text(
            f"page-{urllib.parse.urlparse(args['url']).netloc or 'fetch'}.md",
            f"# {parser.title or args['url']}\n\nSource: {args['url']}\n\n{text}",
            media_type="text/markdown",
        )
        return ToolResult.success(
            {"url": response["url"], "title": parser.title, "text": text,
             "links": links, "chars": len(text)},
            summary=f"read {len(text)} chars from {parser.title or args['url']}",
            artifacts=[artifact],
        )


class DownloadFile(Tool):
    name = "net.download"
    summary = "Download a URL to a file in the workspace."
    tags = ("network", "http", "download", "write")
    capabilities = frozenset({caps.NET_READ, caps.FS_WRITE})
    risk = RiskLevel.LOW
    default_timeout = 600.0
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "destination": {"type": "string"},
            "max_bytes": {"type": "integer", "minimum": 1024, "default": 200000000},
        },
        "required": ["url", "destination"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.urls = [str(args.get("url", ""))]
        action.paths = [str(args.get("destination", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        destination = ctx.jail.resolve(args["destination"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        response = await asyncio.to_thread(
            _request,
            args["url"],
            timeout=120.0,
            max_bytes=int(args.get("max_bytes", 200_000_000)),
            allowed_hosts=ctx.config.security.allowed_hosts,
        )
        if response["status"] >= 400:
            return ToolResult.failure(
                ToolExecutionError(f"HTTP {response['status']} downloading {args['url']}")
            )
        destination.write_bytes(response["body"])
        artifact = ctx.keep_file(destination)
        return ToolResult.success(
            {"url": args["url"], "path": ctx.jail.relative(destination),
             "bytes": destination.stat().st_size, "truncated": response["truncated"]},
            summary=f"downloaded {destination.stat().st_size} bytes to {destination.name}",
            artifacts=[artifact],
        )


class WebSearch(Tool):
    """Search the web through a configured backend.

    Backends are selected by environment variable. With none configured the
    tool fails loudly rather than returning plausible-looking fabrications -
    a search tool that invents results is worse than no search tool.
    """

    name = "net.search"
    summary = "Search the web and return ranked results with snippets."
    tags = ("network", "research", "search", "read")
    capabilities = frozenset({caps.NET_READ})
    risk = RiskLevel.SAFE
    default_timeout = 90.0
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "minLength": 2},
            "count": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8},
        },
        "required": ["query"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.urls = ["https://search.backend"]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = args["query"]
        count = int(args.get("count", 8))
        backend, results = await self._search(query, count, ctx)
        if backend is None:
            raise ToolExecutionError(
                "no web search backend is configured. Set BRAVE_SEARCH_API_KEY, "
                "TAVILY_API_KEY or SEARXNG_URL to enable net.search.",
                context={"query": query},
                remedy=Remedy.SUBSTITUTE,
            )
        return ToolResult.success(
            {"query": query, "backend": backend, "results": results},
            summary=f"{len(results)} result(s) for {query!r} via {backend}",
        )

    async def _search(
        self, query: str, count: int, ctx: ToolContext
    ) -> tuple[str | None, list[dict[str, str]]]:
        allowed = ctx.config.security.allowed_hosts
        if key := os.environ.get("BRAVE_SEARCH_API_KEY"):
            url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
                {"q": query, "count": count}
            )
            response = await asyncio.to_thread(
                _request, url,
                headers={"X-Subscription-Token": key, "Accept": "application/json"},
                allowed_hosts=allowed,
            )
            data = json.loads(response["body"].decode("utf-8", "replace") or "{}")
            return "brave", [
                {"title": item.get("title", ""), "url": item.get("url", ""),
                 "snippet": item.get("description", "")}
                for item in (data.get("web", {}).get("results") or [])[:count]
            ]
        if key := os.environ.get("TAVILY_API_KEY"):
            response = await asyncio.to_thread(
                _request, "https://api.tavily.com/search",
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"api_key": key, "query": query, "max_results": count}).encode(),
                allowed_hosts=allowed,
            )
            data = json.loads(response["body"].decode("utf-8", "replace") or "{}")
            return "tavily", [
                {"title": item.get("title", ""), "url": item.get("url", ""),
                 "snippet": item.get("content", "")[:400]}
                for item in (data.get("results") or [])[:count]
            ]
        if base := os.environ.get("SEARXNG_URL"):
            url = base.rstrip("/") + "/search?" + urllib.parse.urlencode(
                {"q": query, "format": "json"}
            )
            response = await asyncio.to_thread(_request, url, allowed_hosts=allowed)
            data = json.loads(response["body"].decode("utf-8", "replace") or "{}")
            return "searxng", [
                {"title": item.get("title", ""), "url": item.get("url", ""),
                 "snippet": item.get("content", "")[:400]}
                for item in (data.get("results") or [])[:count]
            ]
        return None, []


def tools() -> list[Tool]:
    return [HttpRequest(), FetchPage(), DownloadFile(), WebSearch()]


__all__ = ["tools"]
