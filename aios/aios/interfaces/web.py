"""The web interface: a chat website backed by the same kernel the CLI uses.

This is the part of the system that makes "control my laptop" a real,
honest claim instead of a marketing one. It only works because of where it
runs: **on the same machine as the browser that opens it.** A cloud-hosted
chat page cannot reach into a user's laptop — nothing legitimate can, that is
what malware does. This module is designed to be started *locally*
(``aios serve``), after which the same filesystem/shell/code tools the CLI
uses act on the real machine underneath it, inside the same sandbox and
policy engine as every other interface.

Three pieces make that safe and honest:

- :class:`WebApprover` — every ``CONFIRM`` decision from the policy engine
  becomes a real approve/deny prompt in the browser, not an auto-yes. Nothing
  risky executes until a person clicks approve.
- One :class:`~aios.kernel.kernel.Kernel` per browser tab, each with its own
  event bus, so live task progress streams to the tab that asked for it and
  nowhere else.
- A conservative default workspace (``~/ai-workspace``, or ``AIOS_WORKSPACE``)
  rather than the whole filesystem — broad enough for real work, narrow enough
  that a wrong plan can't reach outside it. Widen it deliberately if you want
  the assistant operating over your whole home directory.

Chat vs. task routing is a plain heuristic, not a hidden model call on every
message: task-shaped text (imperative verbs — "build", "organize", "fix", …)
runs through the kernel; question-shaped text gets a direct, fast reply. The
UI shows which mode fired, and either can be forced explicitly.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any

from ..foundation.config import Config
from ..foundation.errors import AiosError, classify
from ..foundation.ids import new_id
from ..foundation.logging import get_logger
from ..kernel.kernel import Kernel
from ..model.types import Message, ModelRequest
from ..security.approvals import ApprovalRequest, ApprovalResult, Scope
from ..security.capabilities import CapabilitySet

log = get_logger("interfaces.web")

# FastAPI/Starlette must be importable at *module* level, not deferred inside
# create_app(). With `from __future__ import annotations` active, a route
# handler's parameter annotations are plain strings that FastAPI resolves
# against the handler's __globals__ (this module's globals) to know it must
# inject a WebSocket. A name that only exists in a function-local scope never
# reaches those globals, so resolution silently fails and the connection gets
# closed before the handler body ever runs - the failure mode has no
# traceback anywhere in this module's own code, which is what makes it worth
# this much explanation. The whole *module* stays optional, the same as
# aios.tools.builtin.browser: something only imports this file when it wants
# the web interface, and gets one clear ImportError with the fix if the
# `server` extra isn't installed.
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import HTMLResponse

    _FASTAPI_IMPORT_ERROR: ImportError | None = None
except ImportError as _exc:  # pragma: no cover - depends on environment
    FastAPI = WebSocket = WebSocketDisconnect = HTMLResponse = None  # type: ignore[assignment]
    _FASTAPI_IMPORT_ERROR = _exc

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8420
APPROVAL_TIMEOUT_S = 300.0
HISTORY_TURNS = 24

PERSONA = """You are a direct, capable assistant running locally on the user's own \
machine as part of their personal AI workspace. Answer clearly and concisely, like a \
sharp colleague, not a customer-service bot. If what they're asking would require \
actually doing something on their computer - creating or editing a file, running a \
command, organizing folders, building something, automating a task - tell them so \
plainly and suggest phrasing it as an instruction (e.g. "build...", "organize...", \
"run...") so it executes as a real task instead of just being talked about."""


# --------------------------------------------------------------------------
# Chat vs. task routing
# --------------------------------------------------------------------------

_TASK_VERBS = (
    "create", "write", "build", "make", "generate", "run", "execute", "install",
    "delete", "remove", "organize", "organise", "clean", "tidy", "analyze", "analyse",
    "fix", "debug", "refactor", "download", "deploy", "edit", "convert", "rename",
    "move", "copy", "scaffold", "commit", "push", "automate", "schedule", "extract",
    "transcode", "render", "update", "upgrade", "compile", "test", "optimize",
    "optimise", "backup", "publish", "research", "summarize", "summarise", "profile",
    "transcribe", "trim", "compress", "resize",
)
_TASK_VERB_RE = re.compile(r"\b(" + "|".join(_TASK_VERBS) + r")\b", re.IGNORECASE)

# "can/could/would/will you <verb>…" is a polite instruction ("can you build
# me a website?"), not a request for information, even though it is
# grammatically a question - so it gets its own category rather than folding
# into the informational starters below.
_MODAL_REQUEST_STARTERS = ("can", "could", "would", "will")

# A message that starts with one of these AND ends in "?" is asking about a
# fact or state, even when a task verb turns up inside it - "why did the
# *build* fail?" and "is this file safe to *delete*?" are both genuine
# questions where the verb is a noun or infinitive, not a command. Word
# presence alone can't tell those apart from an instruction; sentence
# position can, most of the time.
_INFO_QUESTION_STARTERS = (
    "what", "who", "where", "when", "why", "how", "is", "are", "does", "do",
    "did", "was", "were", "which", "should",
)


def classify_mode(text: str) -> str:
    """"chat" or "task" — the cheap heuristic the router falls back to.

    No model call on every keystroke: a genuine information question is chat;
    an instruction - imperative, or a polite "can/could you…" request - is a
    task. Ambiguous text defaults to chat, because a stray remark should
    never accidentally trigger a side effect - the UI lets the user force
    either mode explicitly.
    """
    stripped = text.strip()
    if not stripped:
        return "chat"
    lowered = stripped.lower()
    words = [w for w in re.split(r"\W+", lowered) if w]
    if not words:
        return "chat"
    first_word = words[0]
    is_question = lowered.endswith("?")
    has_verb = bool(_TASK_VERB_RE.search(lowered))

    if first_word in _MODAL_REQUEST_STARTERS and len(words) > 1 and words[1] == "you" and has_verb:
        return "task"
    if is_question and first_word in _INFO_QUESTION_STARTERS:
        return "chat"
    return "task" if has_verb else "chat"


# --------------------------------------------------------------------------
# The web approval broker
# --------------------------------------------------------------------------


class WebApprover:
    """Turns a policy CONFIRM into a real prompt in the browser.

    One instance per connection. ``send`` pushes an ``approval_request``
    message to that tab; the matching ``approval_response`` from the client
    resolves the pending future. A browser that never answers times out to a
    denial — silence is never treated as consent.
    """

    name = "web"

    def __init__(self, send: Any, *, timeout: float = APPROVAL_TIMEOUT_S) -> None:
        self._send = send
        self._timeout = timeout
        self._pending: dict[str, asyncio.Future[tuple[bool, str]]] = {}

    async def request(self, request: ApprovalRequest) -> ApprovalResult:
        request_id = new_id("appr_")
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        action = request.action
        try:
            await self._send({
                "type": "approval_request",
                "id": request_id,
                "tool": action.tool,
                "summary": action.describe(),
                "risk": request.decision.risk.name,
                "reason": request.decision.reason,
                "rule": request.decision.rule,
                "command": action.command,
                "paths": action.paths[:5],
                "urls": action.urls[:5],
                "reversible": action.reversible,
            })
            approved, scope = await asyncio.wait_for(future, timeout=self._timeout)
        except TimeoutError:
            return ApprovalResult(False, Scope.ONCE, "no response from the browser in time", self.name)
        finally:
            self._pending.pop(request_id, None)
        try:
            resolved_scope = Scope(scope)
        except ValueError:
            resolved_scope = Scope.ONCE
        return ApprovalResult(approved, resolved_scope, "user responded in the browser", self.name)

    def resolve(self, request_id: str, approved: bool, scope: str = "once") -> bool:
        """Called from the WebSocket receive loop when a response arrives."""
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result((approved, scope))
        return True

    def cancel_all(self, reason: str = "connection closed") -> None:
        """The tab disconnected mid-approval: resolve as denied, not hang forever."""
        for future in list(self._pending.values()):
            if not future.done():
                future.set_result((False, "once"))
        self._pending.clear()


# --------------------------------------------------------------------------
# Per-connection session
# --------------------------------------------------------------------------


class ChatSession:
    """One browser tab: its own kernel, bus, approver and conversation."""

    def __init__(self, config: Config, send: Any, *, grant: CapabilitySet | None = None) -> None:
        self.config = config
        self.send = send
        self.approver = WebApprover(send)
        self.kernel = Kernel(config, approvals=self.approver, grant=grant or CapabilitySet.standard())
        self.history: list[Message] = []
        self._subscription: str | None = None
        # Turns are serialized, but the socket's receive loop is not blocked by
        # this lock: it keeps pulling messages while a task runs, which is what
        # lets an approval_response reach WebApprover mid-task instead of
        # deadlocking behind the very turn that's waiting on it.
        self._turn_lock = asyncio.Lock()

    async def status(self) -> dict[str, Any]:
        provider = self.kernel.model.primary
        return {
            "type": "status",
            "workspace": str(self.config.workspace_root),
            "security_mode": self.config.security.mode,
            "model": provider.name,
            # provider.available() only means "won't crash if called" - the
            # offline fallback is always available in that sense. What the UI
            # actually needs to know is whether replies come from real
            # reasoning, which is can_generate().
            "model_ready": self.kernel.model.can_generate(),
            "tools": len(self.kernel.registry),
            "memory_enabled": self.config.memory.enabled,
        }

    async def handle(self, text: str, mode: str = "auto") -> None:
        async with self._turn_lock:
            resolved = mode if mode in {"chat", "task"} else classify_mode(text)
            if resolved == "task":
                await self._run_task(text)
            else:
                await self._reply(text)

    # -- chat --------------------------------------------------------
    async def _reply(self, text: str) -> None:
        lowered = text.strip().lower()
        if lowered.startswith("remember that ") or lowered.startswith("remember "):
            await self._remember(text)
            return

        self.history.append(Message.user(text))
        self.history = self.history[-HISTORY_TURNS:]
        context = self.kernel.memory.context_for(text, scope=str(self.config.workspace_root))
        system = PERSONA + (
            f"\n\nWhat you know about this user/workspace:\n{context}" if context else ""
        )
        # Kernel.run() leaves its (task-scoped) budget attached to the shared
        # model client afterward. A chat reply must not be checked against a
        # previous task's wall-clock timer, or a message could start failing
        # hours later for no reason visible in this turn. Task runs always
        # reassign a fresh budget at the top of run(), so clearing this here
        # never affects task accounting.
        self.kernel.model.budget = None
        try:
            completion = await self.kernel.model.complete(
                ModelRequest(messages=list(self.history), system=system), purpose="web_chat"
            )
        except AiosError as exc:
            await self.send({"type": "error", "text": f"couldn't get a reply: {exc.message}"})
            return
        self.history.append(Message.assistant(completion.text))
        await self.send({
            "type": "chat", "mode": "chat", "text": completion.text,
            "model": completion.model, "cached": completion.cached,
        })

    async def _remember(self, text: str) -> None:
        content = re.sub(r"^remember(\s+that)?\s+", "", text.strip(), flags=re.IGNORECASE)
        stored = self.kernel.memory.remember(
            "preference", content, scope=str(self.config.workspace_root), importance=0.85
        )
        message = f"Got it — I'll remember: {content}" if stored else (
            "I won't store that — it looks like it might contain a credential, "
            "and I don't keep those."
        )
        await self.send({"type": "chat", "mode": "chat", "text": message})

    # -- tasks ---------------------------------------------------------
    async def _run_task(self, goal: str) -> None:
        await self.send({"type": "task_started", "goal": goal})
        self._subscription = self.kernel.bus.subscribe("*", self._forward_event)
        started = time.monotonic()
        try:
            result = await self.kernel.run(goal)
        except AiosError as exc:
            await self.send({"type": "error", "text": f"the task couldn't run: {exc.message}"})
            return
        finally:
            if self._subscription:
                self.kernel.bus.unsubscribe(self._subscription)
                self._subscription = None

        summary = result.summary or f"finished with status: {result.status}"
        self.history.append(Message.user(goal))
        self.history.append(Message.assistant(f"[ran as a task] {summary}"))
        await self.send({
            "type": "task_complete",
            "status": result.status,
            "summary": summary,
            "duration_s": round(time.monotonic() - started, 2),
            "deliverables": [
                {"name": a.name, "kind": a.kind, "size": a.size, "media_type": a.media_type}
                for a in result.deliverables()
            ],
            "needs_human": result.needs_human,
            "cost_usd": round(result.budget.get("used", {}).get("usd", 0.0), 4),
        })

    async def _forward_event(self, event: Any) -> None:
        # Awaited, not fire-and-forget: the bus dispatches publishes one at a
        # time and awaits each handler, so this is what keeps the live step
        # feed arriving at the browser in the order it actually happened.
        await self.send({"type": "event", **event.to_dict()})

    def close(self) -> None:
        if self._subscription:
            self.kernel.bus.unsubscribe(self._subscription)
        self.approver.cancel_all()
        self.kernel.close()


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------


def default_workspace() -> Path:
    configured = os.environ.get("AIOS_WORKSPACE")
    root = Path(configured).expanduser() if configured else Path.home() / "ai-workspace"
    root.mkdir(parents=True, exist_ok=True)
    return root


def create_app(config: Config | None = None) -> FastAPI:
    if _FASTAPI_IMPORT_ERROR is not None:
        raise ImportError(
            "the web interface needs FastAPI and uvicorn: pip install 'aios[server]'"
        ) from _FASTAPI_IMPORT_ERROR

    from ..model import ModelClient, build_providers
    from ..tools import default_registry
    from .web_ui import INDEX_HTML

    base_config = config or Config.load(
        overrides={"workspace": {"root": str(default_workspace())}}, env={}
    )
    base_config.ensure_dirs()
    # Built once at startup, not per request/connection: tool and provider
    # objects are stateless enough to share, and rebuilding 50+ tools on every
    # status poll or new tab would be pure waste.
    tool_count = len(default_registry())

    app = FastAPI(title="AI Workspace")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return INDEX_HTML

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        providers = build_providers(base_config.model)
        # Same distinction as ChatSession.status(): the offline fallback is
        # always "available" (it won't crash) but cannot actually reason, and
        # that's what this field needs to communicate honestly.
        can_generate = ModelClient(providers, base_config.model).can_generate()
        return {
            "workspace": str(base_config.workspace_root),
            "security_mode": base_config.security.mode,
            "model": providers[0].name,
            "model_ready": can_generate,
            "tools": tool_count,
            "memory_enabled": base_config.memory.enabled,
        }

    @app.websocket("/ws")
    async def ws_endpoint(socket: WebSocket) -> None:
        await socket.accept()

        async def send(payload: dict[str, Any]) -> None:
            try:
                await socket.send_json(_jsonable(payload))
            except Exception:
                log.debug("send failed; socket likely closed", exc_info=True)

        session = ChatSession(base_config, send)
        await send(await session.status())

        # Fire-and-forget per message, deliberately not awaited: awaiting here
        # would block this loop for the whole turn, and it's this loop staying
        # free that lets an approval_response reach WebApprover mid-task. But
        # asyncio only holds a *weak* reference to a bare ensure_future() task,
        # so it can be garbage-collected mid-flight; this set holds the real
        # reference until the turn finishes.
        background: set[asyncio.Task[None]] = set()

        try:
            while True:
                raw = await socket.receive_json()
                kind = raw.get("type")
                if kind == "message":
                    text = str(raw.get("text", "")).strip()
                    if not text:
                        continue
                    mode = str(raw.get("mode", "auto"))
                    task = asyncio.ensure_future(_guarded_handle(session, text, mode, send))
                    background.add(task)
                    task.add_done_callback(background.discard)
                elif kind == "approval_response":
                    session.approver.resolve(
                        str(raw.get("id", "")),
                        bool(raw.get("approved", False)),
                        str(raw.get("scope", "once")),
                    )
                elif kind == "ping":
                    await send({"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            session.close()

    async def _guarded_handle(session: ChatSession, text: str, mode: str, send: Any) -> None:
        try:
            await session.handle(text, mode)
        except Exception as exc:
            error = classify(exc)
            log.warning("chat turn failed", extra={"error": error.code}, exc_info=True)
            await send({"type": "error", "text": f"something went wrong: {error.message}"})

    return app


def _jsonable(value: Any) -> Any:
    """Best-effort conversion so stray non-JSON-native values never break a send."""
    import json

    try:
        json.dumps(value)
        return value
    except TypeError:
        return json.loads(json.dumps(value, default=str))


def run(
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    workspace: str | None = None,
    config: Config | None = None,
) -> None:
    """Blocking entry point used by ``aios serve``."""
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "the web interface needs uvicorn: pip install 'aios[server]'"
        ) from exc

    resolved = config
    if resolved is None:
        root = Path(workspace).expanduser() if workspace else default_workspace()
        root.mkdir(parents=True, exist_ok=True)
        resolved = Config.load(overrides={"workspace": {"root": str(root)}}, env={})
    resolved.ensure_dirs()

    app = create_app(resolved)
    log.info("starting web interface", extra={"host": host, "port": port,
                                              "workspace": str(resolved.workspace_root)})
    uvicorn.run(app, host=host, port=port, log_level="warning")


__all__ = ["ChatSession", "WebApprover", "classify_mode", "create_app", "default_workspace", "run"]
