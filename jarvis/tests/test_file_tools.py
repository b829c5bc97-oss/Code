import pytest

from backend.files import file_manager, search
from backend.files.file_manager import FileManagerError
from backend.tools.file_tools import register_file_tools
from backend.tools.registry import ToolRegistry


def test_create_read_rename_move_delete(tmp_path):
    target = tmp_path / "note.txt"
    file_manager.create_file(str(target), "hello")
    assert file_manager.read_file(str(target)) == "hello"

    file_manager.rename(str(target), "renamed.txt")
    renamed = tmp_path / "renamed.txt"
    assert renamed.exists()
    assert not target.exists()

    dest_dir = tmp_path / "sub"
    file_manager.move(str(renamed), str(dest_dir / "renamed.txt"))
    assert (dest_dir / "renamed.txt").exists()

    file_manager.delete(str(dest_dir))
    assert not dest_dir.exists()


def test_read_nonexistent_file_raises(tmp_path):
    with pytest.raises(FileManagerError):
        file_manager.read_file(str(tmp_path / "nope.txt"))


def test_delete_nonexistent_raises(tmp_path):
    with pytest.raises(FileManagerError):
        file_manager.delete(str(tmp_path / "nope.txt"))


def test_list_dir(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "sub").mkdir()
    entries = file_manager.list_dir(str(tmp_path))
    names = {e["name"] for e in entries}
    assert names == {"a.txt", "sub"}


def test_search_files(tmp_path):
    (tmp_path / "report.txt").write_text("x")
    (tmp_path / "notes.md").write_text("x")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "report_final.txt").write_text("x")

    matches = search.search_files("report", str(tmp_path))
    assert any("report.txt" in m for m in matches)
    assert any("report_final.txt" in m for m in matches)
    assert not any("notes.md" in m for m in matches)


@pytest.mark.asyncio
async def test_delete_tool_is_high_permission_and_works(tmp_path):
    from backend.core.permissions import PermissionLevel

    registry = ToolRegistry()
    register_file_tools(registry)
    tool = registry.get("files.delete")
    assert tool.permission == PermissionLevel.HIGH

    target = tmp_path / "gone.txt"
    target.write_text("bye")
    result = await tool.execute(path=str(target))
    assert result.success
    assert not target.exists()


@pytest.mark.asyncio
async def test_create_tool_reports_error_gracefully():
    registry = ToolRegistry()
    register_file_tools(registry)
    tool = registry.get("files.read")
    result = await tool.execute(path="/definitely/does/not/exist.txt")
    assert result.success is False
    assert result.error
