"""Runtime layer: event bus, ledger durability, artifact store, budgets."""

from __future__ import annotations

import asyncio
import json

import pytest

from aios.foundation.errors import BudgetExceeded
from aios.runtime.artifacts import ArtifactStore
from aios.runtime.budget import Budget, Usage, estimate_cost
from aios.runtime.events import Recorder, Topic
from aios.runtime.ledger import Ledger


class TestEventBus:
    async def test_glob_subscriptions(self, bus):
        seen = []
        bus.subscribe("step.*", lambda e: seen.append(e.topic))
        await bus.publish("step.started", {})
        await bus.publish("run.started", {})
        await bus.publish("step.failed", {})
        assert seen == ["step.started", "step.failed"]

    async def test_sync_and_async_handlers_both_work(self, bus):
        seen = []

        async def async_handler(event):
            seen.append("async")

        bus.subscribe("*", lambda e: seen.append("sync"))
        bus.subscribe("*", async_handler)
        await bus.publish("x", {})
        assert set(seen) == {"sync", "async"}

    async def test_handlers_run_in_subscription_order(self, bus):
        order = []
        bus.subscribe("*", lambda e: order.append(1))
        bus.subscribe("*", lambda e: order.append(2))
        await bus.publish("x", {})
        assert order == [1, 2]

    async def test_a_raising_handler_is_isolated(self, bus):
        seen = []

        def bad(event):
            raise RuntimeError("boom")

        bus.subscribe("*", bad)
        bus.subscribe("*", lambda e: seen.append(e.topic))
        await bus.publish("x", {})
        assert seen == ["x"]

    async def test_sequence_numbers_are_monotonic_under_concurrency(self, bus):
        recorder = Recorder(bus)
        await asyncio.gather(*[bus.publish(f"t{i}", {}) for i in range(50)])
        sequences = [e.seq for e in recorder.events]
        assert sorted(sequences) == list(range(1, 51))

    async def test_unsubscribe_stops_delivery(self, bus):
        seen = []
        token = bus.subscribe("*", lambda e: seen.append(e))
        await bus.publish("a", {})
        assert bus.unsubscribe(token)
        await bus.publish("b", {})
        assert len(seen) == 1

    async def test_event_payloads_are_redacted_on_serialization(self, bus):
        recorder = Recorder(bus)
        await bus.publish("x", {"api_key": "sk-ant-abcdefghijklmnopqrstuvwxyz0123"})
        serialized = json.dumps(recorder.events[0].to_dict())
        assert "abcdefghijklmnop" not in serialized


class TestLedger:
    def test_events_round_trip(self, tmp_path, bus):
        path = tmp_path / "run.jsonl"
        ledger = Ledger(path)
        ledger.record("run.started", {"goal": "x"}, run_id="run_1")
        ledger.record("step.succeeded", {"name": "a"}, run_id="run_1", step_id="stp_1")
        ledger.close()
        events = list(Ledger.read(path))
        assert [e.topic for e in events] == ["run.started", "step.succeeded"]
        assert events[1].step_id == "stp_1"

    def test_a_torn_final_line_is_dropped_not_fatal(self, tmp_path):
        path = tmp_path / "run.jsonl"
        ledger = Ledger(path)
        ledger.record("run.started", {"goal": "x"})
        ledger.close()
        with path.open("a", encoding="utf-8") as fh:
            fh.write('{"topic": "step.started", "data": {"na')
        events = list(Ledger.read(path))
        assert len(events) == 1

    def test_secrets_never_reach_disk(self, tmp_path):
        path = tmp_path / "run.jsonl"
        ledger = Ledger(path)
        ledger.record("tool.invoked", {"args": {"token": "ghp_abcdefghijklmnopqrstuvwxyz01234"}})
        ledger.close()
        assert "ghp_abcdefghijklmnop" not in path.read_text()

    def test_durable_topics_are_flushed_immediately(self, tmp_path):
        path = tmp_path / "run.jsonl"
        ledger = Ledger(path)
        ledger.record("approval.granted", {"tool": "git.push"})
        # No close(): a hard kill here must still leave the approval on disk.
        assert "approval.granted" in path.read_text()
        ledger.close()

    async def test_bus_attachment_mirrors_everything(self, tmp_path, bus):
        ledger = Ledger(tmp_path / "run.jsonl")
        ledger.attach(bus)
        await bus.publish(Topic.RUN_STARTED, {"goal": "x"})
        await bus.publish(Topic.STEP_STARTED, {"name": "a"})
        ledger.close()
        assert len(list(Ledger.read(ledger.path))) == 2

    def test_summarize_counts_topics(self, tmp_path):
        ledger = Ledger(tmp_path / "run.jsonl")
        for _ in range(3):
            ledger.record("step.succeeded", {})
        ledger.record("run.completed", {})
        ledger.close()
        summary = Ledger.summarize(ledger.path)
        assert summary["events"] == 4
        assert summary["topics"]["step.succeeded"] == 3

    def test_reading_a_missing_ledger_is_empty_not_an_error(self, tmp_path):
        assert list(Ledger.read(tmp_path / "nope.jsonl")) == []


