import { isAvailable, structured } from '../ai/client.js';
import { SUMMARY_SCHEMA, SUMMARY_SYSTEM, UPDATE_SUFFIX } from '../ai/prompts.js';
import { verifyClaims } from '../ai/verify.js';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../lib/log.js';
import { sentences, truncate } from '../lib/text.js';

const log = logger('summarize');

/** A cluster with less source text than this can't produce an honest briefing. */
const MIN_TOTAL_WORDS = 60;

/**
 * Turn each pending cluster into a grounded, source-attributed briefing.
 *
 * Order of operations per story: gather the most informative coverage, write the
 * briefing against those excerpts only, then audit the result against the same
 * excerpts and strip anything that doesn't hold up.
 */
export async function summarizeClusters({ db = getDb(), limit, generator } = {}) {
  const cap = limit ?? config.pipeline.maxSummariesPerRun;

  const pending = db
    .prepare(`
      SELECT c.id, c.article_count, c.source_count, c.score, c.summarized_at,
             c.summarized_articles, c.lead_title, c.topic
      FROM clusters c
      WHERE c.needs_summary = 1
        AND c.source_count >= ?
        AND (SELECT COALESCE(SUM(word_count), 0) FROM articles WHERE cluster_id = c.id) >= ?
      ORDER BY c.score DESC, c.source_count DESC, c.last_published_at DESC
      LIMIT ?
    `)
    .all(config.pipeline.minSourcesForSummary, MIN_TOTAL_WORDS, cap);

  if (pending.length === 0) return { attempted: 0, written: 0, updated: 0, failed: 0, factsDropped: 0 };

  const write = generator ?? (isAvailable() ? aiBriefing : extractiveBriefing);
  const mode = generator ? 'injected' : isAvailable() ? 'ai' : 'extractive fallback';
  log.info(`summarizing ${pending.length} stories (${mode})`);

  const stats = { attempted: pending.length, written: 0, updated: 0, failed: 0, factsDropped: 0 };

  for (const cluster of pending) {
    try {
      const sourcesForStory = selectSources(db, cluster.id);
      if (sourcesForStory.length === 0) {
        markSkipped(db, cluster.id);
        continue;
      }

      const previous = cluster.summarized_at ? loadPrevious(db, cluster.id) : null;
      const pack = buildSourcePack(sourcesForStory);
      const briefing = await write({ cluster, sources: sourcesForStory, pack, previous });
      if (!briefing) {
        stats.failed += 1;
        markSkipped(db, cluster.id);
        continue;
      }

      const audit = config.pipeline.verifySummaries && isAvailable() && !generator
        ? await auditBriefing(briefing, pack)
        : { verified: 0, note: null, dropped: 0 };

      stats.factsDropped += audit.dropped;
      persist(db, cluster, briefing, sourcesForStory, audit, previous);
      if (previous) stats.updated += 1;
      stats.written += 1;
    } catch (error) {
      stats.failed += 1;
      log.warn(`story ${cluster.id} failed: ${error.message}`);
      // Leave needs_summary set so a transient failure is retried next cycle,
      // but stop it from monopolising the queue by pushing it behind fresh work.
      db.prepare('UPDATE clusters SET updated_at = ? WHERE id = ?').run(Date.now(), cluster.id);
    }
  }

  log.info(
    `wrote ${stats.written} briefings (${stats.updated} updates, ${stats.failed} failed, ` +
    `${stats.factsDropped} unsupported claims removed)`,
  );
  return stats;
}

/**
 * Pick the coverage to brief from.
 *
 * One article per outlet, best first — breadth across independent newsrooms is
 * what makes a combined account worth more than any single report, and it keeps
 * one prolific publisher from dominating the excerpt budget.
 */
export function selectSources(db, clusterId) {
  const articles = db
    .prepare(`
      SELECT id, url, title, source_id, source_name, source_tier, published_at,
             body, feed_summary, body_source, word_count, image_url
      FROM articles
      WHERE cluster_id = ?
      ORDER BY source_tier ASC, word_count DESC, published_at ASC
    `)
    .all(clusterId);

  const bestPerSource = new Map();
  for (const article of articles) {
    if (!bestPerSource.has(article.source_id)) bestPerSource.set(article.source_id, article);
  }

  return [...bestPerSource.values()]
    .filter((article) => (article.body || article.feed_summary || '').trim().length > 0)
    .sort((a, b) => a.source_tier - b.source_tier || b.word_count - a.word_count)
    .slice(0, config.text.maxSourcesPerSummary);
}

