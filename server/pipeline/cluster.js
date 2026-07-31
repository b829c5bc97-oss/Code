import { config } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../lib/log.js';
import {
  buildIdf,
  cosine,
  countTerms,
  extractEntities,
  overlapCoefficient,
  tfidfVector,
  timeProximity,
  tokenize,
  topTerms,
} from '../lib/text.js';

const log = logger('cluster');

/** Beyond this gap, two articles are covering different news even if they read alike. */
const MAX_PAIR_GAP_MS = 48 * 3_600_000;
/** How much of an article body feeds the similarity signal. */
const PROFILE_CHARS = 1600;
/** Title terms count this many times, because headlines carry the event identity. */
const TITLE_WEIGHT = 3;
/** Working sets up to this size are compared exhaustively rather than via blocking. */
const EXHAUSTIVE_LIMIT = 150;

/**
 * Similarity between two article profiles.
 *
 * Lexical overlap alone merges "Fed holds rates" with "ECB holds rates"; entity
 * overlap alone merges every story that mentions the same country. Combining
 * them, then letting recency modulate the result, is what separates a genuine
 * same-event pair from a same-topic one.
 *
 * Weights and thresholds were calibrated against the fixture corpus in test/,
 * where same-event pairs score 0.22–0.60 and the hardest same-topic pair
 * (Fed holds rates vs ECB cuts rates, same day, same vocabulary) tops out at 0.08.
 */
export function similarity(a, b) {
  if (Math.abs(a.publishedAt - b.publishedAt) > MAX_PAIR_GAP_MS) return 0;
  const lexical = cosine(a.vector, b.vector);
  const entities = overlapCoefficient(a.entities, b.entities);
  const base = 0.55 * lexical + 0.45 * entities;
  // Time never carries a pair on its own — it can only shade the score by ±25%.
  return base * (0.75 + 0.25 * timeProximity(a.publishedAt, b.publishedAt));
}

function buildProfile(article, idf) {
  const titleText = `${article.title} `.repeat(TITLE_WEIGHT);
  const bodyText = (article.body || article.feed_summary || '').slice(0, PROFILE_CHARS);
  const counts = countTerms(tokenize(`${titleText} ${bodyText}`));
  return {
    id: article.id,
    sourceId: article.source_id,
    publishedAt: article.published_at,
    counts,
    vector: tfidfVector(counts, idf),
    entities: extractEntities(`${article.title}. ${bodyText}`),
  };
}

/**
 * Assign every unclustered article in the working window to a story.
 *
 * Articles attach to an existing cluster wherever possible, which is what keeps
 * story IDs — and therefore update history — stable across cycles.
 */
