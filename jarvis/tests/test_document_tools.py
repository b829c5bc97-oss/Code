import pytest

from backend.core.config import Settings
from backend.tools.document_tools import register_document_tools
from backend.tools.registry import ToolRegistry


@pytest.fixture(autouse=True)
def _workspace(tmp_path, monkeypatch):
    import backend.tools.document_tools as doc_module

    settings = Settings(workspace_dir=str(tmp_path / "workspace"))
    monkeypatch.setattr(doc_module, "get_settings", lambda: settings)
    return settings


@pytest.fixture
def registry():
    r = ToolRegistry()
    register_document_tools(r)
    return r


@pytest.mark.asyncio
async def test_create_txt(registry, tmp_path):
    result = await registry.get("documents.create_txt").execute(
        path=str(tmp_path / "note.txt"), content="hello"
    )
    assert result.success
    assert (tmp_path / "note.txt").read_text() == "hello"


@pytest.mark.asyncio
async def test_create_markdown(registry, tmp_path):
    result = await registry.get("documents.create_markdown").execute(
        path=str(tmp_path / "note.md"), content="# Title"
    )
    assert result.success
    assert (tmp_path / "note.md").exists()


@pytest.mark.asyncio
async def test_create_csv(registry, tmp_path):
    result = await registry.get("documents.create_csv").execute(
        path=str(tmp_path / "data.csv"), rows=[["a", "b"], ["1", "2"]]
    )
    assert result.success
    content = (tmp_path / "data.csv").read_text()
    assert "a,b" in content
    assert "1,2" in content


@pytest.mark.asyncio
async def test_create_docx(registry, tmp_path):
    result = await registry.get("documents.create_docx").execute(
        path=str(tmp_path / "report.docx"), title="Report", paragraphs=["First para.", "Second para."]
    )
    assert result.success
    path = tmp_path / "report.docx"
    assert path.exists()
    assert path.stat().st_size > 0


@pytest.mark.asyncio
async def test_create_pptx(registry, tmp_path):
    result = await registry.get("documents.create_pptx").execute(
        path=str(tmp_path / "deck.pptx"),
        title="Climate Change",
        slides=[{"title": "Intro", "bullets": ["Point one", "Point two"]}],
    )
    assert result.success
    assert (tmp_path / "deck.pptx").stat().st_size > 0


@pytest.mark.asyncio
async def test_create_xlsx(registry, tmp_path):
    result = await registry.get("documents.create_xlsx").execute(
        path=str(tmp_path / "sheet.xlsx"), rows=[["Name", "Score"], ["Alice", 90]]
    )
    assert result.success
    assert (tmp_path / "sheet.xlsx").stat().st_size > 0


@pytest.mark.asyncio
async def test_create_pdf(registry, tmp_path):
    result = await registry.get("documents.create_pdf").execute(
        path=str(tmp_path / "doc.pdf"), title="Renewable Energy", paragraphs=["Solar is great."]
    )
    assert result.success
    path = tmp_path / "doc.pdf"
    assert path.exists()
    assert path.read_bytes()[:4] == b"%PDF"


@pytest.mark.asyncio
async def test_relative_path_resolves_under_workspace(registry, tmp_path):
    result = await registry.get("documents.create_txt").execute(path="relative.txt", content="hi")
    assert result.success
    assert (tmp_path / "workspace" / "relative.txt").exists()
