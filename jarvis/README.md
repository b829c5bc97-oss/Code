# JARVIS — Personal AI Computer Assistant

JARVIS is a modular, locally-run personal AI assistant. It's a real
application — a FastAPI backend and a React/TypeScript desktop-style UI —
not a chatbot demo. It understands natural language, can see your screen,
control your mouse/keyboard, browse the web, manage files, write and run
code, generate documents, and remember things about you across sessions —
always asking before anything destructive or irreversible.

**Phases 1–8 of the project spec are implemented**, with a few named
exceptions kept honest below rather than faked. Every capability that isn't
built yet raises `NotImplementedError` naming what's missing (usually an
external API key) rather than pretending to work.

## What works right now

- **Chat**, through an Iron-Man-style HUD: an animated arc-reactor
  visualizer, conversation panel, tool-activity feed, task-plan panel, and
  a live system-status dashboard.
- **Pluggable AI provider**: `mock` (offline, no key needed), `openai`, or
  `anthropic`, chosen via one environment variable.
- **Real tool use across every category in the spec** — 40+ tools: browser
  automation, computer control, screen vision, file management, a coding
  assistant, document generation, persistent memory, research, and system
  monitoring. The agent decides which to call (OpenAI/Anthropic
  function-calling; a keyword heuristic for the offline mock provider),
  executes it, observes the result, and continues for up to
  `MAX_TOOL_STEPS` rounds.
- **A real confirmation round-trip**: HIGH-risk actions (deleting files,
  destructive shell commands, ...) pause the conversation and show
  Approve/Deny buttons in the UI; nothing destructive runs until you say so.
- **A short upfront plan** for requests that look like more than a
  one-liner (real providers only), shown in the UI's task panel.
- **Persistent, user-editable long-term memory** — preferences/facts/tasks/
  projects that survive restarts, viewable and deletable from the Memory
  panel, automatically folded into every conversation.
- **Computer control**: mouse, keyboard, screenshots, window
  listing/focus, and application launching — plus **screen vision**:
  "what's on my screen?" and "click the settings button" work by sending a
  real screenshot to a vision-capable LLM, not hard-coded coordinates.
- **Browser automation**: a real, visible Chromium window (Playwright) —
  navigate, search, read pages, click, type, scroll. Stops and asks for
  help on a CAPTCHA or login instead of pretending to push through it.
- **Voice**, entirely in your browser tab (Web Speech API — no server-side
  audio, no extra install): a mic button, and **a clap + wake-phrase
  detector** — clap, then say your phrase (default *"daddy's here"*), and
  JARVIS starts listening.
- **Coding assistant**: scaffold projects, read/write files, run shell
  commands (with destructive-command detection that forces confirmation
  regardless of the usual permission tier).
- **Documents**: create TXT, Markdown, CSV, DOCX, PPTX, XLSX, and PDF files.
- **Research mode**: gathers raw text + source URLs from multiple searches
  for the model to compare, summarize, and cite — no invented sources.
- **System monitor**: live CPU/RAM/disk/battery/network via `psutil`.
- **95 automated backend tests** (pytest) plus real end-to-end UI
  verification during development — see **Testing**.

## What is intentionally not built yet

- **Image/video generation and editing** — genuinely requires an external
  generative-media API (OpenAI Images, Stability, Runway, ...) this project
  doesn't assume a key for. `backend/tools/creative_tools.py` documents the
  exact integration point rather than faking a result.
- **Electron packaging** — JARVIS runs today as a local web app
  (`localhost:5173`); wrapping it in Electron for a native window/tray icon
  is straightforward but not done, since it adds nothing testable that the
  web app doesn't already prove.
- **Streaming token-by-token responses** — replies currently arrive as one
  chunk per turn, not streamed.

## Architecture

