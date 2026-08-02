"""Memory: retrieval quality, secret refusal, run history."""

from __future__ import annotations

import pytest

from aios.foundation.config import MemoryConfig
from aios.memory.store import MemoryStore, NullMemory


@pytest.fixture
def store(tmp_path):
    memory = MemoryStore(tmp_path / "memory.db", MemoryConfig())
    yield memory
    memory.close()


class TestWriting:
    def test_memories_persist_across_instances(self, tmp_path):
        first = MemoryStore(tmp_path / "m.db")
        first.remember("preference", "always use tabs, never spaces")
        first.close()
        second = MemoryStore(tmp_path / "m.db")
        assert any("tabs" in m.content for m in second.preferences())
        second.close()

    def test_duplicates_are_not_stored_twice(self, store):
        assert store.remember("fact", "the API base is /v2") is not None
        assert store.remember("fact", "the API base is /v2") is None
        assert len(store.recall("API base")) == 1

    def test_unknown_kinds_are_rejected(self, store):
        with pytest.raises(ValueError, match="unknown memory kind"):
            store.remember("gossip", "something")

    def test_empty_content_is_ignored(self, store):
        assert store.remember("fact", "   ") is None

    @pytest.mark.parametrize(
        "content",
        [
            "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz01",
            "password = hunter2hunter2",
            "use token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ],
    )
    def test_credentials_are_refused_not_masked(self, store, content):
        assert store.remember("fact", content) is None
        assert store.recall("key token password") == []

    def test_supersede_keeps_an_audit_trail(self, store):
        original = store.remember("fact", "the port is 8080")
        store.supersede(original.id, "the port is 9090", kind="fact")
        recalled = [m.content for m in store.recall("port")]
        assert "the port is 9090" in recalled
        assert "the port is 8080" not in recalled


class TestRetrieval:
    def test_relevant_memories_outrank_irrelevant_ones(self, store):
        store.remember("fact", "the deployment target is fly.io in the syd region")
        store.remember("fact", "coffee preferences are irrelevant to software")
        store.remember("fact", "the database is postgres 16 with pgvector")
        top = store.recall("where do we deploy")
        assert top
        assert "fly.io" in top[0].content

    def test_importance_influences_ranking(self, store):
        store.remember("preference", "prefer TypeScript for new services", importance=0.95)
        store.remember("fact", "TypeScript was mentioned once in passing", importance=0.05)
        top = store.recall("typescript")
        assert "prefer TypeScript" in top[0].content

    def test_kind_and_scope_filters(self, store):
        store.remember("preference", "dark mode always", scope="/project-a")
        store.remember("fact", "project b uses light mode", scope="/project-b")
        results = store.recall("mode", scope="/project-a")
        assert all(m.scope in {"/project-a", "global"} for m in results)

    def test_limit_is_honoured(self, store):
        for index in range(30):
            store.remember("fact", f"fact number {index} about deployment")
        assert len(store.recall("deployment", limit=5)) == 5

    def test_context_block_is_prompt_ready(self, store):
        store.remember("preference", "write tests before implementation")
        block = store.context_for("add a feature with tests")
        assert "[preference]" in block

    def test_recall_on_an_empty_store_is_empty(self, store):
        assert store.recall("anything") == []

    def test_forget_removes_a_memory(self, store):
        memory = store.remember("fact", "temporary detail about the build")
        assert store.forget(memory.id)
        assert store.recall("temporary detail") == []


class TestRunHistory:
    def test_runs_are_recorded_and_listed(self, store):
        store.start_run("run_1", "build the site", "/ws")
        store.finish_run("run_1", "succeeded", steps=4, usd=0.12, summary="done")
        rows = store.recent_runs()
        assert rows[0]["run_id"] == "run_1"
        assert rows[0]["status"] == "succeeded"
        assert rows[0]["usd"] == 0.12

    def test_stats_aggregate_lifetime_cost(self, store):
        for index in range(3):
            store.start_run(f"run_{index}", "goal", "/ws")
            store.finish_run(f"run_{index}", "succeeded", usd=1.0)
        stats = store.stats()
        assert stats["runs"] == 3
        assert stats["lifetime_usd"] == 3.0


class TestNullMemory:
    def test_null_memory_satisfies_the_interface(self):
        memory = NullMemory()
        assert memory.remember("fact", "x") is None
        assert memory.recall("x") == []
        assert memory.context_for("x") == ""
        memory.start_run("r", "g")
        memory.finish_run("r", "ok")
        memory.close()
