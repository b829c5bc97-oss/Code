# AI Browser Tasks — Project Structure

**Status:** Design for approval. Companion to `ARCHITECTURE.md`. No implementation code.

A Turborepo + pnpm monorepo. `apps/*` are deployable units, `packages/*` are libraries with
no independent life cycle. Nothing in `packages/` may import from `apps/`, ever.

---

## 0. The rules that produce this layout

Six rules. Every folder below exists because of one of them.

1. **A folder is a boundary or it is noise.** If moving a file between two folders requires
   no import change and breaks nothing, those folders should be one folder.
2. **Dependencies point one way: `apps → packages → packages/shared`.** No cycles, enforced
   by lint rule, not by good intentions.
3. **Deployment shape dictates the top level.** Four things deploy independently → four
   entries in `apps/`. The web app can't run Playwright and the runner can't serve React,
   so they are not one codebase with flags.
4. **Feature-first inside apps, layer-first inside packages.** App code is organized by what
   the user does (`runs/`, `credentials/`); library code by what it *is* (`observation/`,
   `actions/`). Layer-first inside apps produces the `controllers/services/utils` sprawl
   where one feature touches nine folders.
5. **The security-critical surface gets its own package.** `crypto/` and `policy/` are small
   packages precisely so they are small enough to audit and hard to bypass by accident.
6. **Anything with a swap plan gets an interface package.** `llm/` and `browser/` exist as
   packages because we committed to swapping models and browser vendors later.

---

## 1. Root

```
ai-browser-tasks/
├── apps/                      # deployable services (see §2)
├── packages/                  # shared libraries (see §3)
├── infra/                     # Dockerfiles, Terraform, deploy configs (see §4)
├── docs/                      # architecture + runbooks (see §5)
├── e2e/                       # cross-service integration + site-fixture tests (see §6)
├── scripts/                   # repo-level dev/ops scripts
├── .github/                   # CI/CD workflows, PR + issue templates
├── .changeset/                # versioning for packages (only if we ever publish)
├── turbo.json                 # task graph: build/test/lint/typecheck pipelines + caching
├── pnpm-workspace.yaml        # workspace globs
├── package.json               # root scripts only — no runtime deps
├── tsconfig.base.json         # strict base config; every tsconfig extends it
├── .env.example               # every env var the repo reads, documented, never real values
├── docker-compose.yml         # local Postgres + Redis + MinIO, one command to a working dev env
└── README.md
```

| Folder | Purpose |
|---|---|
| `apps/` | Independently deployable processes. One folder = one Dockerfile or one Vercel project. |
| `packages/` | Code shared by ≥2 apps, or isolated because it's security-critical or swappable. |
| `infra/` | Everything about *running* the code. Kept out of app folders so ops changes don't churn app diffs. |
| `docs/` | Architecture, ADRs, runbooks. In-repo so it versions with the code that made it true. |
| `e2e/` | Tests that need more than one service alive. Cannot live inside any single app. |
| `scripts/` | Repo-wide tooling: seeding, key rotation, backfills, local bootstrap. |

---

## 2. `apps/` — the deployable units

### 2.1 `apps/web` — Next.js 15 (Vercel)

UI plus the control-plane API. The only tier a browser talks to.

```
apps/web/
├── src/
│   ├── app/
│   │   ├── (marketing)/            # public pages — own layout, no auth, SEO-tuned
│   │   ├── (auth)/                 # Clerk sign-in/sign-up/SSO callback routes
│   │   ├── (dashboard)/            # authenticated product surface
│   │   │   ├── tasks/              # list, create, detail, edit
│   │   │   ├── runs/               # history list + live run viewer
│   │   │   ├── schedules/          # cron management
│   │   │   ├── credentials/        # vault UI (write-mostly)
│   │   │   ├── sessions/           # connected sites + reauth / takeover entry
│   │   │   ├── settings/           # org, members, API keys, billing portal
│   │   │   └── layout.tsx
│   │   ├── api/                    # Route Handlers (see below)
│   │   └── layout.tsx
│   ├── features/                   # feature-first client+server logic
│   │   ├── tasks/                  # components/, hooks/, actions.ts, schemas.ts
│   │   ├── runs/
│   │   ├── schedules/
│   │   ├── credentials/
│   │   └── billing/
│   ├── components/                 # cross-feature primitives only (Button, Table, Dialog)
│   ├── server/                     # server-only: never imported by a client component
│   │   ├── auth/                   # Clerk session → User/Org resolution, role guards
│   │   ├── repositories/           # org-scoped Prisma access — the ONLY place Prisma is called
│   │   ├── services/               # use-cases: createRun, cancelRun, rotateCredential
│   │   ├── quota/                  # entitlement + concurrency + credit checks
│   │   └── events/                 # Redis pub/sub subscribe → SSE relay
│   ├── lib/                        # framework-agnostic web helpers (formatting, cn, fetcher)
│   └── styles/
├── public/
├── tests/
├── next.config.ts
└── tailwind.config.ts
```

