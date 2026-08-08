# JARVIS — Personal AI Computer Assistant

JARVIS is a modular, locally-run personal AI assistant. It's built as a real
application — a FastAPI backend and a React/TypeScript desktop-style UI — not
a chatbot demo. The long-term goal (see **Roadmap** below) is a system that
can see your screen, control your computer, browse the web, manage files,
write code, and carry out multi-step tasks, always with human confirmation
before anything destructive or irreversible.

**Phases 1, 3, and 4 are built.** Phase 2 (OS-level mouse/keyboard/window
control) is intentionally still a stub — see **What is intentionally not
built yet**. Every stub module has a clear docstring saying what it will do
and that it isn't implemented; nothing in this codebase pretends to do more
than it does.

## What works right now

- **Chat**, through an Iron-Man-style HUD: an animated arc-reactor
  visualizer, a live conversation panel, and a tool-activity readout.
- **Pluggable AI provider**: `mock` (offline, no key needed), `openai`, or
  `anthropic`, chosen via one environment variable.
- **Real tool use**: JARVIS can decide to use a tool mid-conversation
  (OpenAI/Anthropic function-calling; a small keyword heuristic for the
  offline mock provider), execute it, observe the result, and continue —
  bounded to a few steps per turn, not open-ended planning yet.
- **Browser automation (Phase 3)**: JARVIS opens a real, visible Chromium
  window (Playwright) and can navigate, search Google/YouTube/Bing, read a
  page's text, click, type, and scroll. If a page needs a CAPTCHA or a
  sign-in, JARVIS stops and asks you to take over instead of pretending to
  push through it.
- **Voice (Phase 4)**: speech-to-text and text-to-speech run in your
  browser (Web Speech API) — no server-side audio pipeline, no extra
  install. Click the mic to speak a command, or turn on the wake word:
  **clap, then say your phrase** (default *"daddy's here"*) within a few
  seconds, and JARVIS starts listening.
