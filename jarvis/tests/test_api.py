import os

os.environ.setdefault("AI_PROVIDER", "mock")

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["ai_provider"] == "mock"
    assert body["provider_ready"] is True


def test_chat_endpoint_returns_reply_and_session_id():
    response = client.post("/api/chat", json={"message": "hello jarvis"})
    assert response.status_code == 200
    body = response.json()
    assert "hello jarvis" in body["reply"]
    assert body["state"] == "idle"
    assert body["provider"] == "mock"
    assert body["session_id"]


def test_chat_endpoint_reuses_session_history():
    first = client.post("/api/chat", json={"message": "my name is prat"})
    session_id = first.json()["session_id"]

    second = client.post(
        "/api/chat", json={"message": "what did I just say?", "session_id": session_id}
    )
    assert second.status_code == 200
    assert second.json()["session_id"] == session_id


def test_chat_endpoint_rejects_empty_message():
    response = client.post("/api/chat", json={"message": ""})
    assert response.status_code == 422