export async function clusterArticles({ db = getDb(), adjudicator = null } = {}) {
  const windowStart = Date.now() - config.pipeline.clusterWindowHours * 3_600_000;

  const articles = db
    .prepare(`
      SELECT id, title, feed_summary, body, source_id, feed_category, published_at, cluster_id
      FROM articles
      WHERE published_at >= ?
      ORDER BY published_at ASC
    `)
    .all(windowStart);

  if (articles.length === 0) return { considered: 0, attached: 0, created: 0, adjudicated: 0, touched: [] };

  // IDF over the whole working window, so "tariff" is rare in a week of general
  // news but unremarkable in a week dominated by trade coverage.
  const rawCounts = articles.map((article) =>
    countTerms(tokenize(`${`${article.title} `.repeat(TITLE_WEIGHT)} ${(article.body || article.feed_summary || '').slice(0, PROFILE_CHARS)}`)),
  );
  const idf = buildIdf(rawCounts);

  const profiles = new Map();
  for (const article of articles) profiles.set(article.id, buildProfile(article, idf));

  const clustered = articles.filter((a) => a.cluster_id !== null);
  const unclustered = articles.filter((a) => a.cluster_id === null);

  const stats = { considered: unclustered.length, attached: 0, created: 0, adjudicated: 0 };
  if (unclustered.length === 0) {
    return { ...stats, touched: [] };
  }

  const touched = new Set();
  const clusterProfiles = buildClusterProfiles(clustered, profiles);
  const greyQueue = [];

  // ---- Phase 1: attach to the story that already exists ---------------------
  const assignments = new Map(); // articleId -> clusterId
  for (const article of unclustered) {
    const profile = profiles.get(article.id);
    let best = null;
    for (const cluster of clusterProfiles.values()) {
      const score = similarity(profile, cluster);
      if (!best || score > best.score) best = { score, cluster };
    }
    if (!best) continue;

    if (best.score >= config.cluster.joinThreshold) {
      assignments.set(article.id, best.cluster.clusterId);
      absorb(best.cluster, profile);
      touched.add(best.cluster.clusterId);
      stats.attached += 1;
    } else if (best.score >= config.cluster.greyLow) {
      greyQueue.push({ kind: 'cluster', article, profile, cluster: best.cluster, score: best.score });
    }
  }

  // ---- Phase 2: group the leftovers with each other -------------------------
  const leftovers = unclustered.filter((article) => !assignments.has(article.id));
  const leftoverProfiles = leftovers.map((article) => profiles.get(article.id));
  const pairs = candidatePairs(leftoverProfiles);
  const union = new UnionFind(leftovers.map((a) => a.id));

  for (const [i, j] of pairs) {
    const a = leftoverProfiles[i];
    const b = leftoverProfiles[j];
    const score = similarity(a, b);
    if (score >= config.cluster.joinThreshold) {
      union.join(a.id, b.id);
    } else if (score >= config.cluster.greyLow) {
      greyQueue.push({ kind: 'pair', a, b, score });
    }
  }

  // ---- AI adjudication of the genuinely ambiguous cases ---------------------
  if (adjudicator && greyQueue.length) {
    greyQueue.sort((x, y) => y.score - x.score);
    const batch = greyQueue.slice(0, config.cluster.maxAdjudications);
    try {
      const verdicts = await adjudicator(batch.map(toAdjudicationCase(db, profiles)));
      stats.adjudicated = batch.length;
      for (let i = 0; i < batch.length; i += 1) {
        if (verdicts.get(i) !== true) continue;
        const item = batch[i];
        if (item.kind === 'cluster') {
          if (assignments.has(item.article.id)) continue;
          assignments.set(item.article.id, item.cluster.clusterId);
          absorb(item.cluster, item.profile);
          touched.add(item.cluster.clusterId);
          stats.attached += 1;
        } else {
          if (assignments.has(item.a.id) || assignments.has(item.b.id)) continue;
          union.join(item.a.id, item.b.id);
        }
      }
    } catch (error) {
      // Adjudication is an enhancement, never a dependency. Fall back to the
      // conservative outcome: leave ambiguous pairs unmerged.
      log.warn(`adjudication unavailable, keeping ambiguous stories separate: ${error.message}`);
    }
  }

  // ---- Persist -------------------------------------------------------------
  const groups = new Map();
  for (const article of leftovers) {
    if (assignments.has(article.id)) continue;
    const root = union.find(article.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(article.id);
  }

  const createCluster = db.prepare(`
    INSERT INTO clusters (created_at, updated_at, first_published_at, last_published_at, needs_summary)
    VALUES (?, ?, ?, ?, 1)
  `);
  const assign = db.prepare('UPDATE articles SET cluster_id = ?, clustered_at = ? WHERE id = ?');
  const now = Date.now();

  const commit = db.transaction(() => {
    for (const [articleId, clusterId] of assignments) assign.run(clusterId, now, articleId);

    for (const memberIds of groups.values()) {
      const members = memberIds.map((id) => profiles.get(id));
      const first = Math.min(...members.map((m) => m.publishedAt));
      const last = Math.max(...members.map((m) => m.publishedAt));
      const info = createCluster.run(now, now, first, last);
      const clusterId = Number(info.lastInsertRowid);
      for (const id of memberIds) assign.run(clusterId, now, id);
      touched.add(clusterId);
      stats.created += 1;
    }
  });
  commit();

  refreshClusterStats(db, [...touched]);

  log.info(
    `clustered ${stats.considered} new articles → ${stats.attached} attached, ` +
    `${stats.created} new stories (${stats.adjudicated} pairs adjudicated)`,
  );
  return { ...stats, touched: [...touched] };
}

/** Centroid + entity union per existing cluster, so a story matches as a whole. */
function buildClusterProfiles(clusteredArticles, profiles) {
  const byCluster = new Map();
  for (const article of clusteredArticles) {
    const profile = profiles.get(article.id);
    if (!profile) continue;
    let cluster = byCluster.get(article.cluster_id);
    if (!cluster) {
      cluster = {
        clusterId: article.cluster_id,
        vector: new Map(),
        entities: new Set(),
        publishedAt: profile.publishedAt,
        members: 0,
      };
      byCluster.set(article.cluster_id, cluster);
    }
    absorb(cluster, profile);
  }
  return byCluster;
}

/** Fold an article profile into a cluster profile and renormalize the centroid. */
function absorb(cluster, profile) {
  for (const [term, weight] of profile.vector) {
    cluster.vector.set(term, (cluster.vector.get(term) || 0) + weight);
  }
  let norm = 0;
  for (const weight of cluster.vector.values()) norm += weight * weight;
  norm = Math.sqrt(norm) || 1;
  for (const [term, weight] of cluster.vector) cluster.vector.set(term, weight / norm);

  if (cluster.entities.size < 200) {
    for (const entity of profile.entities) cluster.entities.add(entity);
  }
  cluster.publishedAt = Math.max(cluster.publishedAt, profile.publishedAt);
  cluster.members += 1;
}

/**
 * Candidate pairs via rare-term blocking. Comparing every article to every other
 * is O(n²); indexing on the highest-IDF terms cuts it to the pairs that could
 * plausibly match, which is what keeps a cycle fast as volume grows.
 *
 * Below EXHAUSTIVE_LIMIT we skip blocking entirely and compare everything. That
 * is not just an optimisation shortcut — on a small working set, IDF is flat and
 * a document's highest-weight terms are its *unique* ones, so the index would
 * find almost no shared terms and silently miss real matches. Blocking is a
 * scale tactic; at small n, exhaustive is both cheaper to reason about and exact.
 */
function candidatePairs(profiles) {
  if (profiles.length <= EXHAUSTIVE_LIMIT) {
    const pairs = [];
    for (let i = 0; i < profiles.length; i += 1) {
      for (let j = i + 1; j < profiles.length; j += 1) pairs.push([i, j]);
    }
    return pairs;
  }

  const index = new Map();
  profiles.forEach((profile, position) => {
    for (const term of topTerms(profile.vector, config.cluster.blockingTerms)) {
      if (!index.has(term)) index.set(term, []);
      index.get(term).push(position);
    }
  });

  const sharedCounts = new Map();
  for (const positions of index.values()) {
    // A term appearing in a huge share of the corpus is not discriminating.
    if (positions.length < 2 || positions.length > 60) continue;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const key = positions[i] * 100_000 + positions[j];
        sharedCounts.set(key, (sharedCounts.get(key) || 0) + 1);
      }
    }
  }

  const pairs = [];
  for (const [key, count] of sharedCounts) {
    if (count < config.cluster.minSharedBlockingTerms) continue;
    pairs.push([Math.floor(key / 100_000), key % 100_000]);
  }
  return pairs;
}