- **Short-term conversation memory** per session (in-process; doesn't
  survive a backend restart yet — that's persistent memory, Phase 5).
- **Health check** the UI uses to show backend/AI-provider/browser-tools
  status live.
- **36 automated backend tests**, plus a real-browser UI smoke test run
  during development — see **Testing**.

## What is intentionally not built yet

OS-level mouse/keyboard/window control and screen vision (Phase 2),
multi-step planning ahead of execution (Phase 6's planner — the current
tool loop reacts step by step, it doesn't plan upfront), the enforced
HIGH-risk confirmation UI, file management tools, persistent long-term
memory, and document/creative generation. See **Roadmap**.

## Architecture

```
jarvis/
├── backend/
│   ├── core/
│   │   ├── agent.py        # Bounded tool-use loop: LLM ⇄ tools ⇄ observations
│   │   ├── config.py       # env-driven settings
│   │   ├── memory.py       # short-term (in-process) conversation history
│   │   ├── planner.py      # Phase 6 stub — upfront multi-step planning
│   │   └── permissions.py  # LOW/MEDIUM/HIGH tiers; HIGH requires confirmation
│   ├── ai/
│   │   ├── llm.py          # pluggable provider + tool-calling (mock/openai/anthropic)
│   │   ├── mock_intent.py  # keyword-based tool intent for the offline mock provider
│   │   ├── prompts.py      # system persona
│   │   └── vision.py       # Phase 2 stub — screen understanding
│   ├── computer/           # Phase 2 stubs — mouse, keyboard, screen, windows, apps
│   ├── browser/
│   │   ├── browser.py         # Playwright session (launch/reuse/close)
│   │   └── browser_actions.py # navigate/search/extract_text/click/type/scroll
│   ├── voice/               # not used server-side — see frontend/src/services/voice.ts
│   ├── files/               # Phase 6 stubs — file management
│   ├── tools/
│   │   ├── registry.py        # Tool/ToolResult/ToolRegistry
│   │   ├── browser_tools.py   # registers the real browser.* tools
│   │   ├── calculator.py, research.py, code_tools.py  # Phase 6/7 stubs
│   └── main.py             # FastAPI app (/api/health, /api/chat)
├── frontend/                # React + TypeScript + Vite
│   └── src/
│       ├── components/      # Visualizer, ConversationPanel, ActivityLog,
│       │                    # InputBar, TopBar, SettingsPanel
│       ├── hooks/            # useJarvis (chat/voice-out), useWakeWord (clap+phrase)
│       ├── services/         # api.ts, voice.ts (STT/TTS), wakeWord.ts (clap detector)
│       └── types.ts
├── tests/                   # pytest suite (backend)
├── requirements.txt
├── pytest.ini
└── .env.example
```

Stub modules raise `NotImplementedError` with a message naming the phase
that will implement them.

## Requirements

- Python 3.11+
- Node.js 20+ and npm
- **Chrome or Edge** if you want voice (wake word / speech-to-text) — the
  Web Speech API isn't implemented in Firefox. Text-to-speech works
  everywhere.
- After `pip install`, run `playwright install chromium` once for browser
  automation.
- (Optional) an OpenAI or Anthropic API key for real AI responses and real
  tool-use reasoning, instead of the offline mock provider's keyword rules.

## Installation

### Backend

```bash
cd jarvis
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium      # one-time, for browser automation
cp .env.example .env             # then edit .env if you want a real AI provider
```

### Frontend

```bash
cd jarvis/frontend
npm install
```

## Environment variables

Set these in `jarvis/.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `mock` | One of `mock`, `openai`, `anthropic`. `mock` needs no key. |
| `AI_MODEL` | *(provider default)* | Override the model name, e.g. `gpt-4o-mini`, `claude-sonnet-4-5`. |
| `OPENAI_API_KEY` | *(empty)* | Required only if `AI_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | *(empty)* | Required only if `AI_PROVIDER=anthropic`. |
| `ENVIRONMENT` | `development` | `development` or `production`. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated origins allowed to call the API. |
| `MAX_HISTORY_MESSAGES` | `20` | How many recent turns are kept per session. |
| `MAX_TOOL_STEPS` | `6` | Cap on tool-call round trips per turn, so a confused model can't loop forever. |
| `ENABLE_BROWSER_TOOLS` | `true` | Turn browser automation off entirely if you don't want it. |
| `BROWSER_HEADLESS` | `false` | Visible by default — you should be able to see what JARVIS does in the browser. |
| `BROWSER_EXECUTABLE_PATH` | *(empty)* | Point at a specific Chromium binary instead of Playwright's bundled one. |
| `BROWSER_PROXY_SERVER` | *(empty)* | Upstream proxy for the browser (`http://host:port`), for networks that require one. |

The frontend reads `VITE_API_BASE_URL` (see `frontend/.env.example`) —
defaults to `http://localhost:8000` and only needs overriding if you run the
backend somewhere else.

**API keys are never hard-coded.** They are read from environment variables
only, and `.env` is git-ignored.

## Running JARVIS

Terminal 1 — backend:

```bash
cd jarvis
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

Terminal 2 — frontend:

```bash
cd jarvis/frontend
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`) **in Chrome or
Edge** for voice. The top bar shows whether the backend is reachable and
whether the configured AI provider is ready. With no `.env` at all, JARVIS
runs immediately using the offline mock provider so you can see the full
loop — including a real Chromium window opening for browser tool calls —
before wiring up a real key.

## How to configure a real AI provider

1. Get an API key from [OpenAI](https://platform.openai.com/api-keys) or
   [Anthropic](https://console.anthropic.com/settings/keys).
2. In `jarvis/.env`, set `AI_PROVIDER=openai` (or `anthropic`) and paste the
   key into `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`).
3. Restart the backend. The top bar will show `AI: openai` (or `anthropic`)
   once it's configured correctly; if the key is missing or invalid, the
   badge shows "(not configured)" and chat replies explain the problem
   instead of silently failing.

Adding another provider later (a local model, Gemini, etc.) means writing
one class in `backend/ai/llm.py` that implements `chat_with_tools()` (and
inherits `chat()` for free) and registering it in `_PROVIDERS` — nothing
else in the app changes.

## How tool use works

The agent hands the model a list of available tools (currently just
`browser.*`) on every turn. If the model asks to call one, `Agent` looks it
up in the registry, checks its permission tier, executes it, and feeds the
result back for another round — up to `MAX_TOOL_STEPS` times — before
answering. This is a *reactive* loop (decide → act → observe → repeat), not
the *upfront* multi-step planner described in the project spec — that's
still Phase 6 (`core/planner.py`).

With `AI_PROVIDER=mock`, tool "understanding" is a handful of regexes in
`backend/ai/mock_intent.py` (e.g. "search youtube for X", "go to X") —
enough to see the whole pipeline work with zero setup, but not real
language understanding. Use `openai` or `anthropic` for that.

## How browser automation works

`browser.open`, `browser.navigate`, `browser.search`, `browser.extract_text`,
`browser.click`, `browser.type`, and `browser.scroll` drive a real Playwright
Chromium session. It launches **visible** by default (`BROWSER_HEADLESS=false`)
so automation stays observable, per the project's safety principle — you
should always be able to see what JARVIS is doing in the browser and step in.

If a page looks like it needs a human — a CAPTCHA (`recaptcha`/`hcaptcha`/
`turnstile` iframe) or a sign-in form — JARVIS stops immediately, tells you
what it found, and waits for you to say you've handled it. This detection is
a best-effort heuristic, not a guarantee.

## How voice works (and its limits)

Speech-to-text and text-to-speech both run **in the browser tab**, not on
the backend — the backend has no microphone or speaker of its own. This
means:

- Zero extra install, no API key, and no audio ever leaves your machine.
- Speech-to-text (`SpeechRecognition`) needs Chrome, Edge, or Safari;
  there's no Firefox support to fall back to, and the Settings panel says
  so plainly rather than pretending to listen.
- Text-to-speech (`speechSynthesis`) works in effectively every modern
  browser.

**The clap + wake-phrase feature**, end to end:

1. Turn it on in Settings (⚙ in the top bar) — this is an explicit,
   visible action; the mic is never on by default. A pill in the top bar
   shows live mic status (`monitoring` / `armed`) whenever it's enabled.
2. JARVIS watches the mic's volume for a clap-like transient (a sharp
   spike well above the recent ambient noise level).
3. On a clap, it arms a ~4-second window and listens for your configured
   phrase (default **"daddy's here"**, editable in Settings).
4. Say the phrase inside that window → JARVIS says "Yes?", then listens
   for your actual command and sends it, same as clicking the mic button.

This is a volume-transient heuristic, not real clap classification — any
sufficiently sharp, loud sound can arm the window, but JARVIS only *wakes*
on a clap **followed by** the correct phrase. Nothing is recorded or
transmitted; audio is analyzed locally in the tab and discarded frame by
frame. Turning the toggle off releases the microphone completely.

## How permissions work (partially enforced)

`backend/core/permissions.py` defines `LOW` / `MEDIUM` / `HIGH` tiers.
Every current browser tool is `LOW` (open/navigate/search/extract/scroll)
or `MEDIUM` (click/type) — per the project spec, only `HIGH`-risk actions
(file deletion, sending messages, system changes, etc.) require
confirmation, and none exist yet. The `Agent` already refuses to execute
any tool tagged `HIGH` (see `requires_confirmation`), so wiring one in
later fails safe by default; a real confirmation *UI* round-trip is still
Phase 6.

## Testing

```bash
cd jarvis
source .venv/bin/activate
pytest
```

36 backend tests cover config, the LLM/tool-calling abstraction, the mock
intent detector, memory, the agent's tool loop (including the
human-required and permission-blocking paths), the browser tools (with a
real headless-Chromium integration test that's skipped gracefully if no
browser is available), and the HTTP API — all runnable offline via the
`mock` provider. Frontend: `npm run build` type-checks and bundles; voice
and wake-word code paths were verified with a real (fake-media-device)
browser session driven end-to-end against the live backend.

## Troubleshooting

- **UI shows "Backend unreachable"** — make sure `uvicorn` is running on
  port 8000, and that `VITE_API_BASE_URL` (if set) points to the right host.
- **"AI: openai (not configured)"** — `OPENAI_API_KEY` is missing or blank
  in `jarvis/.env`; restart the backend after editing it.
- **CORS errors in the browser console** — add your frontend's origin to
  `CORS_ORIGINS` in `.env`.
- **`ModuleNotFoundError: backend`** — run `uvicorn`/`pytest` from inside
  `jarvis/`, not the repo root.
- **Browser tool calls fail with "Couldn't launch the browser"** — run
  `playwright install chromium` inside your venv.
- **Wake word / mic button greyed out** — your browser doesn't implement
  `SpeechRecognition`; switch to Chrome or Edge.
- **Wake word won't trigger** — check the Settings status pill; if it's
  stuck on "monitoring" your phrase may not be matching what's recognized
  (recognition text is normalized and matched as a substring, so try a
  shorter/simpler phrase), or your mic's ambient noise floor may be high
  enough to mask claps.
- **Browser tools can't reach external sites from a restricted network** —
  set `BROWSER_PROXY_SERVER` if your network requires an upstream proxy for
  outbound connections.

## Roadmap

- **Phase 2** — OS-level computer control: screenshots, mouse/keyboard,
  window and application management, screen vision (locating UI elements
  without hard-coded coordinates).
- **Phase 5** — Persistent, user-editable long-term memory (preferences,
  facts, project history) distinct from the in-session chat history.
- **Phase 6** — Upfront multi-step planner, file-management tools, and the
  enforced confirmation *UI* for HIGH-risk actions (the backend already
  refuses them by default — this phase adds the round trip to actually ask).
- **Phase 7** — Coding assistant tools (project scaffolding, running tests,
  debugging) and document generation (DOCX/PPTX/XLSX/PDF).
- **Phase 8** — Creative-tool integration points, polish, packaging
  (Electron), and performance work.

## Project philosophy

Reliability, security, and honesty about capabilities come before feature
count. JARVIS will never claim to have performed an action it didn't
actually perform, will always ask before doing anything destructive or
irreversible, and will never attempt to access passwords or bypass OS
security.