```
jarvis/
├── backend/
│   ├── core/
│   │   ├── agent.py         # Tool-use loop + confirmation round-trip + planning
│   │   ├── config.py        # env-driven settings
│   │   ├── memory.py        # ConversationStore (short-term) + LongTermMemoryStore
│   │   ├── planner.py       # Upfront plan generation for multi-step requests
│   │   └── permissions.py   # LOW/MEDIUM/HIGH tiers; HIGH always confirms
│   ├── ai/
│   │   ├── llm.py           # Pluggable provider + tool-calling + image understanding
│   │   ├── mock_intent.py   # Keyword-based tool intent for the offline mock provider
│   │   ├── prompts.py       # System persona + memory context
│   │   └── vision.py        # Screen vision (describe screen / locate an element)
│   ├── computer/
│   │   ├── mouse.py, keyboard.py, screen.py    # pyautogui / mss
│   │   ├── windows.py                          # ewmh (Linux) / pygetwindow (Win/Mac)
│   │   ├── applications.py                     # launch/close by name
│   │   └── _pyautogui_shim.py, errors.py
│   ├── browser/
│   │   ├── browser.py          # Playwright session (launch/reuse/close)
│   │   └── browser_actions.py  # navigate/search/extract_text/click/type/scroll
│   ├── files/
│   │   ├── file_manager.py     # list/read/create/rename/move/delete
│   │   └── search.py
│   ├── voice/                # not used server-side — see frontend/src/services/voice.ts
│   └── tools/                 # one register_*_tools() per category, wired in main.py
│       ├── registry.py, browser_tools.py, computer_tools.py, file_tools.py,
│       ├── code_tools.py, document_tools.py, memory_tools.py, system_tools.py,
│       └── research.py, creative_tools.py (documented, not registered)
├── frontend/                 # React + TypeScript + Vite
│   └── src/
│       ├── components/        # Visualizer, ConversationPanel, ActivityLog, PlanPanel,
│       │                      # ConfirmationBar, MemoryPanel, SettingsPanel, SystemStatus
│       ├── hooks/              # useJarvis, useWakeWord
│       └── services/           # api.ts, voice.ts, wakeWord.ts
├── tests/                     # pytest suite (95 tests)
├── requirements.txt
└── .env.example
```

## Requirements

- Python 3.11+, Node.js 20+ and npm
- **Chrome or Edge** for voice (wake word / speech-to-text) — the Web
  Speech API isn't implemented in Firefox. Text-to-speech works everywhere.
- After `pip install`, run `playwright install chromium` once for browser
  automation.
- A desktop session (a real display) for computer control / screen vision.
  These fail with a clear message rather than crashing if run headless.
- (Optional) an OpenAI or Anthropic API key for real AI reasoning and
  screen-vision support, instead of the offline mock provider.

## Installation

```bash
cd jarvis
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium      # one-time, for browser automation
cp .env.example .env             # then edit .env if you want a real AI provider

cd frontend
npm install
```

No system packages are required beyond Python/Node — computer control
works out of the box (see **A packaging note** below).

## Environment variables

Set these in `jarvis/.env` (see `.env.example` for the full, commented list):

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | `mock` | One of `mock`, `openai`, `anthropic`. `mock` needs no key. |
| `AI_MODEL` | *(provider default)* | Override the model, e.g. `gpt-4o-mini`, `claude-sonnet-4-5`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | *(empty)* | Required only for that provider. |
| `MAX_HISTORY_MESSAGES` | `20` | Recent turns kept per session. |
| `MAX_TOOL_STEPS` | `6` | Cap on tool-call round trips per turn. |
| `ENABLE_PLANNER` | `true` | Upfront plan for multi-step requests (real providers only). |
| `ALWAYS_CONFIRM_MEDIUM` | `false` | Also require confirmation for MEDIUM-risk actions, not just HIGH. |
| `ENABLE_BROWSER_TOOLS` / `ENABLE_COMPUTER_TOOLS` / `ENABLE_FILE_TOOLS` / `ENABLE_CODE_TOOLS` / `ENABLE_DOCUMENT_TOOLS` / `ENABLE_MEMORY_TOOLS` / `ENABLE_SYSTEM_TOOLS` | `true` | Turn any tool category off entirely. |
| `BROWSER_HEADLESS` | `false` | Visible by default so automation stays observable. |
| `BROWSER_EXECUTABLE_PATH` / `BROWSER_PROXY_SERVER` | *(empty)* | Custom Chromium binary / upstream proxy. |
| `WORKSPACE_DIR` | `./workspace` | Where `code.*` scaffolds new projects/files by default. |
| `CODE_RUN_TIMEOUT_SECONDS` | `60` | Timeout for `code.run_command`. |
| `MEMORY_FILE` | `./data/memory.json` | Where long-term memory is stored. |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Origins allowed to call the API. |

The frontend reads `VITE_API_BASE_URL` (see `frontend/.env.example`),
defaulting to `http://localhost:8000`.

**API keys are never hard-coded** — read from environment variables only,
and `.env` is git-ignored.

## Running JARVIS

