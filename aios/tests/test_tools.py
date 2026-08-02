"""Builtin tools doing real work against a real filesystem."""

from __future__ import annotations

import csv
import json

import pytest

from aios.foundation.errors import InvalidArguments, SandboxViolation
from aios.tools import default_registry
from aios.tools.builtin import data as data_tools
from aios.tools.builtin import docs as doc_tools
from aios.tools.builtin import fs as fs_tools
from aios.tools.builtin import shell as shell_tools


def tool(module, name):
    return next(t for t in module.tools() if t.name == name)


@pytest.fixture
def ws(tool_context):
    return tool_context.jail.root


class TestRegistry:
    def test_builtins_load(self):
        registry = default_registry()
        assert len(registry) > 40
        for name in ("fs.read", "fs.write", "shell.run", "data.query", "doc.report"):
            assert registry.has(name), name

    def test_every_tool_declares_a_usable_contract(self):
        for entry in default_registry().all():
            assert entry.summary, f"{entry.name} has no summary"
            assert entry.parameters.get("type") == "object", entry.name
            assert isinstance(entry.capabilities, frozenset), entry.name
            entry.spec()  # must not raise

    def test_write_tools_declare_write_capability(self):
        for entry in default_registry().all():
            if entry.name.endswith((".write", ".mkdir", ".edit")):
                assert any(c.startswith("fs.") for c in entry.capabilities), entry.name

    def test_unknown_tool_suggests_alternatives(self):
        registry = default_registry()
        with pytest.raises(Exception) as excinfo:
            registry.get("fs.raed")
        assert "fs.read" in str(excinfo.value.context["suggestions"])

    def test_alternatives_share_tags_and_never_escalate_risk(self):
        registry = default_registry()
        original = registry.get("fs.write")
        for candidate in registry.alternatives("fs.write"):
            assert set(candidate.tags) & set(original.tags)

    def test_catalog_is_filtered_by_grant(self):
        from aios.security.capabilities import CapabilitySet

        registry = default_registry()
        catalog = registry.catalog(CapabilitySet.readonly())
        assert "fs.read" in catalog
        assert "shell.run" not in catalog


