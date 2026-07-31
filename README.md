# Brief

An AI news summarization platform. It reads the day's coverage from established
outlets, works out which articles are describing **the same event**, and writes a
short, source-attributed briefing for each one.

The problem it solves is information overload. Hundreds of articles are published
every day, ten of them about the same thing, each taking several minutes to read.
Brief sits between you and that firehose: open it, understand what happened in a
minute, and decide what's worth reading in full.

It is explicitly **not** a replacement for news organisations. Every fact in a
briefing links back to the outlet that reported it, and those links are the point.

---

## What it actually does

```
 feeds ──▶ ingest ──▶ extract ──▶ cluster ──▶ rank ──▶ summarize ──▶ verify ──▶ serve
           RSS/Atom   full text   same-event  what's   grounded      strip      REST +
           41 feeds   via         grouping    surfacing briefing     unsupported reading
           22 outlets Readability                                    claims      UI
```

**Ingest.** Pulls 41 RSS/Atom feeds across 22 outlets — wire services and public
broadcasters (AP, BBC, NPR, Guardian, Al Jazeera, CBC, DW, France 24), major
nationals, and specialist desks for tech, business, science, sport and culture.
A dead feed is recorded and skipped; it never takes down a cycle.

**Extract.** Fetches each article and pulls the real body text with Readability,
because a summary written from a two-sentence RSS teaser is a summary of a teaser.
Where a page can't be read, the feed summary stands in and the article is flagged
so we don't keep re-fetching it.

**Cluster.** The core of the product. Articles are grouped into events using
TF-IDF cosine similarity plus named-entity overlap, modulated by publication time.
Clear matches merge automatically; genuinely borderline pairs — and only those —
are handed to the model with one question: *same specific event, or just the same
subject?* Everything below the grey floor is never sent, so adjudication spend
tracks real ambiguity.

New coverage attaches to the story that already exists rather than starting a new
one, which is what keeps story identity — and update history — stable over time.

**Rank.** Surfacing is driven by independent corroboration (how many separate
newsrooms picked it up), source quality, recency, velocity of new coverage, and
the model's own importance judgement. Corroboration is weighted heavily because it
is the signal that most reliably separates a real event from one outlet's
aggregation.

**Summarize.** Each story gets a briefing built from up to eight outlets' coverage
— one article per outlet, so breadth across newsrooms beats depth from one.
The briefing answers exactly the questions a reader has:

| Field | What it gives you |
|---|---|
| What happened | 2–4 sentences of plain narrative |
| Who is involved | People, organisations and countries, with their role |
| Why it matters | Concrete stakes, grounded in the reporting |
| Key facts | 3–6 checkable facts, **each citing the outlets that support it** |
| Where it stands | What's settled, what's still moving |
| Disputed or unclear | Where sources conflict or the reporting flags uncertainty |

**Verify.** Every briefing is then audited against the same excerpts by a second
call with one narrow job: *is this claim actually in the text?* Claims that come
back unsupported or overstated are **removed**, confidence is downgraded, and the
UI says what was dropped. This is the backstop for the failure mode that matters:
confident, plausible, wrong.

---

## Accuracy, concretely

Accuracy here is enforced by the pipeline, not just requested in a prompt:

- **Closed-book by construction.** The model only ever sees the source excerpts.
  The prompt states it has no independent knowledge of the event.
- **Attribution is structural.** Key facts carry source ids that are resolved back
  to real article rows; a fact that cites nothing is pinned to its lead source, and
  the UI links every one.
- **Hedging is preserved.** "Reportedly", "at least", "police said" must survive
  into the briefing; upgrading an allegation into a fact is called out as an error.
- **Disagreement is surfaced, not resolved.** Where outlets conflict, that conflict
  is shown to the reader instead of being silently averaged away.
- **Unsupported claims are deleted.** Not flagged — removed, before you see them.
- **Conservative merging.** When the model can't tell whether two articles describe
  the same event, they stay apart. A wrong merge produces a briefing that conflates
  two events, which is worse than showing two cards.
- **Freshness is explicit.** Stories revised by newer coverage carry a "Developing"
  badge and a what's-new line, with a timeline of how the story moved.

