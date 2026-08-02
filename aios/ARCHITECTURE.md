# Architecture

## The layering

Strictly one-directional. Nothing imports downward.

```
interfaces   cli · console renderer · run reports
     ↑
  kernel     the OS loop · DAG scheduler · step executor
     ↑
cognition    intent · plan graph · planner · verifier · recovery
     ↑
  model      provider-neutral types · resilient client · adapters
     ↑
  tools      contract · registry · JSON Schema · 50 builtins
     ↑
security     capabilities · path jail · policy engine · approvals
     ↑
 runtime     event bus · append-only ledger · artifact store · budgets
     ↑
foundation   ids · clock · error taxonomy · redaction · logging · config
```

The direction is what makes the system testable. `cognition` can be exercised
with a scripted model and a fake registry; `kernel` can be exercised with fake
tools; `security` needs nothing but a temp directory. No layer reaches for a
global, so every test constructs exactly the world it needs.

---

## Foundation

**Error taxonomy** (`foundation/errors.py`) is the load-bearing piece. Recovery
is only as good as its classification, so every failure — including third-party
exceptions, funnelled through `classify()` — becomes an `AiosError` carrying
three machine-readable facts: a stable `code`, whether it is `retryable`, and
the `remedy` family to try first. Recovery logic therefore never pattern-matches
on exception message strings.

**Redaction** (`foundation/redaction.py`) runs on every record that leaves the
process — logs, ledger, events, memory. It preserves a short fingerprint so
operators can correlate "the same secret" across a log without recovering it.
Placeholders like `${MY_KEY}` are deliberately left alone.

**Clock** is injectable. Every deadline, budget and backoff reads time through
it, so tests drive multi-minute retry schedules in microseconds.

---

## Runtime

**The event bus is the system's spine.** Everything observable is an event;
the console, the ledger, the report and memory are all just subscribers. Three
delivery guarantees matter:

- handlers run **sequentially in subscription order**, so a subscriber that
  persists state sees events in causal order;
- a handler that raises is logged and skipped — a broken UI cannot take down an
  execution;
- `publish` awaits delivery, giving natural backpressure instead of an unbounded
  queue that grows silently through a long run.

**The ledger** is newline-delimited JSON, one file per run: append-only,
greppable, `tail -f`-able, tolerant of a torn final line after a hard kill.
Approvals and destructive calls are `fsync`ed immediately, so the record of
"the user said yes to this" survives a power cut.

**The artifact store** is content-addressed by SHA-256. Immutability is the
point: retrying step 7 cannot invalidate the verified output of step 3. Large
files are *referenced* rather than copied — duplicating a 4 GB render to satisfy
a purity argument would be a bug, not a feature.

**Budgets** are what make it safe to walk away. Hard ceilings on wall-clock,
steps, tool calls, model calls, tokens and dollars, checked *before* each
consuming action. `check()` is deliberately side-effect free — several
components call it, and folding warning bookkeeping into it meant whichever
caller ran first silently swallowed the warning.

---

## Security

Three independent mechanisms, because any one of them will eventually have a
hole.

**Path jail.** Containment is checked by path *parts*, so `/work-secrets` is not
inside `/work`. Symlinks are resolved before the check, `..` is normalised, and
paths that don't exist yet are still validated — a tool cannot escape by writing
somewhere it will create.

**Capabilities.** Tools declare what they need (`fs.write`, `shell.exec`,
`publish`); a session is granted a set; the policy engine refuses anything
exceeding the grant. Grants match by dotted prefix — `fs` implies `fs.write`,
but `fs.read` never implies `fs`. This is what makes third-party plugins safe:
a plugin that never declared `shell.exec` cannot spawn a process regardless of
what its code attempts at the tool boundary.

**Policy engine.** Ordered, pure rules over `(request, grant)` producing
`ALLOW` / `CONFIRM` / `DENY`. `DENY` from any rule is final and cannot be
approved away — that's the distinction between "are you sure?" and "no". The
verdict record in the ledger names the rule that produced it.

The default posture (`standard`) grants filesystem, shell and network but
withholds `publish`, `comm.send`, `financial` and `credentials`. Those are
opt-in per run via `--allow`, and even when granted they still require approval:
`rule_outward_facing` fires in every security mode.

**Approvals** are brokered and scoped. `ONCE` / `TOOL` / `ALWAYS` / `NEVER`
means a long run asks once per class rather than forty times. `prompt` mode with
no TTY resolves to deny, never to a silent yes.

---

## Tools

The only way the OS touches the world. Everything above is pure reasoning over
tool results.

```python
class Tool:
    name: str
    capabilities: frozenset[str]     # what authority it needs
    risk: RiskLevel                  # how much damage success could do
    reversible: bool                 # can it be undone
    parameters: dict                 # JSON Schema
    idempotent: bool                 # safe for the retry loop to repeat

    async def execute(args, ctx) -> ToolResult
    def plan_action(args) -> ActionRequest   # what the policy engine sees
```

`Tool.run()` wraps `execute()` and guarantees: arguments validated and coerced,
a timeout applied, invocation and result published, and **every exception
classified** — it never raises for an ordinary failure. Recovery therefore
always receives a typed error.

`plan_action()` is the security hook: it surfaces the concrete paths, URLs and
commands an invocation will touch, so the policy engine reasons about the real
side effect rather than the tool's name.

**The schema validator is written here** rather than imported, for three reasons:
zero dependencies; *coercion* (models emit `"3"` where a schema says integer —
rejecting that wastes a whole repair round-trip); and error messages written for
a model to act on, because those strings are fed straight back into the repair
prompt.

---

## Model layer

Providers do exactly one thing: `ModelRequest → Completion`, translating vendor
errors into the shared taxonomy. No retries, no caching, no accounting — those
live in `ModelClient` so every provider gets them and none reimplements them
differently.

