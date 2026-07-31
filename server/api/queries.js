import { usage as aiUsage, isAvailable } from '../ai/client.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getLastRun, isRunning } from '../pipeline/run.js';
import { allFeeds, SOURCES, TOPICS } from '../sources.js';

const LIST_COLUMNS = `
  c.id                 AS id,
  c.article_count      AS articleCount,
  c.source_count       AS sourceCount,
  c.first_published_at AS firstPublishedAt,
  c.last_published_at  AS lastPublishedAt,
  c.is_developing      AS isDeveloping,
  c.score              AS score,
  s.headline           AS headline,
  s.one_liner          AS oneLiner,
  s.topic              AS topic,
  s.importance         AS importance,
  s.confidence         AS confidence,
  s.verified           AS verified,
  s.verification_note  AS verificationNote,
  s.whats_new          AS whatsNew,
  s.generator          AS generator,
  s.generated_at       AS generatedAt
`;

/**
 * Front-page list. Only stories that actually have a briefing are returned —
 * we never show a headline we can't stand behind with sources.
 */
export function listStories({ topic, query, limit = 30, offset = 0, since } = {}, db = getDb()) {
  const clauses = ['s.cluster_id IS NOT NULL'];
  const params = {};

  if (topic && topic !== 'all') {
    clauses.push('s.topic = @topic');
    params.topic = topic;
  }
  if (since) {
    clauses.push('c.last_published_at >= @since');
    params.since = since;
  }

  let sql;
  const trimmed = (query || '').trim();
  if (trimmed) {
    params.match = toFtsQuery(trimmed);
    if (!params.match) return { stories: [], total: 0 };
    sql = `
      SELECT ${LIST_COLUMNS}, bm25(summaries_fts) AS rank
      FROM summaries_fts
      JOIN summaries s ON s.cluster_id = summaries_fts.rowid
      JOIN clusters  c ON c.id = s.cluster_id
      WHERE summaries_fts MATCH @match AND ${clauses.join(' AND ')}
      ORDER BY rank ASC, c.score DESC
      LIMIT @limit OFFSET @offset
    `;
  } else {
    sql = `
      SELECT ${LIST_COLUMNS}
      FROM clusters c
      JOIN summaries s ON s.cluster_id = c.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.score DESC, c.last_published_at DESC
      LIMIT @limit OFFSET @offset
    `;
  }

  const rows = db.prepare(sql).all({ ...params, limit: Math.min(limit, 100), offset });
  const stories = rows.map((row) => ({ ...shapeListRow(row), sources: topSources(db, row.id) }));

  const total = trimmed
    ? stories.length + offset
    : db
        .prepare(`SELECT COUNT(*) AS n FROM clusters c JOIN summaries s ON s.cluster_id = c.id WHERE ${clauses.join(' AND ')}`)
        .get(params)?.n ?? 0;

  return { stories, total };
}

export function getStory(id, db = getDb()) {
  const row = db
    .prepare(`
      SELECT ${LIST_COLUMNS},
             s.what_happened  AS whatHappened,
             s.why_it_matters AS whyItMatters,
             s.current_status AS currentStatus
      FROM clusters c
      JOIN summaries s ON s.cluster_id = c.id
      WHERE c.id = ?
    `)
    .get(id);
  if (!row) return null;

  const articles = db
    .prepare(`
      SELECT id, url, title, source_name AS sourceName, source_id AS sourceId,
             source_tier AS sourceTier, published_at AS publishedAt,
             body_source AS bodySource, word_count AS wordCount, image_url AS imageUrl
      FROM articles WHERE cluster_id = ?
      ORDER BY source_tier ASC, published_at ASC
    `)
    .all(id);

  const articlesById = new Map(articles.map((article) => [article.id, article]));

  const keyFacts = db
    .prepare('SELECT fact, article_ids AS articleIds FROM summary_facts WHERE cluster_id = ? ORDER BY ord')
    .all(id)
    .map((fact) => ({
      fact: fact.fact,
      // Resolve citations to the actual outlet + link, so every claim in the
      // briefing is one click from the reporting it came from.
      sources: safeParse(fact.articleIds)
        .map((articleId) => articlesById.get(articleId))
        .filter(Boolean)
        .map((article) => ({ id: article.id, name: article.sourceName, url: article.url })),
    }));

  return {
    ...shapeListRow(row),
    whatHappened: row.whatHappened,
    whyItMatters: row.whyItMatters || null,
    currentStatus: row.currentStatus || null,
    keyFacts,
    people: db
      .prepare('SELECT name, role FROM summary_people WHERE cluster_id = ? ORDER BY ord')
      .all(id),
    disputes: db
      .prepare('SELECT point, detail FROM summary_disputes WHERE cluster_id = ? ORDER BY ord')
      .all(id),
    updates: db
      .prepare('SELECT at, whats_new AS whatsNew, articles_added AS articlesAdded FROM story_updates WHERE cluster_id = ? ORDER BY at DESC')
      .all(id),
    articles,
    sources: topSources(db, id, 50),
  };
}

