import { config } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../lib/log.js';

const log = logger('rank');

/** Editorial weight per source tier, used to reward independent corroboration. */
const TIER_WEIGHT = { 1: 1, 2: 0.82, 3: 0.62 };

/** Eight independent outlets is treated as saturation for the corroboration signal. */
const CORROBORATION_SATURATION = Math.log2(9);

/**
 * Score every live story for the front page.
 *
 * "Trending" here means genuinely surfacing: independently corroborated, still
 * moving, and recent — not merely loud. Corroboration across separate newsrooms
 * is weighted heavily because it is the signal that most reliably separates a
 * real event from one outlet's aggregation.
 */
export function rankClusters({ db = getDb(), now = Date.now() } = {}) {
  const windowStart = now - config.pipeline.clusterWindowHours * 3_600_000;
  const recentCutoff = now - 6 * 3_600_000;

  const rows = db
    .prepare(`
      SELECT c.id,
             c.article_count,
             c.source_count,
             c.last_published_at,
             c.is_developing,
             s.importance AS importance,
             (SELECT COUNT(*) FROM articles a
               WHERE a.cluster_id = c.id AND a.published_at >= ?) AS recent_articles,
             (SELECT COALESCE(SUM(w.weight), 0) FROM (
                SELECT DISTINCT source_id,
                       CASE source_tier WHEN 1 THEN 1.0 WHEN 2 THEN 0.82 ELSE 0.62 END AS weight
                FROM articles WHERE cluster_id = c.id
              ) w) AS tier_weight
      FROM clusters c
      LEFT JOIN summaries s ON s.cluster_id = c.id
      WHERE c.last_published_at >= ?
    `)
    .all(recentCutoff, windowStart);

  if (rows.length === 0) return { ranked: 0 };

  const update = db.prepare('UPDATE clusters SET score = ? WHERE id = ?');
  const commit = db.transaction(() => {
    for (const row of rows) update.run(scoreCluster(row, now), row.id);
  });
  commit();

  log.debug(`ranked ${rows.length} stories`);
  return { ranked: rows.length };
}

export function scoreCluster(row, now = Date.now()) {
  // How many independent newsrooms picked this up.
  const corroboration = Math.min(1, Math.log2(1 + (row.source_count || 0)) / CORROBORATION_SATURATION);

  // Quality-adjusted breadth: three wire services outweigh three aggregators.
  const quality = Math.min(1, (row.tier_weight || 0) / 4);

  // Freshness, halving roughly every 10 hours.
  const hoursOld = Math.max(0, (now - row.last_published_at) / 3_600_000);
  const recency = Math.exp(-hoursOld / 10);

  // Still-arriving coverage — the difference between breaking and settled.
  const velocity = row.article_count > 0 ? Math.min(1, (row.recent_articles || 0) / 4) : 0;

  // The model's own read on how much this matters, once a briefing exists.
  const importance = row.importance != null ? row.importance / 100 : 0.45;

  const score =
    0.30 * corroboration +
    0.15 * quality +
    0.26 * recency +
    0.14 * velocity +
    0.15 * importance;

  return Math.round(Math.min(1, score) * 10_000) / 10_000;
}

/**
 * A story is "developing" only when its briefing has actually been revised by
 * newer coverage in the last few hours.
 *
 * The tempting definition — "recent and multi-source" — would badge nearly every
 * story on the front page, which tells the reader nothing. The point of the badge
 * is to warn that the account changed recently and may change again, so it is
 * tied to a recorded update, not to freshness.
 */
export function refreshDevelopingFlags({ db = getDb(), now = Date.now() } = {}) {
  const updateCutoff = now - 6 * 3_600_000;
  const result = db
    .prepare(`
      UPDATE clusters
         SET is_developing = CASE
               WHEN EXISTS (
                 SELECT 1 FROM story_updates u
                  WHERE u.cluster_id = clusters.id AND u.at >= ?
               ) THEN 1 ELSE 0 END
       WHERE last_published_at >= ?
    `)
    .run(updateCutoff, now - config.pipeline.clusterWindowHours * 3_600_000);
  return { updated: result.changes };
}

export { TIER_WEIGHT };
