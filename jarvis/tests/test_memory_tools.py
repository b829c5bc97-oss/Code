import pytest

from backend.core.memory import LongTermMemoryStore
from backend.tools.memory_tools import register_memory_tools
from backend.tools.registry import ToolRegistry


@pytest.fixture
def registry(tmp_path):
    store = LongTermMemoryStore(tmp_path / "memory.json")
    r = ToolRegistry()
    register_memory_tools(r, store)
    return r, store


@pytest.mark.asyncio
async def test_remember_and_list(registry):
    r, _store = registry
    result = await r.get("memory.remember").execute(content="Likes concise answers", category="preference")
    assert result.success

    listing = await r.get("memory.list").execute()
    assert "Likes concise answers" in listing.output


@pytest.mark.asyncio
async def test_remember_empty_content_fails(registry):
    r, _store = registry
    result = await r.get("memory.remember").execute(content="   ")
    assert result.success is False


@pytest.mark.asyncio
async def test_recall_finds_matches(registry):
    r, _store = registry
    await r.get("memory.remember").execute(content="Favorite editor is VS Code")
    result = await r.get("memory.recall").execute(query="editor")
    assert "VS Code" in result.output


@pytest.mark.asyncio
async def test_forget_removes_entry(registry):
    r, store = registry
    entry = store.add("fact", "temporary note")
    result = await r.get("memory.forget").execute(id=entry.id)
    assert result.success
    assert store.list() == []


@pytest.mark.asyncio
async def test_forget_nonexistent_reports_error(registry):
    r, _store = registry
    result = await r.get("memory.forget").execute(id="does-not-exist")
    assert result.success is False
