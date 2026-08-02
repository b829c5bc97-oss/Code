"""Intent understanding and planner grounding."""

from __future__ import annotations

import pytest
from conftest import scripted

from aios.cognition.intent import IntentResolver
from aios.cognition.planner import HeuristicPlanner, Planner
from aios.foundation.errors import PlanError
from aios.security.capabilities import CapabilitySet
from aios.tools import default_registry


class TestHeuristicIntent:
    @pytest.mark.parametrize(
        ("goal", "domain"),
        [
            ("organise this workspace and report on storage", "system"),
            ("free up space on the disk", "system"),
            ("build a landing page for a bakery", "web"),
            ("analyse sales.csv and chart revenue by region", "data"),
            ("remove silence from interview.mp4 and add subtitles", "media"),
            ("find and fix the failing test in the auth module", "software"),
            ("research competitors and write a summary", "research"),
            ("write a project proposal document", "document"),
            ("automate the weekly invoice workflow", "automation"),
        ],
    )
    def test_domains_are_classified_by_weight_not_first_match(self, goal, domain):
        """A format word like "report" must not outrank a domain word."""
        assert IntentResolver.heuristic(goal).domain == domain

    def test_multiword_signals_outweigh_incidental_ones(self):
        # "report" (document) vs "free up space" (system, multi-word)
        assert IntentResolver.heuristic("free up space and report on it").domain == "system"

    @pytest.mark.parametrize(
        ("goal", "complexity"),
        [
            ("list the files", "simple"),
            ("read the config, update the version, and rebuild the docs", "moderate"),
            ("scrape the catalogue, then clean the data, then load it into the warehouse, "
             "then build a dashboard, and also email the team a summary", "complex"),
        ],
    )
    def test_complexity_tracks_scope(self, goal, complexity):
        assert IntentResolver.heuristic(goal).complexity == complexity

    @pytest.mark.parametrize(
        ("goal", "expected"),
        [
            ("email the report to the team", "sending email or messages"),
            ("deploy the site to production", "publishing publicly"),
            ("delete the old backups", "deleting files"),
            ("pay the outstanding invoice", "financial transactions"),
        ],
    )
    def test_sensitive_actions_are_flagged(self, goal, expected):
        assert expected in IntentResolver.heuristic(goal).sensitive_actions

    def test_named_files_become_deliverables(self):
        intent = IntentResolver.heuristic("turn notes.md into slides.pptx")
        assert "notes.md" in intent.deliverables and "slides.pptx" in intent.deliverables

    def test_heuristics_declare_their_own_limits(self):
        intent = IntentResolver.heuristic("do something")
        assert intent.source == "heuristic"
        assert any("without model" in a for a in intent.assumptions)

    def test_empty_goal_is_rejected(self):
        with pytest.raises(ValueError, match="empty"):
            import asyncio

            asyncio.run(IntentResolver(None).resolve("   "))


class TestModelIntent:
    async def test_model_output_is_used_when_available(self):
        model = scripted({
            "restated": "Create a bakery landing page",
            "domain": "web",
            "complexity": "moderate",
            "deliverables": ["site/index.html"],
            "success_criteria": ["site/index.html exists"],
            "sensitive_actions": [],
        })
        intent = await IntentResolver(model).resolve("bakery site")
        assert intent.source == "model"
        assert intent.deliverables == ["site/index.html"]

    async def test_a_broken_model_falls_back_silently(self):
        model = scripted("not json", "still not json", "nope")
        intent = await IntentResolver(model).resolve("organise the downloads folder")
        assert intent.source == "heuristic"
        assert intent.domain == "system"


class TestHeuristicPlanner:
    @pytest.fixture
    def registry(self):
        return default_registry()

    @pytest.mark.parametrize(
        "goal",
        [
            "organise this workspace",
            "build a landing page",
            "analyse the sales data",
            "write a report about the project",
            "research the competition",
            "fix the failing tests",
        ],
    )
    def test_every_domain_produces_a_runnable_plan(self, registry, goal):
        intent = IntentResolver.heuristic(goal)
        plan = HeuristicPlanner().plan(intent, registry, CapabilitySet.standard())
        plan.validate()
        assert plan.steps
        assert all(registry.has(s.tool) for s in plan.steps)

    def test_plans_stay_inside_the_grant(self, registry):
        intent = IntentResolver.heuristic("fix the failing tests")
        plan = HeuristicPlanner().plan(intent, registry, CapabilitySet.readonly())
        grant = CapabilitySet.readonly()
        for step in plan.steps:
            assert not grant.missing(registry.get(step.tool).capabilities)

    def test_an_impossible_grant_is_reported(self, registry):
        intent = IntentResolver.heuristic("do anything at all")
        with pytest.raises(PlanError, match="no builtin tool"):
            HeuristicPlanner().plan(intent, registry, CapabilitySet.of())

    def test_web_plans_use_a_slug_not_a_prose_deliverable(self, registry):
        intent = IntentResolver.heuristic("build a landing page for Flour and Time")
        plan = HeuristicPlanner().plan(intent, registry, CapabilitySet.standard())
        scaffold = next(s for s in plan.steps if s.tool == "code.scaffold")
        assert " " not in scaffold.arguments["name"]


class TestGrounding:
    @pytest.fixture
    def planner(self):
        return Planner(None, default_registry())

    def test_unknown_tools_are_caught_with_suggestions(self, planner):
        from aios.cognition.plan import Plan, Step

        plan = Plan(goal="x", steps=[Step(name="a", tool="fs.wrte", arguments={})])
        errors = planner.ground(plan, CapabilitySet.standard())
        assert any("fs.write" in e for e in errors)

    def test_bad_arguments_are_caught_before_execution(self, planner):
        from aios.cognition.plan import Plan, Step

        plan = Plan(goal="x", steps=[Step(name="a", tool="fs.write", arguments={"path": "a.txt"})])
        errors = planner.ground(plan, CapabilitySet.standard())
        assert any("content" in e for e in errors)

    def test_unresolved_references_are_not_treated_as_missing(self, planner):
        from aios.cognition.plan import Plan, Step

        plan = Plan(
            goal="x",
            steps=[
                Step(name="a", tool="fs.write", binding="a",
                     arguments={"path": "a.txt", "content": "hi"}),
                Step(name="b", tool="fs.write", binding="b",
                     arguments={"path": "b.txt", "content": "${a.path}"}),
            ],
        )
        assert planner.ground(plan, CapabilitySet.standard()) == []

    def test_ungranted_capabilities_are_caught(self, planner):
        from aios.cognition.plan import Plan, Step

        plan = Plan(goal="x", steps=[Step(name="a", tool="git.push", arguments={})])
        errors = planner.ground(plan, CapabilitySet.standard())
        assert any("publish" in e for e in errors)

    def test_duplicate_step_ids_are_caught(self, planner):
        from aios.cognition.plan import Plan, Step

        step = {"tool": "fs.list", "arguments": {}}
        plan = Plan(goal="x", steps=[Step(name="a", binding="dup", **step),
                                     Step(name="b", binding="dup", **step)])
        assert any("duplicate" in e for e in planner.ground(plan, CapabilitySet.standard()))
