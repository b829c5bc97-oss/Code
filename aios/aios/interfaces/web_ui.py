"""The chat/task console frontend — a single self-contained HTML page.

Kept as a plain string constant rather than a templating engine or a build
step: the whole point of the web interface is that ``pip install`` and one
command is enough to get a working console on your own machine, with nothing
to compile and no CDN to reach.
"""

from __future__ import annotations

INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Workspace</title>
<style>
  :root {
    --bg: #0f1115;
    --surface: #171a21;
    --surface-2: #1d212b;
    --surface-3: #232836;
    --border: #262b36;
    --fg: #eae7df;
    --muted: #8b8f9e;
    --faint: #565c6b;
    --accent: #e8a33d;
    --accent-dim: #c98a2e;
    --accent-ink: #171205;
    --good: #6fbf8b;
    --warn: #e0b34a;
    --danger: #d97066;
    --danger-dim: #b85b52;
    --radius: 8px;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", "Cascadia Code", "Consolas", monospace;
    --sans: -apple-system, "Segoe UI", system-ui, sans-serif;
  }

  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f2ec; --surface: #fdfcf9; --surface-2: #f7f5ef; --surface-3: #efece1;
      --border: #ddd8c9; --fg: #23241f; --muted: #6b6c62; --faint: #9a9c8f;
      --accent: #b5730f; --accent-dim: #955e0c; --accent-ink: #fff8ea;
      --good: #3f8a5c; --warn: #a4780f; --danger: #b8493c; --danger-dim: #963b30;
    }
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--sans);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ---------- header ---------- */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1.1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex: none;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-family: var(--mono);
    font-weight: 600;
    font-size: 0.95rem;
    letter-spacing: -0.01em;
  }

  .brand .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--faint);
    transition: background .2s ease, box-shadow .2s ease;
  }
  .brand .dot.live { background: var(--good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 22%, transparent); }
  .brand .dot.down { background: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent); }

  .pills {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
    justify-content: flex-end;
    font-family: var(--mono);
    font-size: 0.68rem;
  }

  .pill {
    display: flex; align-items: center; gap: 0.35rem;
    padding: 0.22rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    white-space: nowrap;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill b { color: var(--fg); font-weight: 600; }
  .pill.warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); color: var(--warn); }

  /* ---------- conversation ---------- */
  main {
    flex: 1;
    overflow-y: auto;
    padding: 1.4rem 1rem 1rem;
    display: flex;
    justify-content: center;
  }

  .thread {
    width: 100%;
    max-width: 46rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .row { display: flex; }
  .row.user { justify-content: flex-end; }
  .row.assistant { justify-content: flex-start; }

  .bubble {
    max-width: 85%;
    padding: 0.65rem 0.9rem;
    border-radius: var(--radius);
    font-size: 0.94rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .row.user .bubble { background: color-mix(in srgb, var(--accent) 16%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .row.assistant .bubble { background: var(--surface); border: 1px solid var(--border); }

  .row.system .bubble {
    background: none; border: none; color: var(--muted);
    font-family: var(--mono); font-size: 0.75rem; text-align: center; max-width: 100%;
    padding: 0.2rem 0;
  }

  /* ---------- task card ---------- */
  .task {
    width: 100%;
    max-width: 85%;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .task .head {
    display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
    padding: 0.6rem 0.85rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
  }

  .task .head .goal { font-weight: 600; }

  .badge {
    font-family: var(--mono); font-size: 0.66rem; letter-spacing: 0.05em; text-transform: uppercase;
    padding: 0.16rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted);
    white-space: nowrap; flex: none;
  }
  .badge.running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .badge.succeeded { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, var(--border)); }
  .badge.partial { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
  .badge.failed, .badge.cancelled { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }

  .steps { padding: 0.5rem 0.85rem; display: flex; flex-direction: column; gap: 0.28rem; }
  .step {
    display: flex; align-items: flex-start; gap: 0.5rem;
    font-family: var(--mono); font-size: 0.78rem; color: var(--muted);
    padding: 0.15rem 0;
  }
  .step .mark { flex: none; width: 1.1em; text-align: center; }
  .step.ok .mark { color: var(--good); }
  .step.fail .mark { color: var(--danger); }
  .step.run .mark { color: var(--accent); }
  .step.info .mark { color: var(--faint); }
  .step .label { color: var(--fg); }
  .step .detail { color: var(--muted); }

  .result {
    padding: 0.7rem 0.85rem;
    border-top: 1px solid var(--border);
    font-size: 0.88rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .result .stats {
    margin-top: 0.5rem;
    font-family: var(--mono); font-size: 0.72rem; color: var(--muted);
    display: flex; gap: 0.9rem; flex-wrap: wrap;
  }
  .deliverables { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .deliverable {
    font-family: var(--mono); font-size: 0.76rem; color: var(--fg);
    display: flex; gap: 0.5rem; align-items: baseline;
  }
  .deliverable .size { color: var(--muted); }

  /* ---------- approval card ---------- */
  .approval {
    margin: 0.3rem 0;
    padding: 0.7rem 0.8rem;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--warn) 50%, var(--border));
    background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  }
  .approval .title {
    font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--warn); display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem;
  }
  .approval .summary { font-size: 0.86rem; margin-bottom: 0.3rem; }
  .approval .meta { font-family: var(--mono); font-size: 0.72rem; color: var(--muted); margin-bottom: 0.55rem; }
  .approval .meta div { margin: 0.1rem 0; overflow-wrap: anywhere; }
  .approval .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .approval button {
    font-family: var(--mono); font-size: 0.74rem; letter-spacing: 0.02em;
    padding: 0.32rem 0.7rem; border-radius: 5px; cursor: pointer; border: 1px solid transparent;
  }
  .approval .approve { background: var(--good); color: #0c1a12; }
  .approval .approve-tool { background: none; border-color: var(--good); color: var(--good); }
  .approval .deny { background: none; border-color: var(--danger); color: var(--danger); }
  .approval.resolved { opacity: 0.55; }
  .approval .decided { font-family: var(--mono); font-size: 0.74rem; }
  .approval .decided.yes { color: var(--good); }
  .approval .decided.no { color: var(--danger); }

  /* ---------- input ---------- */
  footer {
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    justify-content: center;
    padding: 0.8rem 1rem 1rem;
  }

  .composer { width: 100%; max-width: 46rem; }

  .modes {
    display: flex; gap: 0.35rem; margin-bottom: 0.5rem;
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.03em; text-transform: uppercase;
  }
  .modes button {
    background: var(--surface-2); border: 1px solid var(--border); color: var(--muted);
    padding: 0.28rem 0.6rem; border-radius: 999px; cursor: pointer;
  }
  .modes button.active { background: color-mix(in srgb, var(--accent) 18%, var(--surface-2)); border-color: var(--accent); color: var(--accent); }

  .inputrow {
    display: flex; align-items: flex-end; gap: 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.6rem;
  }
  .inputrow:focus-within { border-color: var(--accent); }

  textarea {
    flex: 1; resize: none; background: none; border: none; color: var(--fg);
    font-family: var(--sans); font-size: 0.94rem; line-height: 1.4;
    max-height: 9rem; padding: 0.25rem 0.2rem;
  }
  textarea:focus { outline: none; }
  textarea::placeholder { color: var(--faint); }

  button.send {
    font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase;
    background: var(--accent); color: var(--accent-ink); border: none; border-radius: 6px;
    padding: 0.5rem 0.85rem; cursor: pointer; flex: none;
    transition: background .15s ease, opacity .15s ease;
  }
  button.send:hover:not(:disabled) { background: var(--accent-dim); }
  button.send:disabled { opacity: 0.4; cursor: default; }

  .hint { font-family: var(--mono); font-size: 0.66rem; color: var(--faint); margin-top: 0.4rem; text-align: center; }

  ::-webkit-scrollbar { width: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 6px; }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>

<header>
  <div class="brand"><span class="dot" id="connDot"></span> AI Workspace</div>
  <div class="pills" id="pills"></div>
</header>

<main><div class="thread" id="thread"></div></main>

<footer>
  <div class="composer">
    <div class="modes" id="modes">
      <button data-mode="auto" class="active">Auto</button>
      <button data-mode="chat">Just answer</button>
      <button data-mode="task">Do it</button>
    </div>
    <div class="inputrow">
      <textarea id="input" placeholder="Ask a question, or tell it what to do…" rows="1"></textarea>
      <button class="send" id="sendBtn">Send</button>
    </div>
    <div class="hint">Runs locally on this machine · nothing risky happens without your approval below</div>
  </div>
</footer>

<script>
(function () {
  "use strict";

  var thread = document.getElementById("thread");
  var pills = document.getElementById("pills");
  var connDot = document.getElementById("connDot");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("sendBtn");
  var modesEl = document.getElementById("modes");

  var mode = "auto";
  var currentTask = null;   // the open task card's DOM refs, while one is running
  var socket = null;
  var reconnectDelay = 1000;

  function scrollDown() { window.scrollTo(0, 0); thread.parentElement.scrollTop = thread.parentElement.scrollHeight; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function addSystem(text) {
    var row = el("div", "row system");
    row.appendChild(el("div", "bubble", text));
    thread.appendChild(row);
    scrollDown();
  }

  function addBubble(role, text) {
    var row = el("div", "row " + role);
    var bubble = el("div", "bubble", text);
    row.appendChild(bubble);
    thread.appendChild(row);
    scrollDown();
    return bubble;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    return (n / (1024 * 1024)).toFixed(1) + "MB";
  }

  // ---------- task card ----------

  function startTask(goal) {
    var card = el("div", "task");
    var head = el("div", "head");
    head.appendChild(el("div", "goal", goal));
    var badge = el("span", "badge running", "running");
    head.appendChild(badge);
    card.appendChild(head);
    var steps = el("div", "steps");
    card.appendChild(steps);

    var row = el("div", "row assistant");
    row.appendChild(card);
    thread.appendChild(row);
    scrollDown();

    currentTask = { card: card, badge: badge, steps: steps };
  }

  var STEP_ICONS = {
    "step.started": ["run", "▸"], "step.succeeded": ["ok", "✔"], "step.failed": ["fail", "✘"],
    "step.skipped": ["info", "–"], "step.blocked": ["info", "⊘"], "step.retrying": ["run", "↻"],
    "run.planned": ["info", "≡"], "run.replanned": ["run", "↻"], "verify.failed": ["fail", "✘"],
    "recovery.attempt": ["run", "⚑"], "policy.blocked": ["fail", "⛔"],
  };

  function addStepLine(topic, data) {
    if (!currentTask) return;
    var spec = STEP_ICONS[topic];
    if (!spec) return;
    var line = el("div", "step " + spec[0]);
    line.appendChild(el("span", "mark", spec[1]));
    var text = "";
    if (topic === "step.started") text = data.name + "  [" + data.tool + "]";
    else if (topic === "step.succeeded") text = data.name + (data.summary ? " — " + data.summary : "");
    else if (topic === "step.failed") text = data.name + " — " + ((data.error && data.error.message) || "failed");
    else if (topic === "step.skipped") text = data.name + " (skipped)";
    else if (topic === "step.blocked") text = data.name + " blocked by " + data.blocked_by;
    else if (topic === "step.retrying") text = "retrying: " + (data.reason || "");
    else if (topic === "run.planned") text = data.steps + " steps, " + data.waves + " wave(s) planned";
    else if (topic === "run.replanned") text = "replanning: " + data.new_steps + " new step(s)";
    else if (topic === "verify.failed") text = "verification failed";
    else if (topic === "recovery.attempt") text = data.action + ": " + (data.reason || "");
    else if (topic === "policy.blocked") text = "blocked by policy: " + data.reason;
    line.appendChild(el("span", "label", text));
    currentTask.steps.appendChild(line);
    scrollDown();
  }

  function finishTask(msg) {
    if (!currentTask) return;
    currentTask.badge.textContent = msg.status;
    currentTask.badge.className = "badge " + msg.status;

    var result = el("div", "result");
    result.appendChild(document.createTextNode(msg.summary));

    if (msg.deliverables && msg.deliverables.length) {
      var list = el("div", "deliverables");
      msg.deliverables.forEach(function (d) {
        var line = el("div", "deliverable");
        line.appendChild(el("span", null, d.name));
        line.appendChild(el("span", "size", fmtBytes(d.size)));
        list.appendChild(line);
      });
      result.appendChild(list);
    }

    var stats = el("div", "stats");
    stats.appendChild(el("span", null, msg.duration_s + "s"));
    stats.appendChild(el("span", null, "$" + msg.cost_usd));
    if (msg.needs_human && msg.needs_human.length) {
      stats.appendChild(el("span", null, "needs a decision: " + msg.needs_human.join("; ")));
    }
    result.appendChild(stats);
    currentTask.card.appendChild(result);
    currentTask = null;
    scrollDown();
  }

  // ---------- approvals ----------

  function addApproval(msg) {
    var box = el("div", "approval");
    box.appendChild(el("div", "title", "⚠ approval needed — " + msg.risk));
    box.appendChild(el("div", "summary", msg.summary));

    var meta = el("div", "meta");
    if (msg.reason) meta.appendChild(el("div", null, "reason: " + msg.reason));
    if (msg.command) meta.appendChild(el("div", null, "command: " + msg.command));
    if (msg.paths && msg.paths.length) meta.appendChild(el("div", null, "paths: " + msg.paths.join(", ")));
    if (msg.urls && msg.urls.length) meta.appendChild(el("div", null, "urls: " + msg.urls.join(", ")));
    meta.appendChild(el("div", null, msg.reversible ? "reversible" : "cannot be undone"));
    box.appendChild(meta);

    var actions = el("div", "actions");
    function respond(approved, scope) {
      send({ type: "approval_response", id: msg.id, approved: approved, scope: scope });
      actions.remove();
      meta.remove();
      box.classList.add("resolved");
      box.appendChild(el("div", "decided " + (approved ? "yes" : "no"),
        approved ? "✔ approved" + (scope !== "once" ? " (" + scope + ")" : "") : "✘ denied"));
    }
    var approve = el("button", "approve", "Approve");
    approve.onclick = function () { respond(true, "once"); };
    var approveTool = el("button", "approve-tool", "Approve all like this");
    approveTool.onclick = function () { respond(true, "tool"); };
    var deny = el("button", "deny", "Deny");
    deny.onclick = function () { respond(false, "once"); };
    actions.appendChild(approve);
    actions.appendChild(approveTool);
    actions.appendChild(deny);
    box.appendChild(actions);

    if (currentTask) {
      currentTask.steps.appendChild(box);
    } else {
      var row = el("div", "row assistant");
      row.appendChild(box);
      thread.appendChild(row);
    }
    scrollDown();
  }

  // ---------- status pills ----------

  function renderStatus(s) {
    pills.innerHTML = "";
    var model = el("div", "pill" + (s.model_ready ? "" : " warn"));
    model.innerHTML = "<b>" + s.model + "</b>";
    if (!s.model_ready) model.appendChild(document.createTextNode(" · no reasoning model"));
    pills.appendChild(model);

    pills.appendChild((function () { var p = el("div", "pill"); p.innerHTML = "<b>" + s.tools + "</b> tools"; return p; })());
    pills.appendChild((function () { var p = el("div", "pill"); p.textContent = s.security_mode + " mode"; return p; })());
    pills.appendChild((function () { var p = el("div", "pill"); p.title = s.workspace; p.textContent = s.workspace; return p; })());

    if (!s.model_ready) {
      addSystem("No reasoning model is configured (ANTHROPIC_API_KEY not set) — running in a limited, template-only mode. Answers will be extractive, not generated.");
    }
  }

  // ---------- socket ----------

  function send(obj) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(proto + "//" + location.host + "/ws");

    socket.onopen = function () {
      connDot.className = "dot live";
      reconnectDelay = 1000;
    };
    socket.onclose = function () {
      connDot.className = "dot down";
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
    };
    socket.onerror = function () { socket.close(); };

    socket.onmessage = function (evt) {
      var msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      switch (msg.type) {
        case "status": renderStatus(msg); break;
        case "chat": addBubble("assistant", msg.text); break;
        case "error": addBubble("assistant", "⚠ " + msg.text); break;
        case "task_started": startTask(msg.goal); break;
        case "task_complete": finishTask(msg); break;
        case "approval_request": addApproval(msg); break;
        case "event": addStepLine(msg.topic, msg.data || {}); break;
        default: break;
      }
    };
  }

  connect();

  // ---------- composer ----------

  modesEl.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      mode = btn.getAttribute("data-mode");
      modesEl.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b === btn); });
    });
  });

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 144) + "px";
  }
  input.addEventListener("input", autoGrow);

  function submit() {
    var text = input.value.trim();
    if (!text) return;
    addBubble("user", text);
    send({ type: "message", text: text, mode: mode });
    input.value = "";
    autoGrow();
    input.focus();
  }

  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  input.focus();
})();
</script>
</body>
</html>
"""

__all__ = ["INDEX_HTML"]
