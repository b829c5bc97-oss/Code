"""
JARVIS backend entry point.

Run with:
    uvicorn backend.main:app --reload --port 8000
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.ai.llm import LLMError, get_llm_provider
from backend.browser.browser import get_browser_session
from backend.core.agent import Agent, AgentState
from backend.core.config import get_settings
from backend.tools.browser_tools import register_browser_tools
from backend.tools.registry import get_tool_registry

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await get_browser_session().close()


app = FastAPI(title=settings.app_name, version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_tool_registry = get_tool_registry()
if settings.enable_browser_tools:
    register_browser_tools(_tool_registry)

_agent = Agent(settings=settings, tool_registry=_tool_registry)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    session_id: str | None = None


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
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    session_id = request.session_id or str(uuid.uuid4())
    result = await _agent.handle_message(session_id, request.message)
    return ChatResponse(
        reply=result.reply,
        state=result.state,
        provider=result.provider,
        session_id=session_id,
        tool_activity=[
            ToolActivityOut(name=a.name, success=a.success, summary=a.summary)
            for a in result.tool_activity
        ],
    )
