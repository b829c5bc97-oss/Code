from backend.ai.llm import ChatMessage
from backend.core.memory import ConversationStore


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