class TestArtifactStore:
    def test_identical_content_is_stored_once(self, tmp_path):
        store = ArtifactStore(tmp_path / "blobs")
        a = store.put_text("a.txt", "same content")
        b = store.put_text("b.txt", "same content")
        assert a.sha256 == b.sha256
        assert a.id != b.id
        assert a.path == b.path, "identical bytes must share one blob"

    def test_files_are_copied_and_immutable(self, tmp_path):
        source = tmp_path / "source.txt"
        source.write_text("v1", encoding="utf-8")
        store = ArtifactStore(tmp_path / "blobs")
        artifact = store.put_file(source)
        source.write_text("v2 — mutated after capture", encoding="utf-8")
        assert artifact.read_text() == "v1"

    def test_large_files_are_referenced_not_copied(self, tmp_path):
        source = tmp_path / "big.bin"
        source.write_bytes(b"x" * 1024)
        store = ArtifactStore(tmp_path / "blobs")
        artifact = store.put_file(source, copy=False)
        assert artifact.referenced and artifact.path == str(source.resolve())

    def test_directories_are_manifested(self, tmp_path):
        project = tmp_path / "project"
        (project / "src").mkdir(parents=True)
        (project / "src" / "a.py").write_text("a", encoding="utf-8")
        (project / "README.md").write_text("readme", encoding="utf-8")
        store = ArtifactStore(tmp_path / "blobs")
        artifact = store.put_file(project)
        assert artifact.kind == "directory"
        assert artifact.metadata["file_count"] == 2

    def test_lineage_is_traversable_and_cycle_safe(self, tmp_path):
        store = ArtifactStore(tmp_path / "blobs")
        raw = store.put_text("raw.csv", "a,b")
        cleaned = store.put_text("clean.csv", "a", derived_from=[raw.id])
        report = store.put_text("report.md", "# r", derived_from=[cleaned.id])
        raw.derived_from = [report.id]  # deliberately create a cycle
        assert {a.name for a in store.lineage(report.id)} == {"clean.csv", "raw.csv"}

    def test_manifest_round_trips(self, tmp_path):
        store = ArtifactStore(tmp_path / "blobs")
        store.put_json("data.json", {"a": 1})
        restored = ArtifactStore(tmp_path / "blobs")
        restored.load_manifest(store.manifest())
        assert restored.all()[0].name == "data.json"
        assert restored.all()[0].read_json() == {"a": 1}

    def test_missing_source_is_reported(self, tmp_path):
        store = ArtifactStore(tmp_path / "blobs")
        with pytest.raises(Exception, match="does not exist"):
            store.put_file(tmp_path / "ghost.txt")


class TestBudget:
    def test_hard_limits_raise(self, clock):
        from aios.foundation.config import BudgetConfig

        budget = Budget(limits=BudgetConfig(max_steps=2), clock=clock)
        budget.start()
        budget.charge_step(2)
        with pytest.raises(BudgetExceeded) as excinfo:
            budget.check(what="step 3")
        assert excinfo.value.context["limit"] == "max_steps"

    def test_check_is_side_effect_free(self, clock):
        from aios.foundation.config import BudgetConfig

        budget = Budget(limits=BudgetConfig(max_steps=10), clock=clock)
        budget.start()
        budget.charge_step(9)
        budget.check()
        budget.check()
        assert budget.new_warnings() == ["max_steps"], "warnings must survive repeated checks"
        assert budget.new_warnings() == [], "and be reported exactly once"

    def test_wall_clock_is_enforced(self, clock):
        from aios.foundation.config import BudgetConfig

        budget = Budget(limits=BudgetConfig(wall_clock_seconds=60), clock=clock)
        budget.start()
        clock.advance(61)
        with pytest.raises(BudgetExceeded):
            budget.check()

    def test_lookahead_does_not_raise(self, clock):
        from aios.foundation.config import BudgetConfig

        budget = Budget(limits=BudgetConfig(max_steps=2), clock=clock)
        budget.start()
        budget.charge_step(2)
        assert budget.would_exceed(steps=1)

    def test_cost_estimation_discounts_cache_reads(self):
        plain = estimate_cost("claude-sonnet-5", Usage(input_tokens=1_000_000))
        cached = estimate_cost(
            "claude-sonnet-5", Usage(input_tokens=1_000_000, cached_tokens=1_000_000)
        )
        assert cached < plain / 5

    def test_unknown_models_still_cost_something(self):
        assert estimate_cost("some-future-model", Usage(1_000_000, 1_000_000)) > 0

    def test_snapshot_is_serializable(self, clock):
        budget = Budget(clock=clock)
        budget.start()
        budget.charge_model("claude-sonnet-5", Usage(100, 50))
        json.dumps(budget.report())
