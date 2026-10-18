# JARVIS — AI personal assistant

A full-stack personal chief of staff: calendar, tasks and projects, work schedule, personal finance, reminders, notes, email and voice — coordinated by one assistant that **acts through validated, permission-checked tools** instead of just giving advice.

- **Backend:** Node.js 22 + Express, SQLite (built-in `node:sqlite`), zod validation, server-side scheduler.
- **AI:** Anthropic Claude via the official SDK with real tool calling (OpenAI-compatible APIs also supported). Falls back to a clearly labelled rule-based demo assistant when no key is configured.
- **Frontend:** dependency-free ES-module SPA (no build step), dark/light themes, responsive, keyboard accessible, strict CSP.

## Quick start

```bash
cd jarvis
npm install
cp .env.example .env        # optional: add ANTHROPIC_API_KEY etc.
npm start                   # http://localhost:3000
```

Create an account, then either start entering your own data or click **Load demo data** (every sample item is tagged “Demo” and can be removed in one click).

```bash
npm test                    # 19 API + agent tests (in-memory DB, fake AI API)
BASE=http://localhost:3000 node test/e2e/smoke.mjs   # browser smoke test (needs Chromium)
```

## What works

| Area | Features |
| --- | --- |
| **Overview** | Personalised greeting, central assistant input with mic + suggestions, rule-based daily briefing (events, due/overdue, free time, conflicts, competing deadlines, bills, budgets), agenda, meetings, priority tasks, deadlines, finance summary, bills, reminders. |
| **AI Assistant** | Conversation history, tool-calling agent, follow-ups (“move that to Friday”), approval cards for risky actions, action log showing exactly what changed, voice in/out. |
| **Calendar** | Day / week / month views, create/edit/delete, drag to reschedule (15-min snapping), recurring events (daily/weekly with weekdays/monthly/yearly, until), delete one occurrence, kinds (meeting, work, focus, study, personal, task block), participants, location, reminders, search & filter, conflict highlighting and save-anyway confirmation, free-time finder. |
| **Tasks & Projects** | List / board (drag & drop) / due-date calendar / projects; subtasks, checklists, dependencies (cycle-checked), recurring tasks, priorities + importance, categories, estimates, archive; overdue detection, workload stats; projects with milestones and progress; “break down a goal” → plan reviewed before saving. |
| **Work Schedule** | Working hours, working days, focus periods, lunch, meeting buffers; suggested daily schedule from tasks + meetings (nothing saved until you add it); weekly load; focus-session timer logged to the calendar; daily shutdown with “move unfinished work to tomorrow”. |
| **Finance** | Income/expenses with categories, budgets with forecast (labelled), bills & subscriptions with mark-paid (records expense, rolls due date), savings goals, monthly + yearly reports, period comparison, CSV import with validation, column mapping and duplicate detection, CSV export. INR by default, configurable currency/locale. Never moves money. |
| **Reminders** | One-off and recurring reminders, snooze, notification centre, event/bill/overdue/briefing notifications, browser pop-ups for open tabs. |
| **Notes & Knowledge** | Categories, tags, pinning, search, Markdown preview, autosave, action-item extraction → tasks, web research (if a search key is configured) clearly labelled as external. |
| **Integrations** | AI provider status, Google & Microsoft OAuth (PKCE, encrypted tokens), one-way calendar import, Gmail/Outlook inbox, thread view, drafts, explicit send confirmation. |
| **Settings** | Profile, time zone, locale, date/time format, week start, currency, theme, working hours & routine, notifications, assistant reply/voice preferences, memory (view/add/delete), per-area assistant permissions, data export (JSON), demo data, clear data, activity log, password change, sign out everywhere, account deletion. |

## AI provider

Set **one** of these on the server and restart:

```bash
ANTHROPIC_API_KEY=sk-ant-...          # model defaults to claude-opus-5-5 (ANTHROPIC_MODEL to change)
# or
AI_PROVIDER=openai OPENAI_API_KEY=... OPENAI_MODEL=... [OPENAI_BASE_URL=...]
```

How the brain is wired (`server/ai/`):

