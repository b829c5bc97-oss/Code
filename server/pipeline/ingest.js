import { config } from '../config.js';
import { getDb } from '../db.js';
import { parseFeed } from '../lib/feed.js';
import { fetchText, mapPool } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { stripHtml, truncate } from '../lib/text.js';
import { canonicalizeUrl } from '../lib/url.js';
import { allFeeds } from '../sources.js';

const log = logger('ingest');

const MAX_FUTURE_SKEW_MS = 6 * 3_600_000; // publishers occasionally post-date items

/**
 * Fetch every configured feed, normalize the items, and insert the ones we
 * haven't seen. Feed failures are recorded and skipped — one unreachable
 * publisher must never abort a cycle.
 */
export async function ingest({ db = getDb(), feeds = allFeeds(), fetcher = fetchText } = {}) {
  const startedAt = Date.now();
  const results = await mapPool(feeds, config.fetch.feedConcurrency, async (feed) => {
    const { text } = await fetcher(feed.url, {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    });
    return { feed, parsed: parseFeed(text) };
  });

  const insert = db.prepare(`
    INSERT INTO articles
      (url, guid, source_id, source_name, source_tier, feed_category, title,
       feed_summary, body, body_source, word_count, published_at, first_seen_at, image_url)
    VALUES
      (@url, @guid, @sourceId, @sourceName, @sourceTier, @feedCategory, @title,
       @feedSummary, @body, @bodySource, @wordCount, @publishedAt, @firstSeenAt, @imageUrl)
    ON CONFLICT(url) DO NOTHING
  `);

  const recordFeed = db.prepare(`
    INSERT INTO feed_status (source_id, feed_url, last_attempt, last_success, last_error, items_last_run, ok)
    VALUES (@sourceId, @feedUrl, @attempt, @success, @error, @items, @ok)
    ON CONFLICT(feed_url) DO UPDATE SET
      last_attempt   = excluded.last_attempt,
      last_success   = COALESCE(excluded.last_success, feed_status.last_success),
      last_error     = excluded.last_error,
      items_last_run = excluded.items_last_run,
      ok             = excluded.ok
  `);

  const stats = { feeds: feeds.length, feedsOk: 0, feedsFailed: 0, itemsSeen: 0, inserted: 0, errors: [] };
  const now = Date.now();

  const commit = db.transaction((batches) => {
    for (const batch of batches) {
      for (const row of batch.rows) {
        const info = insert.run(row);
        if (info.changes > 0) stats.inserted += 1;
      }
      recordFeed.run(batch.status);
    }
  });

  const batches = [];
  for (let i = 0; i < results.length; i += 1) {
    const outcome = results[i];
    const feed = feeds[i];

    if (!outcome?.ok) {
      stats.feedsFailed += 1;
      const message = outcome?.error?.message || 'Unknown feed error';
      stats.errors.push({ feed: feed.url, error: message });
      log.warn(`feed failed: ${feed.sourceName} — ${message}`);
      batches.push({
        rows: [],
        status: {
          sourceId: feed.sourceId, feedUrl: feed.url, attempt: now,
          success: null, error: message, items: 0, ok: 0,
        },
      });
      continue;
    }

    const { parsed } = outcome.value;
    stats.feedsOk += 1;
    stats.itemsSeen += parsed.items.length;

    const rows = [];
    for (const item of parsed.items) {
      const row = normalizeItem(item, feed, now);
      if (row) rows.push(row);
    }

    batches.push({
      rows,
      status: {
        sourceId: feed.sourceId, feedUrl: feed.url, attempt: now,
        success: now, error: null, items: rows.length, ok: 1,
      },
    });
  }

  commit(batches);

  log.info(
    `ingested ${stats.inserted} new of ${stats.itemsSeen} items ` +
    `(${stats.feedsOk}/${stats.feeds} feeds ok) in ${Date.now() - startedAt}ms`,
  );
  return stats;
}

function normalizeItem(item, feed, now) {
  const url = canonicalizeUrl(item.url);
  if (!/^https?:\/\//i.test(url)) return null;

  const title = stripHtml(item.title).slice(0, 400);
  if (title.length < 12) return null;

  // Feeds that omit a date, or date items in the future, get clamped to now —
  // otherwise a bad timestamp would silently distort recency ranking.
  let publishedAt = item.publishedAt ?? now;
  if (publishedAt > now + MAX_FUTURE_SKEW_MS) publishedAt = now;

  const feedSummary = truncate(stripHtml(item.summary), 2000);

  return {
    url,
    guid: item.guid || url,
    sourceId: feed.sourceId,
    sourceName: feed.sourceName,
    sourceTier: feed.tier,
    feedCategory: feed.category,
    title,
    feedSummary,
    // Feed text stands in as the body until extraction upgrades it. This is what
    // keeps the pipeline useful even when an article page can't be fetched.
    body: feedSummary || null,
    bodySource: feedSummary ? 'feed' : null,
    wordCount: feedSummary ? feedSummary.split(/\s+/).length : 0,
    publishedAt,
    firstSeenAt: now,
    imageUrl: item.imageUrl || null,
  };
}

/** Drop articles past the retention window, plus any clusters left empty behind them. */
export function prune({ db = getDb() } = {}) {
  const cutoff = Date.now() - config.pipeline.retentionDays * 86_400_000;
  const articles = db.prepare('DELETE FROM articles WHERE published_at < ?').run(cutoff);
  const clusters = db
    .prepare('DELETE FROM clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM articles WHERE cluster_id IS NOT NULL)')
    .run();
  if (articles.changes || clusters.changes) {
    log.info(`pruned ${articles.changes} articles and ${clusters.changes} empty clusters`);
  }
  return { articlesPruned: articles.changes, clustersPruned: clusters.changes };
}
