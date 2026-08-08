"""
JARVIS backend entry point.

Run with:
    uvicorn backend.main:app --reload --port 8000
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.ai.llm import LLMError, get_llm_provider
from backend.browser.browser import get_browser_session
from backend.core.agent import Agent, AgentState
from backend.core.config import get_settings
from backend.core.memory import MEMORY_CATEGORIES, get_memory_store
from backend.tools.browser_tools import register_browser_tools
from backend.tools.code_tools import register_code_tools
from backend.tools.computer_tools import register_computer_tools, register_vision_tools
from backend.tools.document_tools import register_document_tools
from backend.tools.file_tools import register_file_tools
from backend.tools.memory_tools import register_memory_tools
from backend.tools.registry import get_tool_registry
from backend.tools.research import register_research_tools
from backend.tools.system_tools import get_system_info, register_system_tools

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await get_browser_session().close()


app = FastAPI(title=settings.app_name, version="0.4.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_tool_registry = get_tool_registry()
_memory_store = get_memory_store()
_llm = get_llm_provider(settings)

if settings.enable_browser_tools:
    register_browser_tools(_tool_registry)
if settings.enable_computer_tools:
    register_computer_tools(_tool_registry)
    register_vision_tools(_tool_registry, _llm)
if settings.enable_memory_tools:
    register_memory_tools(_tool_registry, _memory_store)
if settings.enable_file_tools:
    register_file_tools(_tool_registry)
if settings.enable_code_tools:
    register_code_tools(_tool_registry)
if settings.enable_document_tools:
    register_document_tools(_tool_registry)
if settings.enable_system_tools:
    register_system_tools(_tool_registry)
if settings.enable_browser_tools:
    register_research_tools(_tool_registry, get_browser_session())

_agent = Agent(settings=settings, llm=_llm, tool_registry=_tool_registry, long_term_memory=_memory_store)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    session_id: str | None = None


class ConfirmRequest(BaseModel):
    session_id: str
    approved: bool


class ToolActivityOut(BaseModel):
    name: str
    success: bool
    summary: str


class ChatResponse(BaseModel):
    reply: str
    state: AgentState
    provider: str
    session_id: str
    tool_activity: list[ToolActivityOut] = []
    plan: list[str] = []


class MemoryEntryIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)
    category: str = "fact"


class MemoryEntryOut(BaseModel):
    id: str
    category: str
    content: str
    created_at: str


def _to_chat_response(session_id: str, result) -> ChatResponse:
    return ChatResponse(
        reply=result.reply,
        state=result.state,
        provider=result.provider,
        session_id=session_id,
        tool_activity=[
            ToolActivityOut(name=a.name, success=a.success, summary=a.summary)
            for a in result.tool_activity
        ],
        plan=result.plan,
    )


@app.get("/api/health")
async def health() -> dict:
    """Lightweight liveness + configuration check for the frontend to poll on startup."""
    provider_ready = True
    provider_error: str | None = None
    try:
        get_llm_provider(settings)
    except LLMError as exc:
        provider_ready = False
        provider_error = str(exc)

    return {
        "status": "ok",
        "app_name": settings.app_name,
        "ai_provider": settings.ai_provider,
        "provider_ready": provider_ready,
        "provider_error": provider_error,
        "browser_tools_enabled": settings.enable_browser_tools,
        "computer_tools_enabled": settings.enable_computer_tools,
        "memory_tools_enabled": settings.enable_memory_tools,
        "file_tools_enabled": settings.enable_file_tools,
        "code_tools_enabled": settings.enable_code_tools,
        "document_tools_enabled": settings.enable_document_tools,
        "system_tools_enabled": settings.enable_system_tools,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    session_id = request.session_id or str(uuid.uuid4())
    result = await _agent.handle_message(session_id, request.message)
    return _to_chat_response(session_id, result)


@app.post("/api/confirm", response_model=ChatResponse)
async def confirm(request: ConfirmRequest) -> ChatResponse:
    result = await _agent.confirm(request.session_id, request.approved)
    return _to_chat_response(request.session_id, result)


@app.get("/api/memory", response_model=list[MemoryEntryOut])
async def list_memory() -> list[MemoryEntryOut]:
    return [MemoryEntryOut(**vars(e)) for e in _memory_store.list()]


@app.post("/api/memory", response_model=MemoryEntryOut)
async def create_memory(entry: MemoryEntryIn) -> MemoryEntryOut:
    if entry.category not in MEMORY_CATEGORIES:
        raise HTTPException(422, f"category must be one of {MEMORY_CATEGORIES}")
    created = _memory_store.add(entry.category, entry.content)
    return MemoryEntryOut(**vars(created))


@app.delete("/api/memory/{entry_id}")
async def delete_memory(entry_id: str) -> dict:
    removed = _memory_store.delete(entry_id)
    if not removed:
        raise HTTPException(404, "Memory entry not found.")
    return {"deleted": entry_id}


@app.get("/api/system")
async def system_status() -> dict:
    """Lightweight system dashboard data — CPU/RAM/disk/battery/network/top processes."""
    if not settings.enable_system_tools:
        raise HTTPException(404, "System monitor is disabled.")
    try:
        return get_system_info()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Couldn't read system info: {exc}") from exc
