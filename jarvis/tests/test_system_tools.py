import pytest

from backend.tools.registry import ToolRegistry
from backend.tools.system_tools import get_system_info, register_system_tools


def test_get_system_info_shape():
    info = get_system_info()
    assert 0 <= info["cpu_percent"] <= 100
    assert 0 <= info["memory_percent"] <= 100
    assert 0 <= info["disk_percent"] <= 100
    assert isinstance(info["network_up"], bool)
    assert isinstance(info["top_processes"], list)


@pytest.mark.asyncio
async def test_system_info_tool():
    registry = ToolRegistry()
    register_system_tools(registry)
    result = await registry.get("system.get_system_info").execute()
    assert result.success
    assert "CPU" in result.output
