"""Plan graph semantics: dependencies, ordering, cycles, references."""

from __future__ import annotations

import pytest

from aios.cognition.plan import Check, Plan, Step, StepState, resolve_references
from aios.foundation.errors import CyclicPlan, PlanError


def s(name: str, *, depends_on=None, priority=0, **args) -> Step:
    return Step(name=name, tool="test.record", binding=name,
                depends_on=depends_on or [], priority=priority, arguments=args)


class TestValidation:
    def test_empty_plan_is_rejected(self):
        with pytest.raises(PlanError, match="no steps"):
            Plan(goal="x").validate()

    def test_unknown_dependency_is_rejected(self):
        plan = Plan(goal="x", steps=[s("a", depends_on=["ghost"])])
        with pytest.raises(PlanError, match="unknown step"):
            plan.validate()

    def test_cycles_are_detected(self):
        a, b, c = s("a"), s("b"), s("c")
        a.depends_on = ["c"]
        b.depends_on = ["a"]
        c.depends_on = ["b"]
        plan = Plan(goal="x", steps=[a, b, c]).normalize()
        with pytest.raises(CyclicPlan) as excinfo:
            plan.validate()
        assert "steps_in_cycle" in excinfo.value.context

    def test_self_dependency_is_a_cycle(self):
        a = s("a")
        a.depends_on = ["a"]
        with pytest.raises(CyclicPlan):
            Plan(goal="x", steps=[a]).normalize().validate()

    def test_step_without_a_tool_is_rejected(self):
        plan = Plan(goal="x", steps=[Step(name="a", tool="")])
        with pytest.raises(PlanError, match="no tool"):
            plan.validate()

    def test_unknown_reference_is_rejected(self):
        plan = Plan(goal="x", steps=[s("a", path="${nope.value}")])
        with pytest.raises(PlanError, match="unknown binding"):
            plan.validate()


class TestNormalization:
    def test_references_create_implicit_dependencies(self):
        plan = Plan(goal="x", steps=[s("build"), s("deploy", path="${build.value}")]).normalize()
        deploy = plan.by_id("deploy")
        assert plan.by_id("build").id in deploy.depends_on

    def test_normalization_is_idempotent(self):
        plan = Plan(goal="x", steps=[s("a"), s("b", path="${a.value}")])
        first = plan.normalize().by_id("b").depends_on[:]
        assert plan.normalize().by_id("b").depends_on == first

    def test_binding_names_are_rewritten_to_ids(self):
        plan = Plan(goal="x", steps=[s("a"), s("b", depends_on=["a"])]).normalize()
        assert plan.by_id("b").depends_on == [plan.by_id("a").id]


class TestOrdering:
    def test_topological_order_respects_dependencies(self):
        plan = Plan(
            goal="x",
            steps=[s("c", depends_on=["b"]), s("a"), s("b", depends_on=["a"])],
        ).normalize()
        assert [step.name for step in plan.topological_order()] == ["a", "b", "c"]

    def test_priority_breaks_ties_deterministically(self):
        plan = Plan(goal="x", steps=[s("low"), s("high", priority=10)]).normalize()
        assert plan.topological_order()[0].name == "high"

    def test_ordering_is_stable_across_runs(self):
        steps = [s("a"), s("b"), s("c"), s("d", depends_on=["a", "b"])]
        first = [x.name for x in Plan(goal="x", steps=steps).normalize().topological_order()]
        second = [x.name for x in Plan(goal="x", steps=steps).normalize().topological_order()]
        assert first == second

    def test_levels_group_parallel_work(self):
        plan = Plan(
            goal="x",
            steps=[s("a"), s("b"), s("c", depends_on=["a", "b"])],
        ).normalize()
        waves = plan.levels()
        assert {step.name for step in waves[0]} == {"a", "b"}
        assert [step.name for step in waves[1]] == ["c"]

    def test_critical_path_follows_the_longest_chain(self):
        plan = Plan(
            goal="x",
            steps=[s("a"), s("b", depends_on=["a"]), s("c", depends_on=["b"]), s("side")],
        ).normalize()
        assert [step.name for step in plan.critical_path()] == ["a", "b", "c"]