| Folder | Why it exists |
|---|---|
| `app/(groups)/` | Route groups give each audience its own layout and auth posture without polluting URLs. Marketing is static and public; dashboard is dynamic and gated. |
| `app/api/` | Mutations, webhooks, and streaming. Reads happen in Server Components via repositories — no internal REST hop for data the server already has. |
| `features/` | A feature owns its components, hooks, server actions, and Zod schemas together. Deleting a feature means deleting one folder. |
| `components/` | Only what ≥2 features use. The moment something is used once, it belongs in that feature. This rule is what stops `components/` becoming a 200-file junk drawer. |
| `server/` | Hard server boundary, marked `import 'server-only'`. Anything reachable from a client component cannot live here — that's how secrets leak into bundles. |
| `server/repositories/` | The single choke point for tenant scoping. Every query takes `organizationId`. If Prisma is imported anywhere else, the lint rule fails the build. |
| `server/services/` | Business use-cases, so a Route Handler and a Server Action can share logic instead of duplicating it. |
| `server/quota/` | Isolated because entitlement checks must happen *before* enqueue, on every path, and are easy to forget. One module, called from every mutation. |

**`app/api/` shape:**
```
api/
├── runs/route.ts                   # POST create (quota → enqueue)
├── runs/[id]/route.ts              # GET status · DELETE cancel
├── runs/[id]/stream/route.ts       # SSE, resumable via Last-Event-ID
├── runs/[id]/input/route.ts        # POST answer to an ask_user pause
├── tasks/…  schedules/…  credentials/…
├── internal/                       # runner → control plane; service-JWT only, never public
│   ├── runs/[id]/events/route.ts   # event batch ingest
│   └── runs/[id]/claim/route.ts    # claim / heartbeat / release
└── webhooks/
    ├── stripe/route.ts             # signature-verified
    └── clerk/route.ts              # signature-verified
```
`internal/` is a separate tree so its auth middleware is unmistakable — mixing service
endpoints among user endpoints is how one ends up publicly callable.

### 2.2 `apps/runner` — the agent + browsers (Railway)

The most important folder in the repo.

```
apps/runner/
├── src/
│   ├── index.ts                    # boot: warm pool, register worker, install signal handlers
│   ├── worker/
│   │   ├── consumer.ts             # BullMQ subscription, concurrency = pool size
│   │   ├── heartbeat.ts            # 10s DB heartbeat + lock extension
│   │   ├── lifecycle.ts            # claim → execute → finalize, guaranteed cleanup
│   │   └── shutdown.ts             # SIGTERM: stop intake, drain in-flight, then exit
│   ├── agent/
│   │   ├── loop.ts                 # the plan → act → observe → verify cycle
│   │   ├── planner/                # prompt assembly + plan schema + plan validation
│   │   ├── executor/               # per-step tool-use loop, iteration caps
│   │   ├── verifier/               # success-criteria checking
│   │   ├── recovery/               # retry → replan → vision → ask_user → fail
│   │   ├── context/                # window management: recent obs + rolling summary
│   │   └── budget.ts               # per-run step/time/dollar ceilings
│   ├── skills/
│   │   ├── recorder.ts             # success → trajectory
│   │   ├── replayer.ts             # deterministic replay with anchor verification
│   │   ├── healer.ts               # repair a broken step, update the skill
│   │   └── signature.ts            # task → stable cache key
│   ├── artifacts/                  # download capture, screenshot + trace upload
│   ├── secrets/                    # resolve {{credential:…}} — the only plaintext site
│   ├── events/                     # emit RunEvent → Postgres + Redis pub/sub
│   ├── takeover/                   # live-view streaming + user handoff for 2FA/CAPTCHA
│   └── config/                     # env parsing, validated at boot, fail-fast
├── tests/
│   ├── unit/
│   └── fixtures/                   # frozen HTML pages — deterministic agent tests
└── Dockerfile                      # Playwright base image, non-root, Chromium deps
```

