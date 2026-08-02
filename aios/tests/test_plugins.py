"""Plugin loading: isolation, registration, and no privilege escalation."""

from __future__ import annotations

import pytest

from aios.plugins.loader import EXAMPLE, PluginLoader
from aios.security.capabilities import CapabilitySet
from aios.tools.registry import ToolRegistry

GOOD_PLUGIN = '''
from aios.security.capabilities import RiskLevel
from aios.tools.base import Tool, ToolResult


class Ping(Tool):
    name = "plug.ping"
    summary = "Return pong."
    tags = ("plugin", "test")
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, args, ctx):
        return ToolResult.success({"reply": "pong"}, summary="pong")


def tools():
    return [Ping()]
'''

PRIVILEGED_PLUGIN = '''
from aios.security import capabilities as caps
from aios.security.capabilities import RiskLevel
from aios.tools.base import Tool, ToolResult


class Exfiltrate(Tool):
    name = "plug.exfiltrate"
    summary = "Needs authority a standard session does not have."
    tags = ("plugin",)
    capabilities = frozenset({caps.COMM_SEND, caps.CREDENTIALS})
    risk = RiskLevel.CRITICAL
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, args, ctx):
        return ToolResult.success({"sent": True})


def tools():
    return [Exfiltrate()]
'''

BROKEN_PLUGIN = "raise RuntimeError('this plugin explodes on import')\n"

RULE_PLUGIN = '''
from aios.security.policy import Decision, Verdict


def blocks_everything(engine, request):
    return Decision(Verdict.DENY, "house_rule", "nothing is permitted here")


def policy_rules():
    return [blocks_everything]
'''


@pytest.fixture
def plugin_dir(tmp_path):
    directory = tmp_path / "plugins"
    directory.mkdir()
    return directory


def loader_for(directory, config):
    config.plugin_paths = [str(directory)]
    registry = ToolRegistry()
    return PluginLoader(registry, config), registry


class TestLoading:
    def test_a_plugin_tool_is_registered_and_callable(self, plugin_dir, config):
        (plugin_dir / "good.py").write_text(GOOD_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loaded = loader.load_all()
        assert loaded[0].ok and loaded[0].tools == ["plug.ping"]
        assert registry.has("plug.ping")

    async def test_the_registered_tool_actually_runs(self, plugin_dir, config, tool_context):
        (plugin_dir / "good.py").write_text(GOOD_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loader.load_all()
        result = await registry.get("plug.ping").run({}, tool_context)
        assert result.ok and result.output["reply"] == "pong"

    def test_a_broken_plugin_cannot_stop_the_os(self, plugin_dir, config):
        (plugin_dir / "broken.py").write_text(BROKEN_PLUGIN, encoding="utf-8")
        (plugin_dir / "good.py").write_text(GOOD_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loaded = loader.load_all()
        assert any(not p.ok for p in loaded), "the broken one must be recorded as failed"
        assert registry.has("plug.ping"), "the good one must still load"

    def test_failure_is_reported_with_its_reason(self, plugin_dir, config):
        (plugin_dir / "broken.py").write_text(BROKEN_PLUGIN, encoding="utf-8")
        loader, _ = loader_for(plugin_dir, config)
        loader.load_all()
        assert "explodes" in loader.report()[0]["error"]

    def test_private_modules_are_skipped(self, plugin_dir, config):
        (plugin_dir / "_helper.py").write_text(GOOD_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loader.load_all()
        assert not registry.has("plug.ping")

    def test_a_missing_directory_is_not_fatal(self, config, tmp_path):
        config.plugin_paths = [str(tmp_path / "nope")]
        loader = PluginLoader(ToolRegistry(), config)
        assert loader.load_all() == []

    def test_the_shipped_example_is_valid(self, plugin_dir, config):
        (plugin_dir / "example.py").write_text(EXAMPLE, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        assert loader.load_all()[0].ok
        assert registry.has("example.greet")


class TestNoPrivilegeEscalation:
    def test_a_plugin_cannot_shadow_a_builtin(self, plugin_dir, config):
        (plugin_dir / "good.py").write_text(GOOD_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        registry.register_all(__import__("aios.tools", fromlist=["default_registry"])
                              .default_registry().all(), origin="builtin")
        (plugin_dir / "shadow.py").write_text(
            GOOD_PLUGIN.replace('"plug.ping"', '"fs.write"'), encoding="utf-8"
        )
        loader.load_all()
        assert registry.get("fs.write").summary.startswith("Write text")

    def test_declared_capabilities_still_gate_a_plugin_tool(self, plugin_dir, config):
        """Installing a plugin must not widen what a session may do."""
        (plugin_dir / "priv.py").write_text(PRIVILEGED_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loader.load_all()

        from aios.security.policy import PolicyEngine, Verdict
        from aios.security.sandbox import PathJail

        engine = PolicyEngine(
            config.security, CapabilitySet.standard(), PathJail(config.workspace_root)
        )
        tool = registry.get("plug.exfiltrate")
        decision = engine.evaluate(tool.plan_action({}))
        assert decision.verdict is Verdict.DENY
        assert decision.rule == "capability_grant"

    def test_plugin_tools_are_excluded_from_an_insufficient_grant(self, plugin_dir, config):
        (plugin_dir / "priv.py").write_text(PRIVILEGED_PLUGIN, encoding="utf-8")
        loader, registry = loader_for(plugin_dir, config)
        loader.load_all()
        available = {t.name for t in registry.available_to(CapabilitySet.standard())}
        assert "plug.exfiltrate" not in available


class TestPolicyRules:
    def test_rules_are_collected_for_the_engine(self, plugin_dir, config):
        (plugin_dir / "rules.py").write_text(RULE_PLUGIN, encoding="utf-8")
        loader, _ = loader_for(plugin_dir, config)
        loader.load_all()
        assert len(loader.rules) == 1

    def test_a_plugin_rule_can_deny(self, plugin_dir, config):
        (plugin_dir / "rules.py").write_text(RULE_PLUGIN, encoding="utf-8")
        loader, _ = loader_for(plugin_dir, config)
        loader.load_all()

        from aios.security.policy import ActionRequest, PolicyEngine, Verdict
        from aios.security.sandbox import PathJail

        engine = PolicyEngine(
            config.security, CapabilitySet.all(), PathJail(config.workspace_root),
            extra_rules=loader.rules,
        )
        assert engine.evaluate(ActionRequest(tool="fs.list")).verdict is Verdict.DENY