`ModelClient` adds: jittered exponential backoff honouring `Retry-After`;
failover down a provider chain; budget charging before the caller sees a result;
content-addressed caching; and **structured output with a bounded repair loop** —
parse, validate against the schema, hand the *specific* validation errors back
to the model, retry, and fail loudly rather than looping.

`generative: bool` distinguishes real providers from the offline fallback. The
offline provider is extractive — it quotes its input and satisfies schemas
minimally — so cognition checks the flag and uses its deterministic path instead
of burning calls on a provider that can only echo. Schema-valid emptiness is
worse than an honest heuristic.

---

## Cognition

### Intent

The stage that most determines output quality. "Make me a site for my bakery"
carries an unstated deliverable (files on disk, not a description of files) and
an unstated definition of done. Ambiguity is *recorded* — questions land in
`open_questions`, each with a working assumption so execution proceeds — and the
assumptions surface in the final report, so a wrong one is cheap to correct.

### The plan is a DAG

Not a list. That single choice enables everything else:

- independent work runs in parallel because the graph says it is independent;
- a failure cancels only the sub-graph that depended on it;
- a replan splices nodes into a running graph without restarting;
- the critical path is computable, so the scheduler prioritises the chain that
  determines total run time.

Steps consume each other's results through `${binding.field}` references
resolved at dispatch. The plan stays a *value* — serializable, inspectable,
diffable — rather than a closure over live objects. `normalize()` infers the
dependency edges those references imply, because requiring the planner to state
them twice is a reliable source of subtly wrong plans.

### Grounding

A generated plan is validated against the registry *before* execution: every
tool exists, arguments satisfy its schema, capabilities are within the grant.
Failures are handed back as specific errors for repair. A plan referencing an
invented tool never reaches the scheduler.

`HeuristicPlanner` produces a real, runnable plan from templates when no model
is available. The OS degrades to less ambitious work, never to no work.

### Verification

**A step that ran is not a step that worked.** A tool can exit zero having
written an empty file; a download can save a 404 page. So steps carry contracts —
`file_exists`, `file_contains`, `command_succeeds`, `url_ok`, `exit_zero` — and a
failed contract feeds the recovery engine exactly like a raised exception.

Checks are deterministic and independent of the tool that produced the output,
which is what makes them evidence rather than self-report. When a plan supplies
no contract, one is *derived* from the step's own arguments: a step that wrote a
path must have produced that path.

### Recovery

A failure is information, not a stop condition. The ladder, cheapest first:

| Strategy | When |
|---|---|
| `RETRY` | transient — network blip, lock contention, rate limit |
| `REPAIR` | arguments were wrong; fixed mechanically, or by a model against the schema |
| `SUBSTITUTE` | this tool can't; an equivalent one might (never at higher risk) |
| `DECOMPOSE` | the step was too coarse; split it and splice the children in |
| `SKIP` | the step was optional and the goal survives without it |
| `ESCALATE` | a human decision is genuinely required |
| `ABORT` | nothing left to try |

Two safeguards keep it from becoming an expensive loop: a per-step attempt
history so the same strategy is never retried, and a hard cap on total recovery
actions. Sandbox violations are never retried — an escape attempt is a refusal,
not a transient.

---

## Kernel

### The scheduler

Every step whose dependencies are satisfied is admitted immediately, up to
`max_parallel`, ordered by critical-path membership first. Failures block only
transitive dependents. Recovery can mutate the graph mid-run. A graph that can
make no further progress is *detected and reported*, never hung — every loop
iteration either completes work, admits work, or terminates.

`ScheduleResult.ok` is deliberately strict: cancelled steps and early stops are
not successes. Reporting otherwise is exactly the dishonesty the system exists
to avoid.

### The executor

Per step: resolve references → policy check → approval → invoke → verify →
recover, cycling until terminal. It never raises for an ordinary failure; only
cancellation propagates, because that must unwind.

### Replanning

Bounded and additive. On failure the kernel re-plans *with the failure evidence
in hand*, keeps everything that already succeeded, and executes only the new
work. Crucially, replanning does **not** fall back to heuristic templates —
splicing a generic template into a half-finished run adds unrelated work instead
of routing around the actual failure. Failing to replan is the honest outcome.

---

## Memory

Four kinds with genuinely different lifetimes: `preference`, `fact`, `episode`,
`lesson`. Failures become lessons, because those are what change future plans.

Retrieval blends lexical relevance with importance, recency and access count.
It runs **both** SQLite FTS5 (for BM25 weighting) and a portable stemmed-overlap
scorer, keeping the better score per memory — FTS5's Porter tokenizer is
asymmetric (it indexes `deployment` as `deploy` but stems the query `deploy` to
`deploi`), so a plain MATCH silently misses obviously relevant memories.

**Secrets are never written.** Values are checked on the way in and *refused*
rather than masked, so a leak cannot survive as a helpful memory.

---

## Design decisions worth defending

**Zero dependencies in the kernel.** A digital OS must boot on any machine with
CPython. It cost a JSON Schema validator, an HTTP client and a Markdown
renderer — all small, all better-fitted than the general-purpose libraries
(coercing model output, SSRF guards, single-file HTML).

**Everything injected.** Registry, model, memory, clock, approvals, policy. The
305-test suite runs in ~3 seconds with no network because there is no global to
monkey-patch.

**Events over return values.** The kernel doesn't know a terminal exists. Every
interface — console, ledger, report, memory — is a subscriber, so adding a web
UI is a subscription, not a refactor.

**Honest degradation.** No API key, no ffmpeg, no Playwright, no search backend:
the system says so and does what it can. `net.search` with no backend raises
rather than returning plausible-looking results — a search tool that invents
sources is worse than no search tool.
