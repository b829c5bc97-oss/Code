# JARVIS — Personal AI Computer Assistant

JARVIS is a modular, locally-run personal AI assistant. It's built as a real
application — a FastAPI backend and a React/TypeScript desktop-style UI — not
a chatbot demo. The long-term goal (see **Roadmap** below) is a system that
can see your screen, control your computer, browse the web, manage files,
write code, and carry out multi-step tasks, always with human confirmation
before anything destructive or irreversible.

**This is Phase 1.** It ships a real, working foundation: backend, frontend,
a pluggable LLM layer, and a basic conversational agent with short-term
memory. Every folder for later phases (computer control, browser automation,
voice, long-term memory, tool execution, permissions) already exists with a
clear docstring saying what it will do and that it isn't implemented yet —
nothing in this codebase pretends to do more than it does.

## What works right now

- Chat with JARVIS through a polished dark-themed UI (visualizer, animated
  states, conversation history).
- Pluggable AI provider: `mock` (offline, no key needed), `openai`, or
  `anthropic`, chosen via one environment variable.
- Short-term conversation memory per session (the backend remembers the
  current conversation; it does not yet persist across restarts).
- A health check the UI uses to show whether the backend is reachable and
  whether the configured AI provider is ready to use.
- Automated backend tests covering config, the LLM abstraction, memory, the
  agent, and the HTTP API — all runnable offline via the `mock` provider.

## What is intentionally not built yet

Computer control, screen vision, browser automation, voice, multi-step
planning, the tool registry/permission system, document generation, and
persistent long-term memory are all future phases. See **Roadmap**.

## Architecture

```
jarvis/
├── backend/
│   ├── core/
│   │   ├── agent.py        # Phase 1: LLM-only conversation loop
│   │   ├── config.py       # Phase 1: env-driven settings
│   │   ├── memory.py       # Phase 1: short-term (in-process) history
│   │   ├── planner.py      # Phase 6 stub — multi-step task planning
│   │   └── permissions.py  # Phase 6 stub — LOW/MEDIUM/HIGH permission tiers
│   ├── ai/
│   │   ├── llm.py          # Phase 1: pluggable provider (mock/openai/anthropic)
│   │   ├── prompts.py      # Phase 1: system persona
│   │   └── vision.py       # Phase 2 stub — screen understanding
│   ├── computer/           # Phase 2 stubs — mouse, keyboard, screen, windows, apps
│   ├── browser/            # Phase 3 stubs — browser automation
│   ├── voice/              # Phase 4 stubs — STT / TTS / wake word
│   ├── files/              # Phase 6 stubs — file management
│   ├── tools/              # Phase 6 stubs — tool registry + first tools
│   └── main.py             # FastAPI app (/api/health, /api/chat)
├── frontend/                # React + TypeScript + Vite
│   └── src/
│       ├── components/      # Visualizer, ConversationPanel, InputBar, TopBar
│       ├── hooks/            # useJarvis — chat state + API calls
│       ├── services/         # api.ts — typed fetch client
│       └── types.ts
├── tests/                   # pytest suite (backend)
├── requirements.txt
├── pytest.ini
└── .env.example
```

Stub modules raise `NotImplementedError` with a message naming the phase
that will implement them — they exist to show the intended shape of the
system, not to fake functionality.

## Requirements

- Python 3.11+
- Node.js 20+ and npm
- (Optional) an OpenAI or Anthropic API key if you want real AI responses
  instead of the offline mock provider

## Installation

### Backend

```bash
cd jarvis
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
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

Open the URL Vite prints (default `http://localhost:5173`). The top bar
shows whether the backend is reachable and whether the configured AI
provider is ready. With no `.env` at all, JARVIS runs immediately using the
offline mock provider so you can see the full loop working before wiring up
a real key.

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
one class in `backend/ai/llm.py` that implements `LLMProvider.chat()` and
registering it in `_PROVIDERS` — nothing else in the app changes.

## How voice will be configured (not yet available)

`backend/voice/` defines the intended interface for speech-to-text,
text-to-speech, and wake-word detection. None of it is wired up in Phase 1 —
the input bar's microphone button is visibly disabled rather than pretending
to listen.

## How permissions will work (not yet enforced)

Phase 1 has no tool execution, so there is nothing to gate yet.
`backend/core/permissions.py` defines the planned `LOW` / `MEDIUM` / `HIGH`
tiers described in the project spec — once `tools/registry.py` gains real
tools (file deletion, sending messages, running commands, etc.), each one
will be tagged with a tier, and `HIGH` actions will require an explicit
confirmation step in the UI before executing.

## Testing

```bash
cd jarvis
source .venv/bin/activate
pytest
```

All tests use the `mock` LLM provider or a stub provider — no network access
or API key is required to run the suite.

## Troubleshooting

- **UI shows "Backend unreachable"** — make sure `uvicorn` is running on
  port 8000, and that `VITE_API_BASE_URL` (if set) points to the right host.
- **"AI: openai (not configured)"** — `OPENAI_API_KEY` is missing or blank
  in `jarvis/.env`; restart the backend after editing it.
- **CORS errors in the browser console** — add your frontend's origin to
  `CORS_ORIGINS` in `.env`.
- **`ModuleNotFoundError: backend`** — run `uvicorn`/`pytest` from inside
  `jarvis/`, not the repo root.

## Roadmap

- **Phase 2** — Computer control: screenshots, mouse/keyboard, window and
  application management, basic screen vision.
- **Phase 3** — Browser automation (Playwright): navigation, search,
  form-filling, page extraction, research mode.
- **Phase 4** — Voice: streaming speech-to-text, text-to-speech, wake word.
- **Phase 5** — Persistent, user-editable long-term memory (preferences,
  facts, project history) distinct from the in-session chat history.
- **Phase 6** — Multi-step planner, real tool registry, and the enforced
  permission system with confirmation prompts for HIGH-risk actions.
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