| Folder | Why it exists |
|---|---|
| `worker/` | Job mechanics, kept apart from agent reasoning. Retries, locks, and drains change for different reasons than prompts do. |
| `worker/shutdown.ts` | Its own file because graceful drain is where deploys corrupt runs. Explicit, testable, reviewable. |
| `agent/` | The reasoning core. Split by role (planner/executor/verifier/recovery) so each has isolated prompts and independent evals. |
| `agent/context/` | Separate because context-window management drives cost more than prompt wording does, and deserves its own tests. |
| `skills/` | The margin engine. Independent of the agent loop — replay must work with the LLM entirely unavailable. |
| `secrets/` | Tiny and isolated so "where can plaintext exist?" has a one-folder answer during audit. |
| `takeover/` | Real-time streaming has nothing in common with the batch agent loop; different transport, different failure modes. |
| `tests/fixtures/` | Frozen HTML pages. Agent tests must not depend on live Amazon — that's a flaky test suite and an ethics problem. |

### 2.3 `apps/scheduler`

```
apps/scheduler/src/
├── index.ts                        # 30s tick
├── leader.ts                       # Redis lock election, renewal, fencing
├── dispatcher.ts                   # claim due schedules (SKIP LOCKED) → enqueue
├── occurrence.ts                   # cron + IANA tz → next fire, DST-correct
└── policy.ts                       # overlap · catch-up · jitter · auto-disable
```
Separate app, not a cron inside the runner: a runner busy with 6 browsers must never delay
dispatch, and this needs exactly-one semantics where runners need many-of.

### 2.4 `apps/reaper`

```
apps/reaper/src/
├── jobs/stuck-runs.ts              # dead heartbeat → CRASHED → requeue or fail
├── jobs/orphan-browsers.ts         # kill Chromium PIDs past max TTL
├── jobs/artifact-gc.ts            # retention enforcement per plan
├── jobs/event-archival.ts          # RunEvent → object storage after 90d
└── jobs/usage-rollup.ts            # hourly usage → UsageDaily → Stripe metering
```
Isolated so janitorial work never competes with user-facing latency, and so one broken
maintenance job can't take the fleet down.

---

## 3. `packages/` — shared libraries

```
packages/
├── shared/          # contracts: Zod schemas, action defs, event types, error taxonomy
├── db/              # Prisma schema, migrations, org-scoped repositories, RLS policies
├── llm/             # LLMProvider interface + Anthropic/OpenAI/Bedrock adapters + prompts
├── browser/         # BrowserProvider, pool, observation builder, action executor
├── policy/          # domain allowlist, destructive gates, injection heuristics
├── crypto/          # envelope encryption, KMS, redaction
├── queue/           # BullMQ setup: queue names, job schemas, idempotency, backoff
├── observability/   # OTel setup, logger, metrics, redaction filter
├── ui/              # design system, only if a second frontend ever appears
└── config/          # shared eslint / tsconfig / tailwind presets
```

### `packages/shared` — the contract layer

```
shared/src/
├── actions/         # the tool schema the model may emit (click, type, extract, …)
├── observations/    # observation shape sent to the model
├── events/          # RunEvent union — one definition for runner, API, and UI
├── domain/          # enums: RunState, TriggerType, SideEffects, Role
├── errors/          # error taxonomy with user-facing message + retryability
└── plans/           # plan schema produced by the planner
```
Zero dependencies, imported by everything. Defining the action schema once is what stops the
runner and the UI disagreeing about what a `click` event contains. `errors/` is a package
concern because "is this retryable, and what do we tell the user?" must be answered
identically in four services.

