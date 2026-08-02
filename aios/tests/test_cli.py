"""CLI surface: argument wiring, exit codes, and the subcommands."""

from __future__ import annotations

import json

import pytest

from aios.foundation.errors import AiosError
from aios.interfaces import cli
from aios.security.capabilities import CapabilitySet


class TestParser:
    def test_run_requires_a_goal(self):
        with pytest.raises(SystemExit):
            cli.build_parser().parse_args(["run"])

    def test_multiword_goals_are_joined(self):
        args = cli.build_parser().parse_args(["run", "build", "a", "site"])
        assert " ".join(args.goal) == "build a site"

    def test_flags_reach_the_config(self, tmp_path):
        args = cli.build_parser().parse_args(
            ["-w", str(tmp_path), "run", "goal", "--max-parallel", "8",
             "--budget-usd", "3.5", "--security", "strict"]
        )
        config = cli._config_for(args)
        assert config.execution.max_parallel == 8
        assert config.budget.max_usd == 3.5
        assert config.security.mode == "strict"
        assert config.workspace_root == tmp_path.resolve()

    def test_yes_switches_approval_mode(self, tmp_path):
        args = cli.build_parser().parse_args(["-w", str(tmp_path), "run", "goal", "-y"])
        assert cli._config_for(args).security.approval_mode == "auto"


class TestCapabilityGrants:
    def test_default_grant_withholds_publishing(self, tmp_path):
        args = cli.build_parser().parse_args(["run", "goal"])
        assert not cli._grant_for(args).has("publish")

    def test_allow_widens_the_grant(self):
        args = cli.build_parser().parse_args(["run", "goal", "--allow", "publish"])
        assert cli._grant_for(args).has("publish")

    def test_allow_all_grants_everything(self):
        args = cli.build_parser().parse_args(["run", "goal", "--allow", "all"])
        assert cli._grant_for(args).granted == CapabilitySet.all().granted

    def test_unknown_capability_is_rejected(self):
        args = cli.build_parser().parse_args(["run", "goal", "--allow", "telepathy"])
        with pytest.raises(AiosError, match="unknown capability"):
            cli._grant_for(args)

    def test_prefix_allow_expands_to_members(self):
        args = cli.build_parser().parse_args(["run", "goal", "--allow", "fs"])
        assert cli._grant_for(args).has("fs.outside_workspace")


class TestCommands:
    def test_tools_listing(self, capsys):
        assert cli.main(["tools"]) == cli.EXIT_OK
        out = capsys.readouterr().out
        assert "fs.write" in out and "data.query" in out

    def test_tools_json_is_machine_readable(self, capsys):
        cli.main(["tools", "--json"])
        payload = json.loads(capsys.readouterr().out)
        names = {t["name"] for t in payload}
        assert "shell.run" in names
        entry = next(t for t in payload if t["name"] == "git.push")
        assert entry["risk"] == "HIGH" and "publish" in entry["capabilities"]

    def test_tools_filtered_by_tag(self, capsys):
        cli.main(["tools", "--tag", "media", "--json"])
        payload = json.loads(capsys.readouterr().out)
        assert payload and all("media" in t["tags"] for t in payload)

    def test_doctor_reports_environment(self, tmp_path, capsys):
        assert cli.main(["-w", str(tmp_path), "doctor"]) == cli.EXIT_OK
        out = capsys.readouterr().out
        assert "checks passed" in out
        assert "tools registered" in out

    def test_plan_prints_a_grounded_plan(self, tmp_path, capsys):
        assert cli.main(["-w", str(tmp_path), "plan", "organise this folder"]) == cli.EXIT_OK
        out = capsys.readouterr().out
        assert "Wave 1" in out
        assert "grounding: ok" in out

    def test_plan_json_round_trips(self, tmp_path, capsys):
        cli.main(["-w", str(tmp_path), "plan", "organise this folder", "--json"])
        payload = json.loads(capsys.readouterr().out)
        assert payload["plan"]["steps"]
        assert payload["intent"]["domain"]

    def test_runs_is_empty_before_any_run(self, tmp_path, capsys):
        assert cli.main(["-w", str(tmp_path), "runs"]) == cli.EXIT_OK
        assert "no runs recorded" in capsys.readouterr().out

    def test_memory_add_and_recall(self, tmp_path, capsys):
        cli.main(["-w", str(tmp_path), "memory", "add", "always", "use", "tabs"])
        capsys.readouterr()
        cli.main(["-w", str(tmp_path), "memory", "recall", "tabs"])
        assert "use tabs" in capsys.readouterr().out

    def test_memory_refuses_to_store_a_secret(self, tmp_path, capsys):
        cli.main(["-w", str(tmp_path), "memory", "add",
                  "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz01"])
        assert "refused" in capsys.readouterr().out

    def test_replay_of_a_missing_run_is_a_usage_error(self, tmp_path, capsys):
        assert cli.main(["-w", str(tmp_path), "replay", "run_nope"]) == cli.EXIT_USAGE


class TestEndToEndCli:
    def test_a_run_produces_files_and_exits_zero(self, tmp_path, capsys):
        code = cli.main([
            "-w", str(tmp_path), "--log-level", "ERROR",
            "run", "organise this workspace and report on storage", "-y",
        ])
        assert code in {cli.EXIT_OK, cli.EXIT_PARTIAL}
        assert (tmp_path / "maintenance-report.md").exists()

    def test_dry_run_changes_nothing_on_disk(self, tmp_path):
        cli.main([
            "-w", str(tmp_path), "--log-level", "ERROR",
            "run", "organise this workspace and report on storage", "--dry-run", "-y",
        ])
        assert not (tmp_path / "maintenance-report.md").exists()

    def test_json_output_is_parseable(self, tmp_path, capsys):
        cli.main([
            "-w", str(tmp_path), "--log-level", "ERROR",
            "run", "organise this workspace and report on storage", "-y", "--json",
        ])
        payload = json.loads(capsys.readouterr().out)
        assert payload["status"] in {"succeeded", "partial", "failed"}
        assert payload["run_id"].startswith("run_")

    def test_reports_are_written_when_requested(self, tmp_path):
        cli.main([
            "-w", str(tmp_path), "--log-level", "ERROR",
            "run", "organise this workspace and report on storage",
            "-y", "--report", str(tmp_path / "reports"),
        ])
        assert list((tmp_path / "reports").glob("report-*.html"))

    def test_a_completed_run_appears_in_history(self, tmp_path, capsys):
        cli.main(["-w", str(tmp_path), "--log-level", "ERROR",
                  "run", "organise this workspace and report on storage", "-y"])
        capsys.readouterr()
        cli.main(["-w", str(tmp_path), "runs"])
        assert "organise this workspace" in capsys.readouterr().out