---

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional, see below
npm start                             # http://localhost:3000
```

The first cycle starts a few seconds after boot and takes a minute or two — it
fetches every feed, reads several hundred articles, groups them and writes the
briefings. The page fills in as it goes; press **Refresh** to force a cycle.

To run a single cycle without the server (for cron):

```bash
npm run refresh
```

### Running without an API key

It works, and it tells you so. Ingestion, extraction, clustering and ranking are
all deterministic and need no model at all, so you still get real news grouped by
event and ranked. Each briefing becomes a clearly-labelled **verbatim extract**
rather than a written summary, borderline clusters stay unmerged, and the UI shows
a banner explaining the degraded mode. Set the key and restart to enable the real
thing.

---

## Configuration

Everything is environment-driven; see [`.env.example`](.env.example) for the full
list with comments. The ones that matter most:

| Variable | Default | What it controls |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables AI summarization, verification and adjudication |
| `BRIEF_MODEL` | `claude-opus-5` | Model for all three AI tasks |
| `BRIEF_SUMMARY_EFFORT` | `high` | Effort for briefings — the quality dial |
| `BRIEF_UTILITY_EFFORT` | `low` | Effort for verification and adjudication |
| `BRIEF_INTERVAL_MINUTES` | `15` | How often a full cycle runs |
| `BRIEF_MAX_SUMMARIES` | `40` | Hard cap on briefings per cycle — the main cost lever |
| `BRIEF_VERIFY` | `true` | Second-pass fact-check (one extra call per story) |
| `BRIEF_JOIN_THRESHOLD` | `0.30` | Auto-merge threshold for same-event detection |
| `BRIEF_GREY_LOW` | `0.15` | Floor below which pairs are never adjudicated |

### Cost control

Three mechanisms keep spend proportional to value:

1. **Only changed stories are briefed.** A story is re-summarized when it gains
   coverage, not on every cycle.
2. **Hard per-cycle caps** on extractions, summaries and adjudications.
3. **Prompt caching** on the long, stable grounding prompt, so its cost is paid
   roughly once per cycle rather than once per story. Live token counts, including
   cache hits, are on `/api/status`.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/stories?topic=&q=&limit=&offset=&hours=` | Ranked briefings, with search and topic filter |
| `GET /api/stories/:id` | Full briefing: facts with resolved sources, people, disputes, update timeline, every article |
| `GET /api/topics` | Topics that currently have stories, with counts |
| `GET /api/sources` | Configured outlets and their article volume |
| `GET /api/status` | Pipeline health, feed health, content counts, AI mode and token usage |
| `POST /api/refresh` | Trigger a cycle (returns `202` immediately) |

---

## Testing

```bash
npm test
```

36 tests, fully offline — network is stubbed with a fixture corpus, so the suite
runs anywhere and is deterministic. It exercises the real ingestion, extraction,
clustering, ranking, summarization and query code.

The clustering assertions are the interesting ones. The fixture corpus contains
five events, and two of them — *"Fed holds rates at 4.25%"* and *"ECB cuts rates to
2.75%"* — are same-week, same-beat, near-identical vocabulary. A naive bag-of-words
approach merges them. The suite asserts every event's coverage lands in exactly one
story and no two events are ever merged, plus:

- the grey band routes borderline pairs to the adjudicator, and a failing
  adjudicator degrades to "leave them apart" instead of crashing
- 240 articles across 120 events cluster correctly through the blocking path
- new coverage attaches to the existing story rather than forking a new one
- every key fact resolves to a real, linkable article in its own cluster

Scoring weights and thresholds were calibrated against this corpus rather than
guessed: same-event pairs score 0.22–0.60, and the hardest same-topic pair reaches
0.08.

---

## Layout

```
server/
  config.js            environment-driven configuration
  db.js                SQLite schema (articles, clusters, summaries, updates, FTS)
  sources.js           curated feed registry with editorial tiers
  ai/
    client.js          Anthropic client: structured JSON, prompt caching, usage accounting
    prompts.js         grounding contract, verification and adjudication prompts
    adjudicate.js      same-event-or-not, batched
    verify.js          claim-level audit against source text
  pipeline/
    ingest.js          feed fetching, normalization, dedupe, retention
    extract.js         article body extraction
    cluster.js         event grouping: similarity, blocking, incremental assignment
    rank.js            trending/importance scoring, developing-story detection
    summarize.js       briefing generation, verification, update detection
    run.js             cycle orchestration and scheduler
  api/                 REST routes and read queries
public/                reading UI (no build step)
test/                  offline fixture corpus and end-to-end suite
```

No build step, no bundler. Node 20+ and SQLite via `better-sqlite3`.

---

## Known limitations

- **Paywalled outlets extract poorly.** Where the body can't be read, the briefing
  falls back to the feed summary, which is thinner. Those articles are marked
  `summary only` in the source pack the model sees.
- **English-language sources only** in the current registry.
- **Clustering is tuned for discrete events.** Ongoing situations — a long war, an
  election campaign — produce many correctly-separated stories rather than one
  running thread. That is the intended trade-off, but it means the front page can
  carry several related cards.
- **Importance scoring is a judgement call**, and a general-audience one. A story
  that matters enormously to a specific field may rank low.