### `packages/db`

```
db/
├── prisma/schema.prisma
├── prisma/migrations/
├── prisma/seed.ts
├── src/repositories/      # org-scoped accessors: tasks, runs, credentials, schedules
├── src/rls/               # Postgres RLS policy definitions + per-tx org context
└── src/client.ts          # singleton, PgBouncer-aware
```
Schema and access live together so a model change and its query changes land in one diff.
`rls/` is versioned SQL, not a console click — tenant isolation must be reviewable.

### `packages/llm`

```
llm/src/
├── provider.ts            # the LLMProvider interface
├── providers/             # anthropic.ts · openai.ts · bedrock.ts · vertex.ts
├── prompts/               # system prompts, versioned, per role
├── routing.ts             # role → model, per plan tier, per-org override
├── cache.ts               # prompt-cache breakpoint strategy
└── cost.ts                # token → USD by model
```
`prompts/` sits in a package, not inline in the runner, so prompts are diffable, versioned,
and testable against an eval set. `cost.ts` exists because per-run cost is a product metric,
not a footnote.

### `packages/browser`

```
browser/src/
├── provider.ts            # BrowserProvider interface (managed vs self-hosted)
├── providers/             # local.ts (Playwright) · browserbase.ts · steel.ts
├── pool/                  # warm pool, health checks, recycling, sizing
├── context/               # per-run context creation, storageState hydrate/persist
├── observation/           # a11y tree walk, ref stamping, pruning, token budgeting
├── actions/               # ref → Playwright locator, per-action timeouts, result envelope
├── fingerprint/           # UA/viewport/locale/tz, pinned per session
└── trace/                 # Playwright tracing capture on failure
```
A package rather than runner-internal because the vendor swap was a stated goal, and because
`observation/` and `actions/` are the two things needing the heaviest unit testing against
fixture pages.

### `packages/policy`

```
policy/src/
├── domains.ts             # ALLOW | REQUIRE_CONSENT | BLOCK, per-domain rate limits
├── destructive.ts         # purchase/submit/delete/send detection + confirmation gates
├── injection.ts           # untrusted-content heuristics + classifier call
├── egress.ts              # SSRF blocking: RFC1918, link-local, metadata IPs
└── evaluate.ts            # single entry point called before EVERY action
```
Deliberately one small package with one entry point. Security controls scattered across
call sites get bypassed; a single `evaluate()` in the action path cannot be forgotten.

### `packages/crypto`

```
crypto/src/
├── kms.ts                 # master key operations
├── envelope.ts            # per-org DEK wrap/unwrap, AES-256-GCM
├── credentials.ts         # credential encrypt/decrypt
├── storage-state.ts       # session blob encrypt/decrypt
└── redaction.ts           # scrub secrets from logs, events, screenshots
```
Smallest package in the repo, on purpose. It should be readable end-to-end in one sitting by
an auditor, and it's the only place plaintext handling is allowed to appear.

### `packages/queue`

```
queue/src/
├── queues.ts              # runs:interactive · runs:scheduled · runs:retry · maintenance
├── jobs/                  # job payload schemas
├── idempotency.ts         # Redis SET NX keys
├── backoff.ts             # retry policy by error class
└── limits.ts              # per-org and per-domain concurrency semaphores
```
Shared because web enqueues, scheduler enqueues, and runner consumes — three services that
must agree on payload shape and queue names or jobs vanish silently.

### `packages/observability`

```
observability/src/
├── tracing.ts             # OTel init + span helpers
├── logger.ts              # structured JSON, runId/orgId bound, redaction applied
├── metrics.ts             # counters/histograms with a shared naming convention
└── sentry.ts
```
Wired identically in all four apps. The redaction filter lives *inside* the logger so
bypassing it requires deliberately not using the logger.

---

## 4. `infra/`

