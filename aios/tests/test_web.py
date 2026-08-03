"""The web interface: routing heuristic, the approval bridge, and the live app.

Covers the two pieces most worth trusting: the chat/task router (getting this
wrong either fires side effects on a stray remark, or silently ignores a real
instruction), and WebApprover (a bug here means either a destructive action
executes without a person approving it, or an approval hangs forever).
"""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("fastapi")

from aios.cognition.plan import Plan, Step
from aios.foundation.config import Config
from aios.interfaces.web import ChatSession, WebApprover, classify_mode, create_app
from aios.security.policy import ActionRequest, Decision, RiskLevel, Verdict


class TestClassifyMode:
    @pytest.mark.parametrize(
        "text",
        [
            "what is the capital of France?",
            "how does this project work?",
            "why did the build fail?",
            "is this file safe to delete?",
            "can you explain what this function does?",
        ],
    )
    def test_plain_questions_are_chat(self, text):
        assert classify_mode(text) == "chat"

    @pytest.mark.parametrize(
        "text",
        [
            "build a landing page for my bakery",
            "organize the downloads folder",
            "fix the failing test",
            "write a report on sales",
            "delete the old backups",
            "run the test suite",
            "research competitors and summarize",
        ],
    )
    def test_action_verbs_are_task(self, text):
        assert classify_mode(text) == "task"

    def test_a_question_with_an_action_verb_is_task(self):
        # "can you build me a website?" - a question grammatically, but it's
        # asking for work, not information; the verb must win.
        assert classify_mode("can you build me a website?") == "task"

    def test_empty_text_defaults_to_chat(self):
        assert classify_mode("   ") == "chat"

    def test_ambiguous_statement_defaults_to_chat(self):
        # No verb, no question mark - side effects should never fire on a
        # guess, so the safe default is a reply, not an action.
        assert classify_mode("interesting, I didn't know that") == "chat"


class TestWebApprover:
    async def test_approval_resolves_with_the_response(self):
        sent = []

        async def send(payload):
            sent.append(payload)

        approver = WebApprover(send, timeout=5)
        request = _confirm_request()

        async def respond_shortly():
            await asyncio.sleep(0.01)
            request_id = sent[0]["id"]
            approver.resolve(request_id, True, "once")

        responder = asyncio.ensure_future(respond_shortly())
        result = await approver.request(request)
        await responder
        assert result.approved
        assert result.responder == "web"

    async def test_denial_is_honoured(self):
        sent = []

        async def send(payload):
            sent.append(payload)
            approver.resolve(payload["id"], False, "once")

        approver = WebApprover(send, timeout=5)
        result = await approver.request(_confirm_request())
        assert not result.approved

    async def test_silence_times_out_to_a_denial_not_a_hang(self):
        async def send(payload):
            pass  # the "browser" never answers

        approver = WebApprover(send, timeout=0.05)
        result = await approver.request(_confirm_request())
        assert not result.approved
        assert "time" in result.reason.lower()

    async def test_disconnect_resolves_all_pending_as_denied(self):
        seen_ids = []

        async def send(payload):
            seen_ids.append(payload["id"])

        approver = WebApprover(send, timeout=5)
        task = asyncio.ensure_future(approver.request(_confirm_request()))
        await asyncio.sleep(0.01)
        approver.cancel_all("tab closed")
        result = await task
        assert not result.approved

    async def test_resolve_ignores_an_unknown_or_already_answered_id(self):
        async def send(payload):
            pass

        approver = WebApprover(send)
        assert approver.resolve("appr_never_existed", True) is False

    async def test_scope_round_trips(self):
        sent = []

        async def send(payload):
            sent.append(payload)

        approver = WebApprover(send, timeout=5)

        async def respond():
            await asyncio.sleep(0.01)
            approver.resolve(sent[0]["id"], True, "tool")

        responder = asyncio.ensure_future(respond())
        result = await approver.request(_confirm_request())
        await responder
        assert result.scope.value == "tool"

    async def test_request_payload_carries_the_context_a_person_needs(self):
        sent = []

        async def send(payload):
            sent.append(payload)
            approver.resolve(payload["id"], True, "once")

        approver = WebApprover(send)
        action = ActionRequest(
            tool="shell.run", command="rm -rf build", paths=["build"],
            reversible=False, risk=RiskLevel.HIGH,
        )
        decision = Decision(Verdict.CONFIRM, "risky_command", "looks destructive", RiskLevel.HIGH)
        await approver.request(_confirm_request(action=action, decision=decision))
        payload = sent[0]
        assert payload["command"] == "rm -rf build"
        assert payload["reversible"] is False
        assert payload["risk"] == "HIGH"


def _confirm_request(action=None, decision=None):
    from aios.security.approvals import ApprovalRequest

    action = action or ActionRequest(tool="fs.delete", paths=["a.txt"], risk=RiskLevel.HIGH)
    decision = decision or Decision(Verdict.CONFIRM, "risk_threshold", "needs a person", RiskLevel.HIGH)
    return ApprovalRequest(action=action, decision=decision)


