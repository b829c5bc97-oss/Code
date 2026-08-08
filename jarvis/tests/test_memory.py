from backend.ai.llm import ChatMessage
from backend.core.memory import ConversationStore, LongTermMemoryStore


def test_append_and_get_history():
    store = ConversationStore(max_messages=10)
    store.append("s1", ChatMessage(role="user", content="hi"))
    store.append("s1", ChatMessage(role="assistant", content="hello"))

    history = store.get_history("s1")
    assert [m.content for m in history] == ["hi", "hello"]


def test_sessions_are_isolated():
    store = ConversationStore(max_messages=10)
    store.append("s1", ChatMessage(role="user", content="a"))
    store.append("s2", ChatMessage(role="user", content="b"))

    assert [m.content for m in store.get_history("s1")] == ["a"]
    assert [m.content for m in store.get_history("s2")] == ["b"]


def test_history_is_trimmed_to_max_messages():
    store = ConversationStore(max_messages=3)
    for i in range(5):
        store.append("s1", ChatMessage(role="user", content=str(i)))

    history = store.get_history("s1")
    assert [m.content for m in history] == ["2", "3", "4"]


def test_clear_removes_session():
    store = ConversationStore(max_messages=10)
    store.append("s1", ChatMessage(role="user", content="hi"))
    store.clear("s1")
    assert store.get_history("s1") == []


def test_long_term_memory_add_list_delete(tmp_path):
    store = LongTermMemoryStore(tmp_path / "memory.json")
    entry = store.add("preference", "Likes minimal black-and-white designs")

    entries = store.list()
    assert len(entries) == 1
    assert entries[0].id == entry.id
    assert entries[0].category == "preference"

    assert store.delete(entry.id) is True
    assert store.list() == []
    assert store.delete("nonexistent") is False


def test_long_term_memory_persists_across_instances(tmp_path):
    path = tmp_path / "memory.json"
    LongTermMemoryStore(path).add("fact", "Uses Python 3.11")

    reloaded = LongTermMemoryStore(path)
    assert len(reloaded.list()) == 1
    assert reloaded.list()[0].content == "Uses Python 3.11"


def test_long_term_memory_invalid_category_falls_back_to_fact(tmp_path):
    store = LongTermMemoryStore(tmp_path / "memory.json")
    entry = store.add("not-a-real-category", "something")
    assert entry.category == "fact"


def test_long_term_memory_search(tmp_path):
    store = LongTermMemoryStore(tmp_path / "memory.json")
    store.add("fact", "Favorite color is blue")
    store.add("fact", "Works as a developer")

    results = store.search("blue")
    assert len(results) == 1
    assert "blue" in results[0].content


def test_long_term_memory_as_prompt_context(tmp_path):
    store = LongTermMemoryStore(tmp_path / "memory.json")
    assert store.as_prompt_context() == ""

    store.add("preference", "Prefers dark mode")
    context = store.as_prompt_context()
    assert "Prefers dark mode" in context
    assert "preference" in context
