# AIOS — AI Digital Operating System

An autonomous goal-execution kernel. You describe an outcome in plain language;
it works out what you meant, plans a graph of work, executes it in parallel
under a capability-based security policy, **verifies its own output**, recovers
from failures, and reports honestly on what it actually did.

It is not a chatbot with tools bolted on. The chat surface is one interface over
a kernel whose job is to finish work.

```bash
aios run "profile sales.csv, break revenue down by region and publish a report"
```

```
▌ profile sales.csv, break revenue down by region and publish a report
  workspace /work · standard mode · model claude-sonnet-5
  understood: data / moderate → sales-report.html
  plan: 5 steps in 2 parallel wave(s) (model)

  ▸ Profile the dataset [data.inspect]
  ▸ Revenue by region [data.query]
  ▸ Top performers [data.query]
  ▸ Monthly trend [data.query]
  ✔ Revenue by region      0.1s  4 row(s) returned from 1 table(s)
  ✔ Profile the dataset    0.1s  5000 rows x 5 columns, 0 data quality issues
  ✔ Top performers         0.1s  5 row(s) returned from 1 table(s)
  ✔ Monthly trend          0.1s  12 row(s) returned from 1 table(s)
  ▸ Publish the report [doc.report]
  ✔ Publish the report     0.0s  wrote sales-report.html (3 sections)

▌ SUCCEEDED  8.4s · 5 steps · 3 model calls · $0.0197
```

## What makes it different

**It verifies instead of asserting.** Every step carries a machine-checkable
contract — the file exists *and is non-empty*, the build exits zero, the page
contains the heading. A tool that returns success but produced an empty file is
a failed step, not a finished one. This is the single largest source of "the
agent said it was done and it wasn't", and it is closed structurally.

**Failure is a decision point, not a stop.** A failed step goes through a
recovery ladder — retry with jittered backoff, repair the arguments against the
tool's schema, substitute an equivalent tool, decompose into smaller steps, skip
if optional, escalate to you — bounded by an attempt budget and a per-step
history so nothing is tried twice.

**Work is a graph, not a list.** Independent steps run concurrently. A failure
blocks only its transitive dependents; unrelated branches keep going and still
produce their deliverables, so a partial failure yields partial value.

**Authority is declared, not assumed.** Each tool declares the capabilities it
needs, its risk level and whether it is reversible. The policy engine evaluates
every invocation *before* it runs and returns allow / confirm / deny. Sending,
publishing, spending and deleting always involve a person.

**It boots anywhere.** The kernel has **zero third-party dependencies**. Without
an API key it still runs, planning from builtin templates and telling you so —
degraded capability, never degraded honesty.

## Install

```bash
pip install -e .                       # kernel + 50 builtin tools, no dependencies
pip install -e '.[server]'             # + the local chat/task website (aios serve)
pip install -e '.[browser,dev]'        # optional: Playwright, test tooling
export ANTHROPIC_API_KEY=sk-ant-...    # optional: enables real reasoning, not just templates
```

```bash
aios doctor        # what's available in this environment, and what isn't
```

## Using it

```bash
aios run "<goal>"              # understand → plan → execute → verify → report
aios run "<goal>" --dry-run    # plan and simulate, change nothing
aios run "<goal>" -y           # unattended: auto-approve gated actions
aios plan "<goal>"             # show the plan without executing it
aios tools                     # list every tool with its risk and capabilities
aios runs                      # previous runs, status and cost
aios replay <run_id>           # reconstruct a run from its ledger
aios memory recall "<query>"   # what it remembers about this workspace
```

Useful flags: `--workspace DIR` (the sandbox root), `--budget-usd`,
`--time-limit`, `--max-parallel`, `--security strict|standard|permissive`,
`--allow publish` (grant a capability), `--report DIR`.

Exit codes: `0` succeeded · `1` partial · `2` failed · `3` cancelled · `4` usage.

## The website (`aios serve`)

```bash
aios serve                              # http://127.0.0.1:8420, workspace = ~/ai-workspace
aios serve -w ~/Documents/projects      # widen the sandbox to a real project folder
```

One page: type a question and get a direct answer, or type an instruction and
watch it plan and execute live — the same step-by-step feed as the CLI, in the
browser. Anything the policy engine would gate on the command line (deleting a
file, running a risky shell command, publishing) shows up as an inline
approve/deny card instead of an unattended `-y` — nothing happens until you
click it.

**Read this before you decide what "runs on my laptop" means here:**

- `aios serve` must run **on the machine you want it to act on.** Open the
  browser tab on that same machine (or tunnel to it deliberately). Nothing
  hosted elsewhere can reach into your filesystem — no legitimate service
  works that way, and one that claimed to would be indistinguishable from
  malware. This is a local tool, not a cloud product.
- It only touches files inside its **workspace** — `~/ai-workspace` by
  default, shown in the header of the page. That is deliberate, not a
  limitation: a fresh install shouldn't default to full access to your home
  directory. Widen it with `-w <path>` when you mean to.