- `tools.js` — 47 tools. Each has a **zod schema** (used both to generate the JSON schema the model sees and to validate every call on the server), a domain, an access level and a handler that calls the same service layer the REST API uses. All data access is scoped to the signed-in user.
- **Permissions** are enforced before execution: per-area `read` / `confirm` / `write` (Settings → Privacy & permissions). Deletions, bulk scheduling (`apply_schedule`) and project plans **always** go to an approval card; nothing changes until the user clicks Approve, and the approval is re-validated and recorded back into the conversation.
- `agent.js` — manual agent loop with adaptive thinking, prompt caching, parallel tool calls, append-only history (thinking blocks are replayed unchanged), refusal handling, server-side refusal fallbacks, and typed error handling for auth/rate-limit/network failures.
- `demo.js` — used only without a key. It understands common phrasings, calls the same tools, and every reply says it is the demo assistant.
- The assistant can **draft** email but has no send tool. Sending happens only from the Email screen after the user ticks a confirmation showing the exact recipient and message; the server checks the confirmed recipient/subject match the draft.

## Reminders & notifications

The scheduler (`server/scheduler.js`) runs on the server every 30 s, independent of any open page. It fires due reminders, rolls recurring ones forward, and creates event, bill, overdue and daily-briefing notifications (deduplicated). Delivery channels in this build:

- **In-app** notifications (bell + notification centre) — always stored server-side.
- **Browser pop-ups** while a JARVIS tab is open (Server-Sent Events + Notification API).
- **Not implemented:** email, SMS, mobile/web push. JARVIS does not claim to send these.

Deployment: the scheduler runs inside `npm start` by default. If you run multiple web processes or a serverless host, set `JARVIS_DISABLE_SCHEDULER=1` on them and run exactly one `npm run worker` against the same database.

## Integrations — status

| Integration | Status |
| --- | --- |
| Anthropic / OpenAI-compatible | Implemented; the tool loop is tested against a local fake API. Not tested with a live key in this build. |
| Google Calendar + Gmail | OAuth (PKCE), one-way calendar import (30 days), inbox list, thread read, drafts, send. **Written against the official docs but untested against a live account** — the UI labels it “Untested”. |
| Microsoft Outlook (Graph) | Same as Google. Untested. |
| Web search (Tavily / Brave) | Implemented, untested without keys. Results are tagged as external. |
| Banking | Not integrated. Manual entry and CSV import only; JARVIS never asks for banking passwords. |

Setup steps and the exact redirect URIs are shown on the Integrations page (and in `.env.example`).

## Voice

Push-to-talk via the browser Web Speech API (Chrome, Edge, Safari; needs https or localhost and microphone permission), interim transcripts, spoken replies via speech synthesis, stop/cancel button, clear listening/processing/speaking/error states. There is **no** wake word or background listening. Typing always works.

## Security

- scrypt password hashing; random session tokens stored hashed; `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production; sessions expire and can be revoked (“sign out everywhere”).
- CSRF: every mutation needs a custom header and a same-origin `Origin`.
- Helmet with a strict Content-Security-Policy (no inline scripts or styles, no third-party origins).
- Rate limits on auth and assistant endpoints.
- Every query is scoped by `user_id`; ownership is re-checked on every reference (linked tasks, projects, dependencies, approvals). Tests cover cross-user access.
- OAuth tokens encrypted with AES-256-GCM (`JARVIS_SECRET`); OAuth `state` + PKCE.
- Server-side validation of every input and every AI tool argument; CSV export neutralises spreadsheet formulas.
- Full audit log (user vs assistant actions), JSON export, and account deletion that cascades to all data.

## Project layout

```
jarvis/
  server/
    index.js            Express app, security headers, routing
    config.js db.js     configuration, schema
    auth.js settings.js security.js
    routes/             REST API (core, finance, assistant, integrations)
    services/           domain logic shared by API and AI tools
    ai/                 tools, agent loop, demo assistant, date parsing
    integrations/       OAuth, calendar sync, email, web search
    scheduler.js worker.js
  public/               SPA (index.html, css/, js/, js/views/)
  test/                 node:test suites + Playwright smoke test
```

## Known limitations

- Calendar sync is import-only (provider → JARVIS); events created in JARVIS are not written back.
- Editing a single occurrence of a recurring event edits the series (deleting a single occurrence is supported).
- The rule-based briefing is deterministic; richer narrative briefings need an AI key.
- Multi-currency records are reported separately; no exchange-rate conversion.
- SQLite suits a single server. For larger deployments, move to Postgres.