class TestChatSession:
    @pytest.fixture
    def config(self, tmp_path):
        cfg = Config.load(overrides={"workspace": {"root": str(tmp_path)}}, env={})
        cfg.memory.enabled = True
        cfg.security.approval_mode = "auto"
        cfg.ensure_dirs()
        return cfg

    async def test_status_reports_offline_honestly(self, config):
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        status = await session.status()
        assert status["model_ready"] is False, "offline provider must not claim to be ready"
        session.close()

    async def test_a_question_gets_a_chat_reply_not_a_task(self, config):
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        await session.handle("what is this project about?", "auto")
        assert sent[-1]["type"] == "chat"
        session.close()

    async def test_remember_stores_a_preference(self, config):
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        await session.handle("remember that I prefer dark mode", "chat")
        assert "remember" in sent[-1]["text"].lower()
        recalled = session.kernel.memory.recall("dark mode", scope=str(config.workspace_root))
        assert any("dark mode" in m.content for m in recalled)
        session.close()

    async def test_remember_refuses_a_credential(self, config):
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        await session.handle(
            "remember that the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz01", "chat"
        )
        assert "won't store" in sent[-1]["text"].lower()
        session.close()

    async def test_a_task_actually_runs_and_streams_events(self, config, tmp_path):
        (tmp_path / "junk.png").write_text("x")
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        await asyncio.wait_for(session.handle("organize this folder by file type", "task"), 15)
        types = [p["type"] for p in sent]
        assert "task_started" in types
        assert "event" in types, "live progress must actually stream, not just a final result"
        assert types[-1] == "task_complete"
        session.close()

    async def test_forced_task_mode_overrides_the_heuristic(self, config):
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        # This reads as a question, but mode="task" must win over the heuristic.
        await asyncio.wait_for(session.handle("is everything organized?", "task"), 15)
        assert sent[0]["type"] == "task_started"
        session.close()

    async def test_a_destructive_step_is_gated_and_recoverable(self, config, tmp_path):
        """fs.delete under standard security needs a real approval - ChatSession
        always uses WebApprover regardless of security.approval_mode, so this
        simulates the browser clicking "Approve" rather than relying on any
        config shortcut. That's deliberate: a web UI must never self-approve."""
        (tmp_path / "keep.txt").write_text("precious")
        sent = []

        async def send(p):
            sent.append(p)
            if p.get("type") == "approval_request":
                session.approver.resolve(p["id"], True, "once")

        session = ChatSession(config, send)
        plan = Plan(goal="delete keep.txt", steps=[
            Step(name="Delete it", tool="fs.delete", binding="d", arguments={"path": "keep.txt"}),
        ])
        result = await asyncio.wait_for(
            session.kernel.run("delete keep.txt", plan=plan), timeout=10
        )
        assert result.status == "succeeded", (
            "a successful delete must be reported as success, not treated as a failed "
            "verification because the deleted path no longer exists"
        )
        assert not (tmp_path / "keep.txt").exists()
        assert any((tmp_path / ".aios" / "trash").rglob("keep.txt"))
        session.close()

    async def test_chat_after_a_task_is_not_bound_by_the_tasks_budget(self, config):
        """Regression: Kernel.run() leaves its budget on the shared model
        client; a chat reply after a task must not inherit that budget."""
        sent = []

        async def send(p):
            sent.append(p)

        session = ChatSession(config, send)
        await asyncio.wait_for(session.handle("survey this folder", "task"), 15)
        assert session.kernel.model.budget is not None
        await asyncio.wait_for(session.handle("what did you just do?", "chat"), 15)
        assert session.kernel.model.budget is None
        assert sent[-1]["type"] == "chat"
        session.close()

    async def test_turns_are_serialized_not_interleaved(self, config):
        sent = []
        order = []

        async def send(p):
            sent.append(p)
            if p["type"] == "task_started":
                order.append("task_start")
            if p["type"] == "task_complete":
                order.append("task_end")

        session = ChatSession(config, send)
        await asyncio.wait_for(
            asyncio.gather(
                session.handle("survey this folder", "task"),
                session.handle("survey this folder", "task"),
            ),
            20,
        )
        assert order == ["task_start", "task_end", "task_start", "task_end"], (
            "a second task must wait for the first to finish, not interleave with it"
        )
        session.close()


class TestApp:
    @pytest.fixture
    def client(self, tmp_path):
        from fastapi.testclient import TestClient

        config = Config.load(overrides={"workspace": {"root": str(tmp_path)}}, env={})
        config.ensure_dirs()
        return TestClient(create_app(config))

    def test_index_serves_the_chat_page(self, client):
        response = client.get("/")
        assert response.status_code == 200
        assert "AI Workspace" in response.text

    def test_status_endpoint(self, client, tmp_path):
        response = client.get("/api/status")
        payload = response.json()
        assert payload["workspace"] == str(tmp_path)
        assert payload["tools"] > 40

    def test_websocket_greets_with_status_first(self, client):
        with client.websocket_connect("/ws") as ws:
            first = ws.receive_json()
            assert first["type"] == "status"

    def test_websocket_chat_round_trip(self, client):
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "message", "text": "hello?", "mode": "chat"})
            reply = ws.receive_json()
            assert reply["type"] == "chat"

    def test_websocket_task_round_trip_writes_a_real_file(self, client, tmp_path):
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "message", "text": "organize this workspace", "mode": "task"})
            saw_complete = False
            for _ in range(200):
                msg = ws.receive_json()
                if msg["type"] == "task_complete":
                    saw_complete = True
                    break
            assert saw_complete
        assert any(tmp_path.glob("maintenance-report.*"))

    def test_ping_pong(self, client):
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "ping"})
            reply = ws.receive_json()
            assert reply["type"] == "pong"

    def test_empty_message_is_ignored_not_errored(self, client):
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_json({"type": "message", "text": "   ", "mode": "chat"})
            ws.send_json({"type": "ping"})
            reply = ws.receive_json()
            assert reply["type"] == "pong", "the blank message must not produce a stray reply first"


def test_default_workspace_uses_env_override(monkeypatch, tmp_path):
    from aios.interfaces.web import default_workspace

    monkeypatch.setenv("AIOS_WORKSPACE", str(tmp_path / "custom"))
    result = default_workspace()
    assert result == tmp_path / "custom"
    assert result.is_dir()