/** Render the excerpts the model is allowed to use, with stable [S#] labels. */
export function buildSourcePack(sources) {
  return sources
    .map((article, index) => {
      const when = new Date(article.published_at).toISOString().replace('T', ' ').slice(0, 16);
      const body = truncate(article.body || article.feed_summary || '', config.text.perSourceChars);
      const note = article.body_source === 'feed' ? ' [summary only — full text unavailable]' : '';
      return `[S${index + 1}] ${article.source_name} — ${when} UTC${note}\nHeadline: ${article.title}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}

async function aiBriefing({ cluster, sources, pack, previous }) {
  const system = previous ? `${SUMMARY_SYSTEM}\n${UPDATE_SUFFIX}` : SUMMARY_SYSTEM;

  const parts = [
    `${sources.length} article${sources.length === 1 ? '' : 's'} from ${new Set(sources.map((s) => s.source_name)).size} outlet(s) covering one event.`,
    '',
    'SOURCE EXCERPTS',
    '===============',
    pack,
  ];

  if (previous) {
    parts.push(
      '',
      'YOUR PREVIOUS BRIEFING FOR THIS STORY',
      '=====================================',
      `Headline: ${previous.headline}`,
      `What happened: ${previous.what_happened}`,
      `Current status: ${previous.current_status || '(none)'}`,
    );
  }

  parts.push('', 'Write the briefing using only the excerpts above.');

  const result = await structured({
    system,
    user: parts.join('\n'),
    schema: SUMMARY_SCHEMA,
    effort: config.ai.summaryEffort,
    maxTokens: 16000,
    label: `summary(story ${cluster.id})`,
  });

  return normalizeBriefing(result, sources);
}

/**
 * Deterministic fallback used when no API key is configured.
 *
 * It is genuinely extractive — every sentence is lifted verbatim from the
 * reporting — and it is labelled as such throughout the UI so nobody mistakes it
 * for a written summary.
 */
export function extractiveBriefing({ cluster, sources }) {
  const lead = sources[0];
  const body = lead.body || lead.feed_summary || '';
  const leadSentences = sentences(body);

  const facts = [];
  for (const article of sources) {
    for (const sentence of sentences(article.body || article.feed_summary || '')) {
      // Sentences carrying figures, dates or attribution are the ones a reader
      // actually needs; everything else is scene-setting.
      if (!/\d/.test(sentence) && !/\b(said|announced|confirmed|reported|according to)\b/i.test(sentence)) continue;
      facts.push({ fact: sentence, articleIds: [article.id] });
      break;
    }
    if (facts.length >= 5) break;
  }

  const outlets = [...new Set(sources.map((s) => s.source_name))];
  const latest = Math.max(...sources.map((s) => s.published_at));

  return {
    headline: lead.title.slice(0, 160),
    oneLiner: truncate(leadSentences[0] || lead.title, 200),
    whatHappened: leadSentences.slice(0, 3).join(' ') || lead.feed_summary || lead.title,
    whoIsInvolved: [],
    whyItMatters: '',
    keyFacts: facts,
    currentStatus:
      `Assembled from ${sources.length} report${sources.length === 1 ? '' : 's'} across ` +
      `${outlets.length} outlet${outlets.length === 1 ? '' : 's'}. Most recent coverage: ` +
      `${new Date(latest).toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
    disputes: [],
    whatsNew: '',
    topic: cluster.topic || 'world',
    importance: Math.min(90, 25 + outlets.length * 12),
    confidence: 'low',
    generator: 'extractive-fallback',
  };
}

/** Map the model's [S#] citations back to real article ids and clamp stray values. */
function normalizeBriefing(result, sources) {
  const byLabel = new Map(sources.map((article, index) => [`S${index + 1}`, article.id]));
  const resolve = (ids) => {
    const resolved = [];
    for (const raw of ids ?? []) {
      const label = String(raw).trim().toUpperCase().replace(/[^S\d]/g, '');
      const id = byLabel.get(label);
      if (id && !resolved.includes(id)) resolved.push(id);
    }
    // A fact with no resolvable citation still came from this excerpt set; fall
    // back to the lead source rather than presenting it as uncited.
    return resolved.length ? resolved : [sources[0].id];
  };

  return {
    headline: String(result.headline || '').trim().slice(0, 300),
    oneLiner: String(result.one_liner || '').trim().slice(0, 400),
    whatHappened: String(result.what_happened || '').trim(),
    whoIsInvolved: (result.who_is_involved ?? [])
      .filter((person) => person?.name)
      .slice(0, 10)
      .map((person) => ({ name: String(person.name).trim(), role: String(person.role || '').trim() })),
    whyItMatters: String(result.why_it_matters || '').trim(),
    keyFacts: (result.key_facts ?? [])
      .filter((entry) => entry?.fact)
      .slice(0, 8)
      .map((entry) => ({ fact: String(entry.fact).trim(), articleIds: resolve(entry.article_ids) })),
    currentStatus: String(result.current_status || '').trim(),
    disputes: (result.disputed_or_unclear ?? [])
      .filter((entry) => entry?.point)
      .slice(0, 6)
      .map((entry) => ({ point: String(entry.point).trim(), detail: String(entry.detail || '').trim() })),
    whatsNew: String(result.whats_new || '').trim(),
    topic: result.topic || 'world',
    importance: clamp(Number(result.importance) || 50, 0, 100),
    confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
    generator: config.ai.model,
  };
}

/**
 * Check the briefing against its own sources and remove what doesn't hold up.
 * Unsupported key facts are dropped outright; unsupported narrative sentences are
 * dropped when what remains still reads as an account of the event.
 */
async function auditBriefing(briefing, pack) {
  const narrative = sentences(briefing.whatHappened);
  const claims = [
    ...briefing.keyFacts.map((entry) => entry.fact),
    ...narrative,
  ];
  if (claims.length === 0) return { verified: 0, note: null, dropped: 0 };

  const { findings, checked, error } = await verifyClaims({ claims, sourcePack: pack });
  if (error || checked === 0) {
    return { verified: 0, note: 'Automated fact-check did not complete for this briefing.', dropped: 0 };
  }

  const bad = new Map();
  for (const finding of findings) {
    if (finding.verdict !== 'supported') bad.set(finding.index, finding);
  }
  if (bad.size === 0) return { verified: 1, note: null, dropped: 0 };

  const factCount = briefing.keyFacts.length;
  const keptFacts = briefing.keyFacts.filter((_, index) => !bad.has(index));
  const droppedFacts = factCount - keptFacts.length;
  briefing.keyFacts = keptFacts;

  const keptNarrative = narrative.filter((_, index) => !bad.has(factCount + index));
  let droppedNarrative = narrative.length - keptNarrative.length;
  if (keptNarrative.length > 0 && droppedNarrative > 0) {
    briefing.whatHappened = keptNarrative.join(' ');
  } else if (droppedNarrative > 0) {
    // Removing everything would leave no account at all — keep the text and let
    // the confidence downgrade and the note carry the warning instead.
    droppedNarrative = 0;
  }

  if (briefing.confidence === 'high') briefing.confidence = 'medium';
  else briefing.confidence = 'low';

  const parts = [];
  if (droppedFacts) parts.push(`${droppedFacts} key fact${droppedFacts === 1 ? '' : 's'}`);
  if (droppedNarrative) parts.push(`${droppedNarrative} summary sentence${droppedNarrative === 1 ? '' : 's'}`);
  const note = parts.length
    ? `Automated fact-check removed ${parts.join(' and ')} that could not be traced to the linked sources.`
    : 'Automated fact-check flagged wording that overstated the linked sources; confidence lowered.';

  return { verified: 0, note, dropped: droppedFacts + droppedNarrative };
}

function persist(db, cluster, briefing, sources, audit, previous) {
  const now = Date.now();
  const sourceCount = new Set(sources.map((s) => s.source_id)).size;

  const upsert = db.prepare(`
    INSERT INTO summaries
      (cluster_id, headline, one_liner, what_happened, why_it_matters, current_status,
       whats_new, topic, importance, confidence, generator, generated_at,
       verified, verification_note, source_count)
    VALUES
      (@clusterId, @headline, @oneLiner, @whatHappened, @whyItMatters, @currentStatus,
       @whatsNew, @topic, @importance, @confidence, @generator, @generatedAt,
       @verified, @verificationNote, @sourceCount)
    ON CONFLICT(cluster_id) DO UPDATE SET
      headline = excluded.headline, one_liner = excluded.one_liner,
      what_happened = excluded.what_happened, why_it_matters = excluded.why_it_matters,
      current_status = excluded.current_status, whats_new = excluded.whats_new,
      topic = excluded.topic, importance = excluded.importance,
      confidence = excluded.confidence, generator = excluded.generator,
      generated_at = excluded.generated_at, verified = excluded.verified,
      verification_note = excluded.verification_note, source_count = excluded.source_count
  `);

  const clearFacts = db.prepare('DELETE FROM summary_facts WHERE cluster_id = ?');
  const clearPeople = db.prepare('DELETE FROM summary_people WHERE cluster_id = ?');
  const clearDisputes = db.prepare('DELETE FROM summary_disputes WHERE cluster_id = ?');
  const insertFact = db.prepare(
    'INSERT INTO summary_facts (cluster_id, ord, fact, article_ids, supported) VALUES (?, ?, ?, ?, 1)',
  );
  const insertPerson = db.prepare('INSERT INTO summary_people (cluster_id, ord, name, role) VALUES (?, ?, ?, ?)');
  const insertDispute = db.prepare('INSERT INTO summary_disputes (cluster_id, ord, point, detail) VALUES (?, ?, ?, ?)');
  const insertUpdate = db.prepare(
    'INSERT INTO story_updates (cluster_id, at, whats_new, articles_added) VALUES (?, ?, ?, ?)',
  );
  const finishCluster = db.prepare(`
    UPDATE clusters
       SET needs_summary = 0, summarized_at = ?, summarized_articles = article_count,
           topic = ?, updated_at = ?,
           is_developing = ?
     WHERE id = ?
  `);

  const articlesAdded = Math.max(0, cluster.article_count - (cluster.summarized_articles || 0));
  // A story counts as developing when it keeps attracting fresh coverage after
  // it was first briefed — that's the signal a reader needs to know it may move.
  const developing = previous && articlesAdded > 0 ? 1 : 0;

  const commit = db.transaction(() => {
    upsert.run({
      clusterId: cluster.id,
      headline: briefing.headline || cluster.lead_title || 'Untitled story',
      oneLiner: briefing.oneLiner || null,
      whatHappened: briefing.whatHappened || briefing.oneLiner || '',
      whyItMatters: briefing.whyItMatters || null,
      currentStatus: briefing.currentStatus || null,
      whatsNew: briefing.whatsNew || null,
      topic: briefing.topic || cluster.topic || null,
      importance: briefing.importance ?? 50,
      confidence: briefing.confidence || 'medium',
      generator: briefing.generator,
      generatedAt: now,
      verified: audit.verified,
      verificationNote: audit.note,
      sourceCount,
    });

    clearFacts.run(cluster.id);
    clearPeople.run(cluster.id);
    clearDisputes.run(cluster.id);

    briefing.keyFacts.forEach((entry, index) => {
      insertFact.run(cluster.id, index, entry.fact, JSON.stringify(entry.articleIds));
    });
    briefing.whoIsInvolved.forEach((person, index) => {
      insertPerson.run(cluster.id, index, person.name, person.role || null);
    });
    briefing.disputes.forEach((entry, index) => {
      insertDispute.run(cluster.id, index, entry.point, entry.detail || null);
    });

    if (previous && briefing.whatsNew) {
      insertUpdate.run(cluster.id, now, briefing.whatsNew, articlesAdded);
    }

    finishCluster.run(now, briefing.topic || cluster.topic || null, now, developing, cluster.id);
  });
  commit();
}

function loadPrevious(db, clusterId) {
  return db
    .prepare('SELECT headline, what_happened, current_status FROM summaries WHERE cluster_id = ?')
    .get(clusterId);
}

function markSkipped(db, clusterId) {
  db.prepare('UPDATE clusters SET needs_summary = 0, updated_at = ? WHERE id = ?').run(Date.now(), clusterId);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