function toAdjudicationCase(db, profiles) {
  const getArticle = db.prepare('SELECT title, feed_summary, body, source_name, published_at FROM articles WHERE id = ?');
  const getClusterSample = db.prepare(`
    SELECT title, feed_summary, body, source_name, published_at
    FROM articles WHERE cluster_id = ?
    ORDER BY source_tier ASC, published_at ASC LIMIT 1
  `);

  return (item) => {
    if (item.kind === 'cluster') {
      return { left: getClusterSample.get(item.cluster.clusterId), right: getArticle.get(item.article.id) };
    }
    return { left: getArticle.get(item.a.id), right: getArticle.get(item.b.id) };
  };
}

/**
 * Recompute the denormalized counters a cluster carries, and decide whether the
 * story now needs a fresh summary.
 */
export function refreshClusterStats(db, clusterIds) {
  if (!clusterIds?.length) return;

  const summary = db.prepare(`
    SELECT COUNT(*) AS articles,
           COUNT(DISTINCT source_id) AS sources,
           MIN(published_at) AS first_at,
           MAX(published_at) AS last_at
    FROM articles WHERE cluster_id = ?
  `);
  const lead = db.prepare(`
    SELECT title, feed_category FROM articles
    WHERE cluster_id = ?
    ORDER BY source_tier ASC, word_count DESC, published_at ASC
    LIMIT 1
  `);
  const topicVote = db.prepare(`
    SELECT feed_category AS topic, COUNT(*) AS n FROM articles
    WHERE cluster_id = ? AND feed_category IS NOT NULL
    GROUP BY feed_category ORDER BY n DESC LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE clusters SET
      article_count = @articles,
      source_count = @sources,
      first_published_at = @firstAt,
      last_published_at = @lastAt,
      lead_title = @leadTitle,
      topic = COALESCE(topic, @topic),
      updated_at = @now,
      needs_summary = CASE WHEN @articles > summarized_articles THEN 1 ELSE needs_summary END
    WHERE id = @id
  `);
  const dropEmpty = db.prepare('DELETE FROM clusters WHERE id = ? AND article_count = 0');

  const now = Date.now();
  const commit = db.transaction(() => {
    for (const id of clusterIds) {
      const counts = summary.get(id);
      if (!counts || counts.articles === 0) {
        dropEmpty.run(id);
        continue;
      }
      const leadRow = lead.get(id);
      update.run({
        id,
        articles: counts.articles,
        sources: counts.sources,
        firstAt: counts.first_at,
        lastAt: counts.last_at,
        leadTitle: leadRow?.title ?? null,
        topic: topicVote.get(id)?.topic ?? leadRow?.feed_category ?? null,
        now,
      });
    }
  });
  commit();
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression keeps repeated lookups flat.
    let cursor = id;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  join(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}
