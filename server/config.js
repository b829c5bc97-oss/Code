import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v, fallback) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'brief.db'),

  ai: {
    // The API key drives everything AI. Without it the pipeline still runs
    // (ingest → cluster → rank) and produces clearly-labelled extractive digests.
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.BRIEF_MODEL || 'claude-opus-5',
    // Effort is the main cost lever. Summaries get the higher setting because
    // accuracy matters most there; adjudication and verification are cheaper calls.
    summaryEffort: process.env.BRIEF_SUMMARY_EFFORT || 'high',
    utilityEffort: process.env.BRIEF_UTILITY_EFFORT || 'low',
    maxRetries: num(process.env.BRIEF_AI_MAX_RETRIES, 3),
    requestTimeoutMs: num(process.env.BRIEF_AI_TIMEOUT_MS, 180_000),
  },

  fetch: {
    userAgent:
      process.env.BRIEF_USER_AGENT ||
      'BriefNewsReader/1.0 (+https://github.com/brief-news; summarization with source attribution)',
    timeoutMs: num(process.env.BRIEF_FETCH_TIMEOUT_MS, 15_000),
    feedConcurrency: num(process.env.BRIEF_FEED_CONCURRENCY, 8),
    articleConcurrency: num(process.env.BRIEF_ARTICLE_CONCURRENCY, 6),
    perHostDelayMs: num(process.env.BRIEF_PER_HOST_DELAY_MS, 700),
    maxArticleBytes: num(process.env.BRIEF_MAX_ARTICLE_BYTES, 3_000_000),
  },

  pipeline: {
    // How often a full cycle runs. News moves fast; 15 minutes keeps the front
    // page current without hammering publishers.
    intervalMinutes: num(process.env.BRIEF_INTERVAL_MINUTES, 15),
    runOnStart: bool(process.env.BRIEF_RUN_ON_START, true),
    // Only articles inside this window are eligible for clustering, so a story
    // from last week can't absorb today's coverage.
    clusterWindowHours: num(process.env.BRIEF_CLUSTER_WINDOW_HOURS, 72),
    // Articles older than this are dropped from the working set entirely.
    retentionDays: num(process.env.BRIEF_RETENTION_DAYS, 14),
    // Cap on how many articles get full-text extraction per cycle.
    maxExtractionsPerRun: num(process.env.BRIEF_MAX_EXTRACTIONS, 220),
    // Cap on how many stories get (re)summarized per cycle — the main cost control.
    maxSummariesPerRun: num(process.env.BRIEF_MAX_SUMMARIES, 40),
    // A single-source story needs to look important before we spend a summary on it.
    minSourcesForSummary: num(process.env.BRIEF_MIN_SOURCES, 1),
    verifySummaries: bool(process.env.BRIEF_VERIFY, true),
  },

  cluster: {
    // Pair scores at or above this are the same event, no questions asked.
    // Calibrated on the fixture corpus in test/, where same-event pairs score
    // 0.22–0.60 and the closest same-topic-different-event pair reaches 0.08.
    joinThreshold: num(process.env.BRIEF_JOIN_THRESHOLD, 0.3),
    // Scores in [greyLow, joinThreshold) are genuinely ambiguous — this is where
    // asking the model "same event or not?" earns its keep. Unrelated pairs sit
    // well below this, so adjudication spend stays proportional to real doubt.
    greyLow: num(process.env.BRIEF_GREY_LOW, 0.15),
    // Ceiling on how many ambiguous pairs we pay to adjudicate per cycle.
    maxAdjudications: num(process.env.BRIEF_MAX_ADJUDICATIONS, 60),
    // Number of rare terms per article used to build the candidate-pair index.
    blockingTerms: num(process.env.BRIEF_BLOCKING_TERMS, 14),
    // Candidate pairs must share at least this many rare terms.
    minSharedBlockingTerms: num(process.env.BRIEF_MIN_SHARED_TERMS, 2),
  },

  text: {
    // Characters of article body sent to the model per source.
    perSourceChars: num(process.env.BRIEF_PER_SOURCE_CHARS, 6000),
    // Max sources included in one summarization prompt.
    maxSourcesPerSummary: num(process.env.BRIEF_MAX_SOURCES_PER_SUMMARY, 8),
  },
};

export const aiEnabled = () => Boolean(config.ai.apiKey);