class TestFilesystemTools:
    async def test_write_then_read_round_trip(self, tool_context, ws):
        await tool(fs_tools, "fs.write").run(
            {"path": "notes/hello.txt", "content": "hi there"}, tool_context
        )
        result = await tool(fs_tools, "fs.read").run({"path": "notes/hello.txt"}, tool_context)
        assert result.ok
        assert result.output["content"] == "hi there"
        assert (ws / "notes" / "hello.txt").exists()

    async def test_writes_are_atomic_leaving_no_temp_files(self, tool_context, ws):
        await tool(fs_tools, "fs.write").run({"path": "a.txt", "content": "x"}, tool_context)
        assert [p.name for p in ws.rglob("*.aios-tmp")] == []
        assert (ws / "a.txt").read_text() == "x"

    async def test_write_outside_the_workspace_is_refused(self, tool_context):
        result = await tool(fs_tools, "fs.write").run(
            {"path": "../escaped.txt", "content": "x"}, tool_context
        )
        assert not result.ok
        assert isinstance(result.error, SandboxViolation)

    async def test_create_mode_refuses_to_clobber(self, tool_context, ws):
        (ws / "exists.txt").write_text("original", encoding="utf-8")
        result = await tool(fs_tools, "fs.write").run(
            {"path": "exists.txt", "content": "new", "mode": "create"}, tool_context
        )
        assert not result.ok
        assert (ws / "exists.txt").read_text() == "original"

    async def test_edit_refuses_an_ambiguous_match(self, tool_context, ws):
        (ws / "code.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
        result = await tool(fs_tools, "fs.edit").run(
            {"path": "code.py", "find": "x = 1", "replace": "x = 2"}, tool_context
        )
        assert not result.ok
        assert "occurs 2 times" in result.error.message

    async def test_edit_replaces_all_when_asked(self, tool_context, ws):
        (ws / "code.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
        result = await tool(fs_tools, "fs.edit").run(
            {"path": "code.py", "find": "x = 1", "replace": "x = 2", "count": 0}, tool_context
        )
        assert result.ok and result.output["replacements"] == 2

    async def test_delete_is_recoverable_by_default(self, tool_context, ws):
        target = ws / "important.txt"
        target.write_text("valuable", encoding="utf-8")
        result = await tool(fs_tools, "fs.delete").run({"path": "important.txt"}, tool_context)
        assert result.ok and result.output["recoverable"]
        assert not target.exists()
        from pathlib import Path

        assert Path(result.output["trashed_to"]).read_text() == "valuable"

    async def test_delete_refuses_the_workspace_root(self, tool_context):
        result = await tool(fs_tools, "fs.delete").run({"path": "."}, tool_context)
        assert not result.ok

    async def test_search_finds_content_with_line_numbers(self, tool_context, ws):
        (ws / "a.py").write_text("import os\ndef handler():\n    pass\n", encoding="utf-8")
        (ws / "b.py").write_text("nothing here\n", encoding="utf-8")
        result = await tool(fs_tools, "fs.search").run(
            {"path": ".", "name_glob": "*.py", "contains": "def handler"}, tool_context
        )
        assert result.ok
        assert result.output["matches"][0] == {"path": "a.py", "line": 2, "text": "def handler():"}

    async def test_search_skips_vendored_directories(self, tool_context, ws):
        (ws / "node_modules").mkdir()
        (ws / "node_modules" / "lib.js").write_text("needle", encoding="utf-8")
        result = await tool(fs_tools, "fs.search").run(
            {"path": ".", "contains": "needle"}, tool_context
        )
        assert result.output["matches"] == []

    async def test_organize_previews_before_moving(self, tool_context, ws):
        for name in ("a.png", "b.csv", "c.mp4"):
            (ws / name).write_text("x", encoding="utf-8")
        preview = await tool(fs_tools, "fs.organize").run({"path": "."}, tool_context)
        assert preview.ok and preview.output["moved"] == 0
        assert (ws / "a.png").exists(), "preview must not move anything"

        applied = await tool(fs_tools, "fs.organize").run(
            {"path": ".", "apply": True}, tool_context
        )
        assert applied.output["moved"] == 3
        assert (ws / "images" / "a.png").exists()
        assert (ws / "spreadsheets" / "b.csv").exists()
        assert (ws / "video" / "c.mp4").exists()

    async def test_organize_preview_needs_no_write_capability(self, tool_context):
        action = tool(fs_tools, "fs.organize").plan_action({"path": ".", "apply": False})
        assert "fs.write" not in action.capabilities


class TestShellTools:
    async def test_command_output_is_captured(self, tool_context):
        result = await tool(shell_tools, "shell.run").run(
            {"command": "echo hello-from-shell"}, tool_context
        )
        assert result.ok
        assert "hello-from-shell" in result.output["stdout"]

    async def test_non_zero_exit_is_a_failure(self, tool_context):
        result = await tool(shell_tools, "shell.run").run({"command": "exit 3"}, tool_context)
        assert not result.ok
        assert result.error.context["exit_code"] == 3

    async def test_expect_success_false_tolerates_failure(self, tool_context):
        result = await tool(shell_tools, "shell.run").run(
            {"command": "exit 3", "expect_success": False}, tool_context
        )
        assert result.ok and result.output["exit_code"] == 3

    async def test_credentials_are_not_inherited_by_children(self, tool_context, monkeypatch):
        monkeypatch.setenv("MY_SECRET_TOKEN", "super-secret-value")
        result = await tool(shell_tools, "shell.run").run(
            {"command": "env"}, tool_context
        )
        assert "super-secret-value" not in result.output["stdout"]

    async def test_timeout_kills_the_process(self, tool_context):
        result = await tool(shell_tools, "shell.run").run(
            {"command": "sleep 30", "timeout": 1}, tool_context
        )
        assert not result.ok
        assert result.error.code == "tool_timeout"

    async def test_risky_command_is_flagged_before_execution(self):
        action = tool(shell_tools, "shell.run").plan_action({"command": "rm -rf build"})
        assert not action.reversible
        assert action.command == "rm -rf build"

    async def test_which_reports_missing_binaries(self, tool_context):
        result = await tool(shell_tools, "shell.which").run(
            {"binaries": ["python3", "definitely-not-a-real-binary"]}, tool_context
        )
        assert result.ok
        assert result.output["binaries"]["python3"]["available"]
        assert "definitely-not-a-real-binary" in result.output["missing"]

    async def test_system_info_reports_real_values(self, tool_context):
        result = await tool(shell_tools, "sys.info").run({}, tool_context)
        assert result.ok and result.output["cpu_count"] >= 1


class TestDataTools:
    @pytest.fixture
    def sales(self, ws):
        path = ws / "sales.csv"
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["region", "amount", "rep"])
            writer.writerows(
                [["north", "100", "ana"], ["south", "250", "bo"],
                 ["north", "75", "cy"], ["south", "300", "ana"]]
            )
        return path

    async def test_profile_reports_types_and_statistics(self, tool_context, sales):
        result = await tool(data_tools, "data.inspect").run({"path": "sales.csv"}, tool_context)
        assert result.ok
        columns = {c["name"]: c for c in result.output["columns"]}
        assert columns["amount"]["type"] == "integer"
        assert columns["amount"]["stats"]["max"] == 300
        assert columns["region"]["distinct"] == 2

    async def test_sql_aggregation_over_csv(self, tool_context, sales):
        result = await tool(data_tools, "data.query").run(
            {
                "sources": {"sales": "sales.csv"},
                "sql": "SELECT region, SUM(CAST(amount AS INTEGER)) AS total "
                       "FROM sales GROUP BY region ORDER BY total DESC",
            },
            tool_context,
        )
        assert result.ok
        assert result.output["rows"] == [
            {"region": "south", "total": 550},
            {"region": "north", "total": 175},
        ]

    async def test_sql_joins_across_files(self, tool_context, sales, ws):
        (ws / "reps.csv").write_text("rep,team\nana,alpha\nbo,beta\ncy,alpha\n", encoding="utf-8")
        result = await tool(data_tools, "data.query").run(
            {
                "sources": {"sales": "sales.csv", "reps": "reps.csv"},
                "sql": "SELECT r.team, COUNT(*) AS n FROM sales s "
                       "JOIN reps r ON r.rep = s.rep GROUP BY r.team ORDER BY r.team",
            },
            tool_context,
        )
        assert result.ok
        assert result.output["rows"] == [{"team": "alpha", "n": 3}, {"team": "beta", "n": 1}]

    async def test_writes_are_refused_by_the_query_tool(self, tool_context, sales):
        result = await tool(data_tools, "data.query").run(
            {"sources": {"sales": "sales.csv"}, "sql": "DELETE FROM sales"}, tool_context
        )
        assert not result.ok
        assert "read-only" in result.error.message

    async def test_bad_sql_reports_the_available_tables(self, tool_context, sales):
        result = await tool(data_tools, "data.query").run(
            {"sources": {"sales": "sales.csv"}, "sql": "SELECT * FROM nope"}, tool_context
        )
        assert not result.ok
        assert "sales" in json.dumps(result.error.context)

    async def test_query_can_save_results(self, tool_context, sales, ws):
        result = await tool(data_tools, "data.query").run(
            {"sources": {"sales": "sales.csv"}, "sql": "SELECT * FROM sales LIMIT 2",
             "output_csv": "out.csv"},
            tool_context,
        )
        assert result.ok and (ws / "out.csv").exists()
        assert len((ws / "out.csv").read_text().strip().splitlines()) == 3

    async def test_clean_removes_duplicates_and_empty_columns(self, tool_context, ws):
        (ws / "messy.csv").write_text(
            "name,empty,value\n a ,,1\n a ,,1\nb,,2\n", encoding="utf-8"
        )
        result = await tool(data_tools, "data.clean").run({"path": "messy.csv"}, tool_context)
        assert result.ok
        assert result.output["rows_removed"] == 1
        assert result.output["columns_removed"] == 1
        assert "empty" not in (ws / "messy.clean.csv").read_text()


class TestDocumentTools:
    def test_markdown_covers_the_common_constructs(self):
        html = doc_tools.markdown_to_html(
            "# Title\n\nSome **bold** and `code`.\n\n"
            "- one\n- two\n\n> quoted\n\n"
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n"
            "```python\nprint('hi')\n```\n"
        )
        for fragment in ("<h1", "<strong>bold</strong>", "<code>code</code>", "<ul>",
                         "<blockquote>", "<table>", "<pre><code"):
            assert fragment in html, fragment

    def test_html_in_markdown_is_escaped(self):
        html = doc_tools.markdown_to_html("A <script>alert(1)</script> tag")
        assert "<script>" not in html and "&lt;script&gt;" in html

    async def test_report_produces_markdown_and_html(self, tool_context, ws):
        result = await tool(doc_tools, "doc.report").run(
            {
                "output": "report.md",
                "title": "Quarterly review",
                "summary": "Revenue grew.",
                "sections": [{"heading": "Numbers", "table": [{"q": "Q1", "rev": 10}]}],
            },
            tool_context,
        )
        assert result.ok
        assert "Quarterly review" in (ws / "report.md").read_text()
        assert "<table>" in (ws / "report.html").read_text()

    async def test_presentation_is_self_contained(self, tool_context, ws):
        result = await tool(doc_tools, "doc.presentation").run(
            {
                "output": "deck.html",
                "title": "Launch plan",
                "slides": [
                    {"heading": "Why now", "bullets": ["Market timing", "Team is ready"]},
                    {"heading": "The ask", "body": "Two engineers for six weeks."},
                ],
            },
            tool_context,
        )
        assert result.ok and result.output["slides"] == 3
        page = (ws / "deck.html").read_text()
        assert "src=" not in page.replace('src="', "SRC_ATTR"), "no external resources"
        assert "<style>" in page and "<script>" in page
        assert "Market timing" in page

    async def test_extract_reads_html_as_text(self, tool_context, ws):
        (ws / "page.html").write_text(
            "<html><head><title>T</title><style>x{}</style></head>"
            "<body><p>Visible text</p><script>hidden()</script></body></html>",
            encoding="utf-8",
        )
        result = await tool(doc_tools, "doc.extract").run({"path": "page.html"}, tool_context)
        assert "Visible text" in result.output["text"]
        assert "hidden()" not in result.output["text"]


class TestToolContract:
    async def test_invalid_arguments_never_raise_out_of_run(self, tool_context):
        result = await tool(fs_tools, "fs.read").run({}, tool_context)
        assert not result.ok
        assert isinstance(result.error, InvalidArguments)
        assert "missing required property" in result.error.message

    async def test_arguments_are_coerced_before_execution(self, tool_context, ws):
        (ws / "f.txt").write_text("a\nb\nc\n", encoding="utf-8")
        result = await tool(fs_tools, "fs.read").run(
            {"path": "f.txt", "max_lines": "2"}, tool_context
        )
        assert result.ok and result.output["returned_lines"] == 2

    async def test_dry_run_makes_no_changes(self, tool_context, ws):
        tool_context.dry_run = True
        result = await tool(fs_tools, "fs.write").run(
            {"path": "should-not-exist.txt", "content": "x"}, tool_context
        )
        assert result.ok and result.output["dry_run"]
        assert not (ws / "should-not-exist.txt").exists()

    async def test_tool_invocations_are_recorded_on_the_bus(self, tool_context, recorder):
        await tool(fs_tools, "fs.list").run({"path": "."}, tool_context)
        assert recorder.of("tool.invoked") and recorder.of("tool.returned")

    async def test_duration_is_always_reported(self, tool_context):
        result = await tool(fs_tools, "fs.list").run({"path": "."}, tool_context)
        assert "duration_s" in result.metrics