```
infra/
├── docker/
│   ├── runner.Dockerfile           # Playwright base, non-root, seccomp profile
│   ├── scheduler.Dockerfile
│   └── reaper.Dockerfile
├── terraform/
│   ├── modules/                    # postgres · redis · kms · storage · dns
│   └── envs/                       # dev · staging · prod
├── railway/                        # service definitions, autoscaling on queue depth
├── vercel/                         # project config, env mapping
└── policies/
    ├── seccomp.json                # syscall restrictions for runner containers
    └── egress-allowlist.yaml       # network policy backing packages/policy/egress
```
Infra lives in-repo because "which flags does the runner container get?" is a security
answer that must be code-reviewed. `policies/` is separate from `terraform/` because those
files are read by the runtime, not just at provision time.

---

## 5. `docs/`

```
docs/
├── ARCHITECTURE.md
├── PROJECT_STRUCTURE.md
├── adr/                            # 0001-nextjs-over-fastapi.md, 0002-clerk.md, …
├── runbooks/                       # queue-backlog.md · browser-oom.md · key-rotation.md
│                                   #   stuck-runs.md · site-redesign-response.md
├── prompts/                        # prompt changelog + eval results per version
└── security/                       # threat model, data-flow diagrams, retention policy
```
ADRs capture *why* a decision was made so it isn't relitigated every quarter. Runbooks are
written before the incident, not during. `security/` will be requested verbatim during the
first enterprise deal.

---

## 6. `e2e/` and `scripts/`

```
e2e/
├── fixtures/sites/                 # self-hosted mock login/cart/table pages
├── suites/agent/                   # can the agent complete task X on fixture site Y?
├── suites/api/                     # auth, quota, tenant isolation (must-pass)
├── suites/resilience/              # kill a runner mid-run → does the reaper recover it?
└── harness/                        # spins up compose stack, seeds org, asserts

scripts/
├── bootstrap.ts                    # clone → working dev env in one command
├── seed-demo-org.ts
├── rotate-keys.ts                  # DEK rotation, runnable without downtime
├── replay-run.ts                   # re-run a stored trajectory locally for debugging
└── backfill/
```
`e2e/suites/agent/` against *fixture* sites is the single most valuable test asset here:
it's the only way to know a prompt or observation change didn't regress reliability, and it
runs in CI without hammering third-party sites.

`scripts/replay-run.ts` is what makes production failures debuggable on a laptop.

---

## 7. Dependency direction (enforced, not aspirational)

```
apps/web ─────┐
apps/runner ──┼──► packages/{db,llm,browser,policy,crypto,queue,observability} ──► packages/shared
apps/scheduler┤
apps/reaper ──┘
```

Rules enforced by `eslint-plugin-boundaries` in CI:

- `packages/*` must not import from `apps/*`.
- `packages/shared` must not import from any other package.
- Only `packages/db/src/repositories` may import the Prisma client.
- Only `packages/crypto` may touch KMS or handle plaintext secrets.
- `packages/browser/src/actions` must call `packages/policy` before executing.
- Client components must not import `apps/web/src/server/**`.

---

## 8. "Where does this go?" — the cheat sheet

| You're adding… | It goes in |
|---|---|
| A new agent tool (e.g. `upload_file`) | schema in `shared/actions`, impl in `browser/actions`, gate in `policy` |
| A new page in the dashboard | `web/app/(dashboard)/…` + logic in `web/features/…` |
| A new DB table | `db/prisma/schema.prisma` + repository + RLS policy, same PR |
| A new LLM provider | `llm/providers/` only — nothing else should change |
| A new background maintenance job | `apps/reaper/src/jobs/` |
| A new plan entitlement | `shared/domain` + `web/server/quota` + Stripe config |
| A prompt change | `llm/prompts/` + eval run recorded in `docs/prompts/` |
| A one-off data fix | `scripts/backfill/`, never a migration |

---

## 9. What I deliberately did not create

- **`utils/` or `helpers/`** — unnamed folders become dumping grounds. Helpers live beside
  what uses them, or earn a named module.
- **`types/`** — types belong with the code that owns them; a global types folder becomes a
  second, out-of-sync schema.
- **`apps/api`** — the control-plane API is Next.js Route Handlers. A fifth service would be
  a deploy target with no distinct scaling story.
- **`packages/ui`, populated** — the folder is reserved but stays empty until a second
  frontend exists. Extracting a design system for one consumer is premature.
- **Per-app `prisma/`** — one schema, one migration history. Two would guarantee drift.