export function listTopics(db = getDb()) {
  const counts = db
    .prepare(`
      SELECT s.topic AS topic, COUNT(*) AS count
      FROM summaries s JOIN clusters c ON c.id = s.cluster_id
      WHERE s.topic IS NOT NULL
      GROUP BY s.topic
    `)
    .all();
  const byTopic = new Map(counts.map((row) => [row.topic, row.count]));
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  return {
    total,
    topics: TOPICS.map((topic) => ({ topic, count: byTopic.get(topic) ?? 0 })).filter((t) => t.count > 0),
  };
}

export function getStatus(db = getDb()) {
  const counts = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM articles)  AS articles,
        (SELECT COUNT(*) FROM clusters)  AS stories,
        (SELECT COUNT(*) FROM summaries) AS briefings,
        (SELECT COUNT(*) FROM articles WHERE body_source = 'extracted') AS fullTextArticles,
        (SELECT COUNT(*) FROM clusters WHERE needs_summary = 1) AS pendingBriefings
    `)
    .get();

  const feeds = db
    .prepare('SELECT source_id AS sourceId, feed_url AS url, ok, last_success AS lastSuccess, last_error AS lastError, items_last_run AS items FROM feed_status')
    .all();

  const lastRunRow = db.prepare('SELECT started_at, finished_at, ok, stats, error FROM runs ORDER BY started_at DESC LIMIT 1').get();

  return {
    ai: {
      enabled: isAvailable(),
      model: isAvailable() ? config.ai.model : null,
      mode: isAvailable() ? 'ai-summarization' : 'extractive-fallback',
      usage: { ...aiUsage },
    },
    pipeline: {
      running: isRunning(),
      intervalMinutes: config.pipeline.intervalMinutes,
      lastRun: getLastRun(),
      lastRunRecord: lastRunRow
        ? {
            startedAt: lastRunRow.started_at,
            finishedAt: lastRunRow.finished_at,
            ok: Boolean(lastRunRow.ok),
            stats: safeParse(lastRunRow.stats, null),
            error: lastRunRow.error,
          }
        : null,
    },
    content: counts,
    sources: {
      outlets: SOURCES.length,
      feedsConfigured: allFeeds().length,
      // Attempted vs healthy is the honest ratio: a feed we've never tried is not
      // the same as a feed that failed, and conflating them overstates breakage.
      feedsAttempted: feeds.length,
      feedsHealthy: feeds.filter((feed) => feed.ok).length,
      feeds,
    },
  };
}

export function listSources(db = getDb()) {
  const activity = db
    .prepare(`
      SELECT source_id AS sourceId, COUNT(*) AS articles, MAX(published_at) AS lastPublishedAt
      FROM articles GROUP BY source_id
    `)
    .all();
  const byId = new Map(activity.map((row) => [row.sourceId, row]));
  return SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    tier: source.tier,
    homepage: source.homepage,
    feeds: source.feeds.length,
    articles: byId.get(source.id)?.articles ?? 0,
    lastPublishedAt: byId.get(source.id)?.lastPublishedAt ?? null,
  })).sort((a, b) => b.articles - a.articles);
}

function shapeListRow(row) {
  return {
    id: row.id,
    headline: row.headline,
    oneLiner: row.oneLiner,
    topic: row.topic,
    importance: row.importance,
    confidence: row.confidence,
    verified: Boolean(row.verified),
    verificationNote: row.verificationNote,
    whatsNew: row.whatsNew || null,
    generator: row.generator,
    generatedAt: row.generatedAt,
    articleCount: row.articleCount,
    sourceCount: row.sourceCount,
    firstPublishedAt: row.firstPublishedAt,
    lastPublishedAt: row.lastPublishedAt,
    isDeveloping: Boolean(row.isDeveloping),
    score: row.score,
  };
}

function topSources(db, clusterId, limit = 6) {
  return db
    .prepare(`
      SELECT source_name AS name, source_tier AS tier, MIN(url) AS url, COUNT(*) AS articles
      FROM articles WHERE cluster_id = ?
      GROUP BY source_id
      ORDER BY source_tier ASC, articles DESC
      LIMIT ?
    `)
    .all(clusterId, limit);
}

/**
 * Turn free text into a safe FTS5 prefix query. User input is never passed
 * through raw — FTS operators in a search box would otherwise be a syntax error
 * at best and a surprise at worst.
 */
function toFtsQuery(input) {
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 1)
    .slice(0, 8);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

function safeParse(value, fallback = []) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