- Without `ANTHROPIC_API_KEY` set, chat replies are **extractive** (they quote
  back what you said, they don't reason) and task mode can only run the
  builtin category templates (organize, profile data, scaffold a site, …) —
  it cannot parse an arbitrary specific instruction like *"write hello.txt
  with the content hi there."* The header shows a visible warning the whole
  time this is true. Set the key for the real thing.
- Every approval prompt is real: declining one means the action does not
  happen, full stop. A tab that closes mid-approval is treated as a denial,
  never a silent yes.

### As a library

```python
from aios import Config, Kernel

config = Config.load(overrides={"workspace": {"root": "./project"}})
kernel = Kernel(config)
result = await kernel.run("add a health check endpoint and a test for it")

print(result.status)                       # succeeded | partial | failed | cancelled
print([a.name for a in result.deliverables()])
print(result.budget["used"]["usd"])
```

## The pipeline

```
goal ─→ understand ─→ plan ─→ schedule ─→ execute ─→ verify ─→ report
             │          │         │          │          │
        deliverables   DAG    parallel    policy     contracts
        assumptions  grounded  waves     approval    ├─ pass → done
        open Qs      to real             sandbox     └─ fail ─┐
                     tools                                    │
                        ▲                                     ▼
                        └───────── replan ◀──────────── recover
```

Every stage emits events. The event stream *is* the audit log: it drives the
console, the append-only ledger, the run report and memory. Swapping the
terminal for a web UI is one subscription.

## Security model

| Layer | Guarantee |
|---|---|
| Path jail | `..` traversal, symlink escapes and prefix confusion (`/work` vs `/work-secrets`) all refused |
| Capabilities | A tool that never declared `shell.exec` cannot spawn a process, whatever its code does |
| Policy engine | Ordered rules → allow / confirm / deny; `DENY` is final and cannot be approved away |
| Approvals | Scoped answers (once / this tool / this run) so you're asked once per class, not per call |
| Redaction | Every log line, ledger entry and memory is scrubbed; credentials are refused, not masked |
| Subprocesses | Credential-shaped env vars stripped; process groups killed on timeout |
| Budgets | Hard ceilings on time, steps, tool calls, tokens and dollars, checked before each action |
| Deletes | Moved to a run-scoped trash directory — recoverable unless you explicitly purge |

`rm -rf /`, `dd if=… of=/dev/sda` and `curl … | sh` are hard-denied: no approval
prompt exists for them.

## The tools

50+ builtins, each with a JSON Schema contract, declared capabilities and a risk
level:

- **filesystem** — read, write (atomic), edit, search, organize, disk usage, recoverable delete
- **shell & system** — sandboxed execution, binary discovery, system diagnostics
- **code** — run Python, detect and run the test suite, AST analysis (complexity, duplicate logic), format, scaffold projects
- **data** — profile CSV/TSV/JSON, **SQL across multiple files** via SQLite, clean, export
- **documents** — Markdown → self-contained HTML, structured reports, keyboard-driven slide decks, text extraction
- **media** — ffmpeg: probe, transcode, trim, extract audio, thumbnails, concat, subtitles, single-pass silence removal
- **network** — HTTP with SSRF guards, readable page extraction, downloads, pluggable web search
- **browser** — Playwright with *semantic* targeting (role + accessible name, not CSS paths)
- **git** — status, diff, log, commit, branch, checkpoint, gated push

Adding one is a class with a schema and an `execute` method. See
[docs/EXTENDING.md](docs/EXTENDING.md).

## Extending

Plugins are Python modules exposing `tools()`, `providers()`, `policy_rules()`
or `setup()`, loaded from configured directories or the `aios.plugins` entry
point. A plugin that fails to import is logged and skipped — it can never stop
the OS from booting — and its tools are checked by the same policy engine, so
installing one does not widen what a session may do.

## Configuration

`aios.toml` in the workspace or any parent; `AIOS_*` environment variables
override it; CLI flags override those. See [aios.toml.example](aios.toml.example).

## Development

```bash
python3 -m pytest -q      # 305 tests, ~3s, no network
ruff check aios tests
```

The test suite drives the kernel through a scripted model provider and a manual
clock, so recovery ladders, backoff schedules, budget exhaustion, sandbox
escapes and denied approvals are all exercised deterministically and offline.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — the layering, and why each boundary is where it is
- [docs/EXTENDING.md](docs/EXTENDING.md) — writing tools, providers and plugins
- [docs/SECURITY.md](docs/SECURITY.md) — the threat model in detail

## Status

The kernel, security model, tool layer, web interface and test suite (416
tests) are complete and working. Known gaps, stated plainly: web search needs
a backend key (it fails loudly rather than inventing results); browser tools
need Playwright installed; media tools need ffmpeg on PATH; chat/task quality
without `ANTHROPIC_API_KEY` is template-only, not generative; `aios doctor`
reports exactly what your machine is missing.

MIT licensed.
