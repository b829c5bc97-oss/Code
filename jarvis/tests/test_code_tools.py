import pytest

from backend.core.config import Settings
from backend.core.permissions import PermissionLevel
from backend.tools.code_tools import is_dangerous_command, register_code_tools
from backend.tools.registry import ToolRegistry


@pytest.fixture(autouse=True)
def _workspace(tmp_path, monkeypatch):
    from backend.core import config

    settings = Settings(workspace_dir=str(tmp_path / "workspace"))
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    # code_tools imports get_settings directly into its module namespace
    import backend.tools.code_tools as code_tools_module

    monkeypatch.setattr(code_tools_module, "get_settings", lambda: settings)
    return settings


@pytest.mark.asyncio
async def test_create_project_python_template():
    registry = ToolRegistry()
    register_code_tools(registry)
    result = await registry.get("code.create_project").execute(name="myapp", template="python")
    assert result.success
    assert "myapp" in result.output


@pytest.mark.asyncio
async def test_create_project_twice_fails():
    registry = ToolRegistry()
    register_code_tools(registry)
    await registry.get("code.create_project").execute(name="dup", template="blank")
    result = await registry.get("code.create_project").execute(name="dup", template="blank")
    assert result.success is False


@pytest.mark.asyncio
async def test_write_and_read_file(tmp_path):
    registry = ToolRegistry()
    register_code_tools(registry)
    target = tmp_path / "hello.py"
    write = await registry.get("code.write_file").execute(path=str(target), content="print(1)")
    assert write.success

    read = await registry.get("code.read_file").execute(path=str(target))
    assert read.success
    assert read.output == "print(1)"


@pytest.mark.asyncio
async def test_run_command_success_and_failure(tmp_path):
    registry = ToolRegistry()
    register_code_tools(registry)
    tool = registry.get("code.run_command")

    ok = await tool.execute(command="echo hello-jarvis", cwd=str(tmp_path))
    assert ok.success
    assert "hello-jarvis" in ok.output

    bad = await tool.execute(command="exit 7", cwd=str(tmp_path))
    assert bad.success is False
    assert "7" in bad.error


@pytest.mark.asyncio
async def test_run_command_timeout(tmp_path):
    registry = ToolRegistry()
    register_code_tools(registry)
    tool = registry.get("code.run_command")
    result = await tool.execute(command="sleep 5", cwd=str(tmp_path), timeout=1)
    assert result.success is False
    assert "timed out" in result.error


def test_dangerous_command_detection():
    assert is_dangerous_command("sudo rm -rf /")
    assert is_dangerous_command("rm -rf /")
    assert is_dangerous_command("mkfs.ext4 /dev/sda1")
    assert not is_dangerous_command("npm run build")
    assert not is_dangerous_command("pytest -q")


@pytest.mark.asyncio
async def test_run_command_escalates_permission_for_dangerous_commands():
    registry = ToolRegistry()
    register_code_tools(registry)
    tool = registry.get("code.run_command")
    assert tool.permission == PermissionLevel.MEDIUM
    assert tool.risk_escalation({"command": "sudo rm -rf /"}) == PermissionLevel.HIGH
    assert tool.risk_escalation({"command": "npm test"}) is None
