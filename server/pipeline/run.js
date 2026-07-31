import { adjudicatePairs } from '../ai/adjudicate.js';
import { isAvailable } from '../ai/client.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../lib/log.js';
import { clusterArticles } from './cluster.js';
import { extractArticles } from './extract.js';
import { ingest, prune } from './ingest.js';
import { rankClusters, refreshDevelopingFlags } from './rank.js';
import { summarizeClusters } from './summarize.js';

const log = logger('pipeline');

let running = false;
let timer = null;
let lastRun = null;

export function isRunning() {
  return running;
}

export function getLastRun() {
  return lastRun;
}

/**
 * One full cycle: pull the feeds, read the articles, work out which of them are
 * the same story, brief the ones worth briefing, then re-rank.
 *
 * Ranking runs twice on purpose. The first pass uses only structural signals
 * (corroboration, recency, velocity) to decide which stories are worth spending
 * a summarization call on; the second folds in the model's importance judgement
 * now that it exists.
 */
export async function runCycle({ db = getDb(), reason = 'scheduled' } = {}) {
  if (running) {
    log.warn('cycle already in progress, skipping');
    return { skipped: true };
  }
  running = true;

  const startedAt = Date.now();
  const runRow = db
    .prepare('INSERT INTO runs (started_at) VALUES (?)')
    .run(startedAt);
  const runId = Number(runRow.lastInsertRowid);
  const stats = { reason, aiEnabled: isAvailable() };

  try {
    log.info(`cycle start (${reason}${isAvailable() ? '' : ', AI disabled — extractive mode'})`);

    stats.ingest = await ingest({ db });
    stats.extract = await extractArticles({ db });
    stats.cluster = await clusterArticles({
      db,
      adjudicator: isAvailable() ? adjudicatePairs : null,
    });

    rankClusters({ db });
    stats.summarize = await summarizeClusters({ db });

    refreshDevelopingFlags({ db });
    rankClusters({ db });
    stats.prune = prune({ db });

    stats.durationMs = Date.now() - startedAt;
    db.prepare('UPDATE runs SET finished_at = ?, ok = 1, stats = ? WHERE id = ?')
      .run(Date.now(), JSON.stringify(stats), runId);

    lastRun = { at: startedAt, ok: true, durationMs: stats.durationMs, stats };
    log.info(`cycle done in ${stats.durationMs}ms`);
    return stats;
  } catch (error) {
    stats.durationMs = Date.now() - startedAt;
    db.prepare('UPDATE runs SET finished_at = ?, ok = 0, stats = ?, error = ? WHERE id = ?')
      .run(Date.now(), JSON.stringify(stats), String(error?.stack || error), runId);
    lastRun = { at: startedAt, ok: false, durationMs: stats.durationMs, error: String(error?.message || error) };
    log.error(`cycle failed: ${error?.message || error}`);
    throw error;
  } finally {
    running = false;
  }
}

export function startScheduler({ db = getDb() } = {}) {
  const intervalMs = Math.max(1, config.pipeline.intervalMinutes) * 60_000;

  const tick = () => {
    runCycle({ db, reason: 'scheduled' }).catch(() => {
      // runCycle already logged and recorded the failure; a bad cycle must not
      // take the scheduler — or the server — down with it.
    });
  };

  if (config.pipeline.runOnStart) setTimeout(tick, 2_000);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log.info(`scheduler started — every ${config.pipeline.intervalMinutes} minutes`);
  return () => stopScheduler();
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