class TestDependents:
    def test_transitive_dependents_are_found(self):
        plan = Plan(
            goal="x",
            steps=[s("a"), s("b", depends_on=["a"]), s("c", depends_on=["b"]), s("unrelated")],
        ).normalize()
        names = {step.name for step in plan.dependents(plan.by_id("a").id)}
        assert names == {"b", "c"}

    def test_unrelated_branches_are_untouched(self):
        plan = Plan(goal="x", steps=[s("a"), s("b")]).normalize()
        assert plan.dependents(plan.by_id("a").id) == []


class TestReferenceResolution:
    BINDINGS = {
        "build": {"path": "dist/app.js", "size": 1024, "ok": True,
                  "files": ["a.js", "b.js"], "meta": {"hash": "abc"}},
    }

    def test_whole_string_reference_keeps_its_type(self):
        assert resolve_references("${build.size}", self.BINDINGS) == 1024
        assert resolve_references("${build.ok}", self.BINDINGS) is True

    def test_embedded_reference_interpolates_as_text(self):
        assert resolve_references(
            "built ${build.path} ok", self.BINDINGS
        ) == "built dist/app.js ok"

    def test_nested_and_indexed_paths(self):
        assert resolve_references("${build.meta.hash}", self.BINDINGS) == "abc"
        assert resolve_references("${build.files[1]}", self.BINDINGS) == "b.js"

    def test_resolution_descends_into_containers(self):
        resolved = resolve_references(
            {"args": ["--in", "${build.path}"], "n": "${build.size}"}, self.BINDINGS
        )
        assert resolved == {"args": ["--in", "dist/app.js"], "n": 1024}

    def test_missing_field_names_what_was_available(self):
        with pytest.raises(PlanError) as excinfo:
            resolve_references("${build.missing}", self.BINDINGS)
        assert "available" in excinfo.value.context

    def test_index_out_of_range_is_reported(self):
        with pytest.raises(PlanError, match="out of range"):
            resolve_references("${build.files[9]}", self.BINDINGS)

    def test_values_without_references_pass_through(self):
        assert resolve_references({"a": 1, "b": [None, True]}, {}) == {"a": 1, "b": [None, True]}


class TestSerialization:
    def test_round_trip_preserves_structure(self):
        original = Plan(
            goal="ship it",
            steps=[s("a"), s("b", depends_on=["a"])],
            strategy="do a then b",
            risks=["might fail"],
        ).normalize()
        restored = Plan.from_dict(original.to_dict())
        assert restored.goal == original.goal
        assert [x.name for x in restored.steps] == [x.name for x in original.steps]
        assert restored.strategy == original.strategy

    def test_checks_survive_serialization(self):
        step = s("a")
        step.verify = [Check("file_exists", "out.txt"), Check("file_contains", "out.txt", "hi")]
        restored = Plan.from_dict(Plan(goal="x", steps=[step]).to_dict())
        assert [c.kind for c in restored.steps[0].verify] == ["file_exists", "file_contains"]

    def test_render_marks_state(self):
        plan = Plan(goal="x", steps=[s("a")]).normalize()
        plan.steps[0].state = StepState.SUCCEEDED
        assert "✔" in plan.render()


class TestCounters:
    def test_optional_failure_still_counts_as_success(self):
        step = s("a")
        step.optional = True
        step.state = StepState.FAILED
        assert Plan(goal="x", steps=[step]).succeeded

    def test_required_failure_fails_the_plan(self):
        step = s("a")
        step.state = StepState.FAILED
        assert not Plan(goal="x", steps=[step]).succeeded

    def test_terminal_states_are_classified(self):
        assert StepState.SUCCEEDED.terminal and StepState.BLOCKED.terminal
        assert not StepState.RUNNING.terminal and not StepState.PENDING.terminal