```bash
# terminal 1
cd jarvis && source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000

# terminal 2
cd jarvis/frontend
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`) **in Chrome or
Edge** for voice. With no `.env` at all, JARVIS runs immediately on the
offline mock provider — try "open chrome", "what's on my screen?",
"remember that I prefer minimal designs", "delete <path>" (watch the
confirmation prompt), or "how's my computer doing?".

## How to configure a real AI provider

1. Get a key from [OpenAI](https://platform.openai.com/api-keys) or
   [Anthropic](https://console.anthropic.com/settings/keys).
2. Set `AI_PROVIDER` and the matching `*_API_KEY` in `jarvis/.env`.
3. Restart the backend. The top bar shows `AI: openai`/`anthropic` once
   configured; a missing/invalid key shows "(not configured)" and chat
   replies explain the problem instead of failing silently.

Real providers unlock: actual natural-language tool selection (vs. the
mock's regexes), the upfront planner, and screen vision (`describe_image`
requires a multimodal model). Adding another provider means implementing
`chat_with_tools()` (and optionally `describe_image()`) in `backend/ai/llm.py`
and registering it in `_PROVIDERS` — nothing else changes.

## How the agent loop works

```
INPUT -> memory context injected -> (long request? generate a plan) ->
  LOOP: ask the LLM (with tools) -> tool call? -> check permission ->
        needs confirmation? -> PAUSE, wait for Approve/Deny ->
        execute -> hit something only a human can resolve? -> PAUSE ->
        feed the observation back -> repeat (up to MAX_TOOL_STEPS)
  -> final text reply
```

`Agent.confirm()` resumes the *exact* paused loop state (remaining steps,
accumulated tool activity, full message history) once you answer — nothing
is re-run or lost.

## How permissions & confirmation work

`backend/core/permissions.py` defines three tiers, matching the spec:

- **LOW** — reading the screen, opening apps, searching the web, reading/
  listing/searching files, recalling memory, system info. Runs immediately.
- **MEDIUM** — creating/writing files, clicking/typing on screen or in the
  browser, running ordinary scripts, remembering/forgetting a memory.
  Confirms only if you set `ALWAYS_CONFIRM_MEDIUM=true`.
- **HIGH** — permanently deleting a file, or any shell command that looks
  destructive (`sudo`, `rm -rf /`, `mkfs`, a fork bomb, `shutdown`, drive
  formatting, ...) even if the tool itself is normally MEDIUM. **Always**
  requires an explicit Approve in the UI.

This dynamic escalation (a normally-MEDIUM tool becoming HIGH for one
specific dangerous call) is generic — any tool can supply a
`risk_escalation` function; `code.run_command` is the one that uses it today.

## How screen vision works

There's no separate OCR/UI-detection model — `computer.describe_screen`
and `computer.click_element` send a real screenshot straight to whichever
AI provider is configured and ask it to describe the screen or locate an
element by description, returning normalized coordinates that get scaled
to your actual screen resolution. This needs `AI_PROVIDER=openai` or
`anthropic` (a vision-capable model); the mock provider fails with a clear
"doesn't support image understanding" message rather than fabricating a
description.

## How computer control works (and a packaging note)

`pyautogui` (mouse/keyboard) has a real-world quirk: it unconditionally
imports a diagnostic tool called `mouseinfo`, which calls `sys.exit()` on
Linux if `tkinter` isn't installed — even though nothing here uses it.
`backend/computer/_pyautogui_shim.py` installs a harmless stub in its place
when that happens, so **mouse/keyboard control works out of the box with a
plain `pip install`, no system packages needed.** Window listing/focus uses
`ewmh` on Linux (X11 only — most Wayland compositors block this for
security reasons, cleanly) and `pygetwindow` on Windows/macOS.

All of this needs an actual desktop session — running the backend headless
(no display) makes these tools fail with a clear message rather than crash.

## How voice works (and its limits)

Speech-to-text and text-to-speech both run **in the browser tab** — the
backend has no microphone or speaker of its own.

- Zero extra install, no API key, no audio ever leaves your machine.
- `SpeechRecognition` (STT) needs Chrome, Edge, or Safari — no Firefox
  support to fall back to; the Settings panel says so rather than
  pretending to listen.
- `speechSynthesis` (TTS) works in effectively every modern browser.

**Clap + wake-phrase**, end to end: turn it on in Settings (an explicit,
visible action — the mic is never on by default; a top-bar pill shows live
`monitoring`/`armed` status). JARVIS watches the mic's volume for a
clap-like transient; on one, it arms a ~4-second window and listens for
your phrase (default *"daddy's here"*, editable). Say it inside that
window and JARVIS acknowledges and starts listening for your actual
command. This is a volume-transient heuristic, not real clap
classification — any sharp, loud sound can arm the window, but JARVIS only
*wakes* on a clap **followed by** the correct phrase. Nothing is recorded
or transmitted; turning the toggle off releases the microphone completely.

## How long-term memory works

`LongTermMemoryStore` persists short, categorized notes (preference / fact
/ task / project / app / context) to `data/memory.json` — plain JSON, easy
to inspect or back up yourself, not a database (this doesn't need one at
personal-assistant scale). Every entry is folded into the system prompt on
every turn, so "remember that I prefer minimal designs" actually changes
future answers. View, add, and delete memories from the 🧠 panel, or via
`memory.remember` / `memory.recall` / `memory.list` / `memory.forget`.

## How the coding assistant & documents work

`code.create_project` scaffolds a Python/Node/blank project under
`WORKSPACE_DIR`; `code.write_file` / `code.read_file` / `code.list_files`
work anywhere; `code.run_command` runs any shell command in a given
directory (foreground with a timeout, or `background: true` for a dev
server) — see **permissions** above for how destructive commands are
caught. `documents.create_{txt,markdown,csv,docx,pptx,xlsx,pdf}` generate
real files via `python-docx`/`python-pptx`/`openpyxl`/`fpdf2` (or the
standard library for txt/md/csv) — a relative path resolves under
`WORKSPACE_DIR`, an absolute one is used as-is.

## Testing

```bash
cd jarvis
source .venv/bin/activate
pytest
```

95 tests, all runnable offline with zero API key or special setup — including
a real (non-mocked) headless-Chromium browser test and real computer-control
tests (screenshot/mouse/window) that skip gracefully if no display is
available rather than failing. Every tool category has dedicated coverage:
the agent's tool/confirmation/planning loop, file management, code tools
(including dangerous-command detection), document generation (each format
verified to actually produce a valid file), the system monitor, screen
vision's coordinate math, and the mock provider's intent detection.

Frontend: `npm run build` type-checks and bundles; the full UI — chat,
confirmation flow, memory panel, plan panel, system status, wake word —
was verified end-to-end with a real (fake-media-device) browser session
driven against the live backend during development.

## Troubleshooting

- **UI shows "Backend unreachable"** — make sure `uvicorn` is running on
  port 8000 and `VITE_API_BASE_URL` (if set) points to the right host.
- **"AI: openai (not configured)"** — the matching `*_API_KEY` is missing;
  restart the backend after editing `.env`.
- **`ModuleNotFoundError: backend`** — run `uvicorn`/`pytest` from inside
  `jarvis/`, not the repo root.
- **Browser tool calls fail with "Couldn't launch the browser"** — run
  `playwright install chromium` inside your venv.
- **Computer-control tools fail with "no display detected"** — expected
  when the backend isn't running in a desktop session; these need a real
  display (see **How computer control works**).
- **Window listing returns nothing on Linux** — you may be on Wayland,
  which blocks this by design in most compositors.
- **Wake word / mic button greyed out** — your browser doesn't implement
  `SpeechRecognition`; switch to Chrome or Edge.
- **Wake word won't trigger** — check the Settings status pill; try a
  shorter/simpler phrase, or reduce background noise (the clap detector
  adapts to ambient volume but needs a real, sharp transient).
- **A HIGH-risk action seems stuck** — check for the amber confirmation
  bar above the input box; nothing destructive proceeds without an
  explicit Approve.
- **Browser tools can't reach external sites from a restricted network** —
  set `BROWSER_PROXY_SERVER`.

## Roadmap

- Image/video generation once a generative-media API key is configured
  (integration point already documented in `tools/creative_tools.py`).
- Electron (or similar) packaging for a native window/tray icon.
- Streaming token-by-token responses instead of one chunk per turn.
- Richer per-step progress tracking in the task-plan panel (today it shows
  the upfront plan; live step-by-step tick-off is a natural next step).
- A settings API for live-editing permission tiers from the UI (today,
  permission configuration is `.env`-based).

## Project philosophy

Reliability, security, and honesty about capabilities come before feature
count. JARVIS never claims to have performed an action it didn't actually
perform, always asks before doing anything destructive or irreversible,
and never attempts to access passwords or bypass OS security.
