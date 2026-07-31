/**
 * End-to-end pipeline test, entirely offline.
 *
 * It runs the real ingestion, extraction, clustering, ranking, summarization and
 * query code against a fixture corpus, with network calls stubbed. The strongest
 * assertion here is the clustering one: five events, eight articles, and two of
 * those events (Fed / ECB) are close enough in vocabulary that a naive
 * bag-of-words approach merges them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import { parseFeed } from '../server/lib/feed.js';
import { extractEntities, jaccard, sentences, truncate } from '../server/lib/text.js';
import { canonicalizeUrl } from '../server/lib/url.js';
import { config } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { ingest, prune } from '../server/pipeline/ingest.js';
import { extractArticles, extractReadableText } from '../server/pipeline/extract.js';
import { clusterArticles, refreshClusterStats } from '../server/pipeline/cluster.js';
import { rankClusters, refreshDevelopingFlags, scoreCluster } from '../server/pipeline/rank.js';
import { summarizeClusters, buildSourcePack, selectSources } from '../server/pipeline/summarize.js';
import { getStory, listStories, listTopics } from '../server/api/queries.js';
import { allArticles, articlePage, buildFeeds, createFixtureFetcher, EVENTS } from './fixtures.mjs';

let db;
let tmpDir;
let fixture;

/** Articles are stored under their canonical URL, so tests must look them up that way. */
const storedUrl = (article) => canonicalizeUrl(article.url);

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));
  db = openDatabase(path.join(tmpDir, 'test.db'));
  fixture = createFixtureFetcher();
});

after(() => {
  db?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------- units

describe('feed parsing', () => {
  test('parses RSS 2.0 with CDATA descriptions', () => {
    const feed = buildFeeds().find((f) => f.sourceId === 'bbc');
    const { items } = parseFeed(feed.xml);
    assert.equal(items.length, EVENTS.quake.filter((a) => a.outlet === 'bbc').length);
    assert.match(items[0].title, /earthquake/i);
    assert.match(items[0].url, /^https:\/\//);
    assert.ok(items[0].publishedAt > Date.now() - 12 * 3_600_000);
    assert.ok(items[0].summary.length > 40);
  });

  test('parses Atom entries and resolves alternate links', () => {
    const feed = buildFeeds().find((f) => f.sourceId === 'npr');
    const { items } = parseFeed(feed.xml);
    assert.ok(items.length >= 1);
    assert.match(items[0].url, /^https:\/\/www\.npr\.org/);
    assert.ok(Number.isFinite(items[0].publishedAt));
  });

  test('rejects payloads that are not feeds', () => {
    assert.throws(() => parseFeed('<html><body>not a feed</body></html>'), /Unrecognised feed format/);
    assert.throws(() => parseFeed(''), /Empty feed/);
  });
});

describe('url canonicalization', () => {
  test('strips tracking parameters and normalizes the host', () => {
    assert.equal(
      canonicalizeUrl('https://WWW.Example.com/story/?utm_source=twitter&id=7&fbclid=xyz#top'),
      'https://www.example.com/story?id=7',
    );
  });

  test('keeps the www prefix, since the canonical URL is also the link we serve', () => {
    assert.equal(canonicalizeUrl('https://www.bbc.com/news/x'), 'https://www.bbc.com/news/x');
  });

  test('leaves unparsable input alone', () => {
    assert.equal(canonicalizeUrl('not a url'), 'not a url');
  });
});

describe('text analysis', () => {
  test('entity extraction finds proper nouns, not common headline words', () => {
    const entities = extractEntities(
      'Japan Meteorological Agency Issues Tsunami Advisory After Quake Near Sendai. ' +
      'Officials said waves reached 30 centimetres.',
    );
    const joined = [...entities].join(' ');
    assert.match(joined, /japan meteorological agency|sendai/);
    // Title-cased filler must not be mistaken for a named entity.
    assert.ok(!entities.has('issues'), 'common verb leaked into entity set');
    assert.ok(!entities.has('after'), 'preposition leaked into entity set');
  });

  test('entity overlap separates same-topic, different-event coverage', () => {
    const fed = extractEntities(EVENTS.fed[0].body);
    const fedOther = extractEntities(EVENTS.fed[1].body);
    const ecb = extractEntities(EVENTS.ecb[0].body);
    assert.ok(
      jaccard(fed, fedOther) > jaccard(fed, ecb),
      'two reports of the same decision should share more entities than two different decisions',
    );
  });

  test('truncate cuts at a sentence boundary when one is close to the limit', () => {
    const output = truncate('Alpha beta gamma delta epsilon. Zeta eta theta iota kappa lambda.', 45);
    assert.equal(output, 'Alpha beta gamma delta epsilon.');
  });

  test('truncate falls back to an ellipsis when the boundary is too far back', () => {
    // Cutting at the boundary here would throw away more than half the budget,
    // so an ellipsis preserves more of the text.
    const output = truncate('Short one. Then a considerably longer sentence that runs on.', 48);
    assert.ok(output.endsWith('…'), `expected an ellipsis, got: ${output}`);
  });

  test('sentence splitting ignores fragments', () => {
    const parts = sentences(EVENTS.quake[0].body);
    assert.ok(parts.length >= 3);
    assert.ok(parts.every((sentence) => sentence.length > 30));
  });
});

describe('article extraction', () => {
  test('pulls the article body and drops navigation and boilerplate', () => {
    const article = EVENTS.quake[0];
    const body = extractReadableText(articlePage(article), article.url);
    assert.ok(body.length > 400, `body too short: ${body.length}`);
    assert.match(body, /Japan Meteorological Agency/);
    assert.ok(!/Most read/.test(body), 'sidebar content leaked into the extracted body');
    assert.ok(!/Copyright test fixture/.test(body), 'footer leaked into the extracted body');
  });

  test('returns empty for pages with no article content', () => {
    assert.equal(extractReadableText('<html><body><p>hi</p></body></html>', 'https://x.test/a'), '');
  });
});

// ------------------------------------------------------------------ pipeline

describe('pipeline end to end', () => {
  test('ingest stores every fixture article exactly once', async () => {
    const stats = await ingest({ db, feeds: fixture.feeds, fetcher: fixture.fetcher });
    const expected = allArticles().length;

    assert.equal(stats.feedsFailed, 0);
    assert.equal(stats.inserted, expected);

    const count = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    assert.equal(count, expected);

    // Re-ingesting the same feeds must not duplicate anything.
    const second = await ingest({ db, feeds: fixture.feeds, fetcher: fixture.fetcher });
    assert.equal(second.inserted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, expected);
  });

  test('a feed failure is contained and recorded', async () => {
    const broken = [
      ...fixture.feeds,
      { sourceId: 'dead', sourceName: 'Dead Feed', tier: 3, homepage: 'https://dead.test',
        url: 'https://feeds.test/dead.xml', category: 'world' },
    ];
    const stats = await ingest({ db, feeds: broken, fetcher: fixture.fetcher });

    assert.equal(stats.feedsFailed, 1);
    assert.equal(stats.feedsOk, fixture.feeds.length);
    const status = db.prepare('SELECT ok, last_error FROM feed_status WHERE feed_url = ?')
      .get('https://feeds.test/dead.xml');
    assert.equal(status.ok, 0);
    assert.ok(status.last_error);
  });

  test('extraction upgrades feed blurbs to full article text', async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE body_source = 'feed'").get().n;
    assert.ok(before > 0);

    const stats = await extractArticles({ db, fetcher: fixture.fetcher });
    assert.equal(stats.extracted, allArticles().length);
    assert.equal(stats.failed, 0);

    const extracted = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE body_source = 'extracted'").get().n;
    assert.equal(extracted, allArticles().length);

    const sample = db.prepare('SELECT body, word_count FROM articles WHERE url = ?').get(storedUrl(EVENTS.quake[0]));
    assert.ok(sample.word_count > 80, `expected a full body, got ${sample.word_count} words`);
    assert.match(sample.body, /Onagawa/);
  });

  test('clustering groups coverage by event and keeps distinct events apart', async () => {
    const stats = await clusterArticles({ db });
    assert.equal(stats.considered, allArticles().length);

    const rows = db
      .prepare('SELECT url, cluster_id FROM articles WHERE cluster_id IS NOT NULL')
      .all();
    assert.equal(rows.length, allArticles().length, 'every article should land in a story');

    const clusterByUrl = new Map(rows.map((row) => [row.url, row.cluster_id]));
    const clusterFor = (article) => clusterByUrl.get(storedUrl(article));

    // Same event, different outlets → one story.
    for (const [name, articles] of Object.entries(EVENTS)) {
      const ids = new Set(articles.map(clusterFor));
      assert.equal(ids.size, 1, `"${name}" coverage split across ${ids.size} stories`);
    }

    // Different events → different stories. Fed vs ECB is the hard pair: same
    // week, same beat, same vocabulary, different central bank and decision.
    const keys = Object.keys(EVENTS);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        assert.notEqual(
          clusterFor(EVENTS[keys[i]][0]),
          clusterFor(EVENTS[keys[j]][0]),
          `"${keys[i]}" and "${keys[j]}" were merged into one story`,
        );
      }
    }

    const clusterCount = db.prepare('SELECT COUNT(*) AS n FROM clusters').get().n;
    assert.equal(clusterCount, Object.keys(EVENTS).length);

    // Denormalized counters must match reality.
    const quake = db
      .prepare('SELECT article_count, source_count FROM clusters WHERE id = ?')
      .get(clusterFor(EVENTS.quake[0]));
    assert.equal(quake.article_count, EVENTS.quake.length);
    assert.equal(quake.source_count, EVENTS.quake.length);
  });

  test('new coverage attaches to the existing story rather than starting a new one', async () => {
    const quakeCluster = db
      .prepare('SELECT cluster_id AS id FROM articles WHERE url = ?')
      .get(storedUrl(EVENTS.quake[0])).id;
    const clustersBefore = db.prepare('SELECT COUNT(*) AS n FROM clusters').get().n;

    const followUp = {
      outlet: 'skynews',
      url: 'https://news.sky.com/story/japan-honshu-earthquake-update-2026',
      title: 'Japan earthquake: Shinkansen services resume after Honshu tremor inspections',
      hoursAgo: 1,
      category: 'world',
      summary: 'Rail services resumed after inspections following the magnitude 7.1 earthquake off northern Honshu.',
      body:
        'Bullet train services across northern Japan resumed on Tuesday evening after inspections found no ' +
        'damage from the magnitude 7.1 earthquake off the coast of northern Honshu. ' +
        'JR East had suspended Shinkansen services along the northern corridor as a precaution when the ' +
        'quake struck near Sendai. The Japan Meteorological Agency had issued and then lifted a tsunami ' +
        'advisory for Miyagi and Iwate prefectures. ' +
        'Tohoku Electric Power repeated that the Onagawa nuclear plant was operating normally. Officials in ' +
        'Ishinomaki said no injuries had been confirmed.',
    };

    const feed = {
      sourceId: 'skynews', sourceName: 'Sky News', tier: 2, homepage: 'https://news.sky.com',
      url: 'https://feeds.test/skynews.xml', category: 'world',
    };
    const followUpFetcher = async (url) => {
      if (url === feed.url) {
        return {
          text: `<?xml version="1.0"?><rss version="2.0"><channel><title>Sky News</title>
            <item><title>${followUp.title}</title><link>${followUp.url}</link>
            <guid>${followUp.url}</guid>
            <pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate>
            <description>${followUp.summary}</description></item>
          </channel></rss>`,
          url,
          contentType: 'application/xml',
        };
      }
      if (url === followUp.url) return { text: articlePage(followUp), url, contentType: 'text/html' };
      return fixture.fetcher(url);
    };

    await ingest({ db, feeds: [feed], fetcher: followUpFetcher });
    await extractArticles({ db, fetcher: followUpFetcher });
    const stats = await clusterArticles({ db });

    assert.equal(stats.attached, 1, 'follow-up coverage should attach to the existing story');
    assert.equal(stats.created, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clusters').get().n, clustersBefore);

    const attachedTo = db.prepare('SELECT cluster_id AS id FROM articles WHERE url = ?').get(storedUrl(followUp)).id;
    assert.equal(attachedTo, quakeCluster, 'follow-up joined the wrong story');

    const cluster = db.prepare('SELECT article_count, source_count, needs_summary FROM clusters WHERE id = ?')
      .get(quakeCluster);
    assert.equal(cluster.article_count, EVENTS.quake.length + 1);
    assert.equal(cluster.source_count, EVENTS.quake.length + 1);
    assert.equal(cluster.needs_summary, 1, 'a story that gained coverage must be re-briefed');
  });

  test('ranking puts the widely corroborated, still-moving story on top', () => {
    const { ranked } = rankClusters({ db });
    assert.ok(ranked >= Object.keys(EVENTS).length);

    const ordered = db.prepare('SELECT id, score, source_count FROM clusters ORDER BY score DESC').all();
    assert.ok(ordered[0].score > 0);
    assert.ok(ordered[0].score >= ordered.at(-1).score);

    const quakeCluster = db.prepare('SELECT cluster_id AS id FROM articles WHERE url = ?')
      .get(storedUrl(EVENTS.quake[0])).id;
    assert.equal(ordered[0].id, quakeCluster, 'the four-outlet, freshest story should rank first');
  });

  test('score responds to corroboration and recency in the right direction', () => {
    const now = Date.now();
    const base = {
      article_count: 3, source_count: 3, last_published_at: now - 3_600_000,
      is_developing: 0, importance: 60, recent_articles: 2, tier_weight: 2.8,
    };
    const single = { ...base, source_count: 1, tier_weight: 1 };
    const stale = { ...base, last_published_at: now - 40 * 3_600_000, recent_articles: 0 };

    assert.ok(scoreCluster(base, now) > scoreCluster(single, now), 'corroboration should raise the score');
    assert.ok(scoreCluster(base, now) > scoreCluster(stale, now), 'staleness should lower the score');
  });

  test('source selection picks one article per outlet, best first', () => {
    const quakeCluster = db.prepare('SELECT cluster_id AS id FROM articles WHERE url = ?')
      .get(storedUrl(EVENTS.quake[0])).id;
    const sources = selectSources(db, quakeCluster);

    const outlets = sources.map((source) => source.source_id);
    assert.equal(new Set(outlets).size, outlets.length, 'the same outlet appeared twice');
    assert.ok(sources.length >= 3);
    assert.ok(sources[0].source_tier <= sources.at(-1).source_tier, 'sources should be ordered by tier');

    const pack = buildSourcePack(sources);
    assert.match(pack, /\[S1\]/);
    assert.match(pack, new RegExp(`\\[S${sources.length}\\]`));
    assert.match(pack, /Headline:/);
  });

  test('summarization writes a briefing per story with attributed facts', async () => {
    const stats = await summarizeClusters({ db });
    assert.ok(stats.written >= Object.keys(EVENTS).length, `only wrote ${stats.written} briefings`);
    assert.equal(stats.failed, 0);

    const summaries = db.prepare('SELECT * FROM summaries').all();
    assert.equal(summaries.length, Object.keys(EVENTS).length);

    for (const summary of summaries) {
      assert.ok(summary.headline?.length > 10, 'briefing has no headline');
      assert.ok(summary.what_happened?.length > 40, 'briefing has no narrative');
      assert.ok(['high', 'medium', 'low'].includes(summary.confidence));
      // Without an API key the run must fall back, and must say so.
      assert.equal(summary.generator, 'extractive-fallback');
    }

    const facts = db.prepare('SELECT cluster_id, fact, article_ids FROM summary_facts').all();
    assert.ok(facts.length > 0, 'no key facts were recorded');
    for (const fact of facts) {
      const ids = JSON.parse(fact.article_ids);
      assert.ok(Array.isArray(ids) && ids.length > 0, 'a key fact carries no source attribution');
      for (const id of ids) {
        const article = db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(id);
        assert.ok(article, `fact cites article ${id}, which does not exist`);
        assert.equal(article.cluster_id, fact.cluster_id, 'fact cites an article from another story');
      }
    }

    const pending = db.prepare('SELECT COUNT(*) AS n FROM clusters WHERE needs_summary = 1').get().n;
    assert.equal(pending, 0, 'every story should have been briefed');
  });

  test('a custom generator drives the update path and records what changed', async () => {
    const quakeCluster = db.prepare('SELECT cluster_id AS id FROM articles WHERE url = ?')
      .get(storedUrl(EVENTS.quake[0])).id;

    // Simulate one more outlet publishing on this story after it was first briefed.
    const now = Date.now();
    db.prepare(`
      INSERT INTO articles (url, guid, source_id, source_name, source_tier, feed_category,
                            title, feed_summary, body, body_source, word_count,
                            published_at, first_seen_at, cluster_id, clustered_at)
      VALUES (@url, @url, 'france24', 'France 24', 1, 'world', @title, @summary, @body,
              'extracted', 90, @now, @now, @cluster, @now)
    `).run({
      url: 'https://www.france24.com/en/asia-pacific/20260731-japan-quake-advisory-lifted',
      title: 'Japan lifts tsunami advisory after magnitude 7.1 Honshu earthquake',
      summary: 'The advisory for Miyagi and Iwate was withdrawn after waves of about 30cm were recorded.',
      body:
        'Japan lifted its tsunami advisory on Tuesday following the magnitude 7.1 earthquake off ' +
        'northern Honshu. The Japan Meteorological Agency said waves of roughly 30 centimetres were ' +
        'recorded at Ishinomaki before the advisory for Miyagi and Iwate prefectures was withdrawn. ' +
        'JR East resumed Shinkansen services after inspections found no damage.',
      now,
      cluster: quakeCluster,
    });
    refreshClusterStats(db, [quakeCluster]);

    const beforeUpdate = db.prepare('SELECT article_count, summarized_articles, needs_summary FROM clusters WHERE id = ?')
      .get(quakeCluster);
    assert.equal(beforeUpdate.needs_summary, 1, 'fresh coverage should flag the story for re-briefing');
    assert.ok(beforeUpdate.article_count > beforeUpdate.summarized_articles);

    let sawPrevious = false;
    await summarizeClusters({
      db,
      generator: async ({ cluster, sources, pack, previous }) => {
        if (cluster.id !== quakeCluster) return null;
        sawPrevious = Boolean(previous);
        assert.ok(pack.includes('[S1]'), 'generator was not given a source pack');
        return {
          headline: 'Tsunami advisory lifted after Honshu earthquake',
          oneLiner: 'Japan lifted its advisory with no casualties reported.',
          whatHappened: 'A magnitude 7.1 earthquake struck off northern Honshu and the advisory was later lifted.',
          whoIsInvolved: [{ name: 'Japan Meteorological Agency', role: 'Issued and lifted the advisory' }],
          whyItMatters: 'Coastal communities were briefly at risk of a one-metre wave.',
          keyFacts: [{ fact: 'The advisory was lifted hours after being issued.', articleIds: [sources[0].id] }],
          currentStatus: 'Rail services have resumed; aftershocks remain possible.',
          disputes: [],
          whatsNew: 'The tsunami advisory has now been lifted and rail services have resumed.',
          topic: 'world',
          importance: 72,
          confidence: 'high',
          generator: 'test-generator',
        };
      },
    });

    assert.ok(sawPrevious, 'the previous briefing should be passed in on a re-summarization');

    const summary = db.prepare('SELECT * FROM summaries WHERE cluster_id = ?').get(quakeCluster);
    assert.equal(summary.generator, 'test-generator');
    assert.equal(summary.importance, 72);
    assert.match(summary.whats_new, /lifted/);

    const updates = db.prepare('SELECT * FROM story_updates WHERE cluster_id = ?').all(quakeCluster);
    assert.equal(updates.length, 1, 'the change should be recorded in the story timeline');
    assert.equal(updates[0].articles_added, 1, 'the update should record how much new coverage arrived');

    const people = db.prepare('SELECT * FROM summary_people WHERE cluster_id = ?').all(quakeCluster);
    assert.equal(people.length, 1);
    assert.equal(people[0].name, 'Japan Meteorological Agency');
  });

  test('the developing flag marks only stories whose briefing was actually revised', () => {
    const quakeCluster = db.prepare('SELECT cluster_id AS id FROM articles WHERE url = ?')
      .get(storedUrl(EVENTS.quake[0])).id;

    refreshDevelopingFlags({ db });

    const developing = db.prepare('SELECT id FROM clusters WHERE is_developing = 1').all();
    assert.deepEqual(
      developing.map((row) => row.id),
      [quakeCluster],
      'only the story with a recorded update should carry the developing badge',
    );

    // A stale update must let the badge clear rather than pinning it forever.
    db.prepare('UPDATE story_updates SET at = ? WHERE cluster_id = ?')
      .run(Date.now() - 48 * 3_600_000, quakeCluster);
    refreshDevelopingFlags({ db });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clusters WHERE is_developing = 1').get().n, 0);
  });
});

// ---------------------------------------------------------------------- API

describe('read API', () => {
  test('lists ranked stories with their outlets', () => {
    const { stories, total } = listStories({ limit: 10 }, db);
    assert.equal(total, Object.keys(EVENTS).length);
    assert.ok(stories.length > 0);

    const top = stories[0];
    assert.ok(top.headline);
    assert.ok(Array.isArray(top.sources) && top.sources.length > 0);
    assert.ok(top.sourceCount >= 1);
    for (let i = 1; i < stories.length; i += 1) {
      assert.ok(stories[i - 1].score >= stories[i].score, 'stories came back out of rank order');
    }
  });

  test('filters by topic', () => {
    const { stories } = listStories({ topic: 'business', limit: 10 }, db);
    assert.ok(stories.length > 0);
    assert.ok(stories.every((story) => story.topic === 'business'));
  });

  test('full-text search matches briefing content', () => {
    const { stories } = listStories({ query: 'earthquake', limit: 10 }, db);
    assert.ok(stories.length > 0, 'search returned nothing for a term in the corpus');
    assert.match(JSON.stringify(stories[0]).toLowerCase(), /earthquake|honshu|tsunami/);
  });

  test('search input containing FTS syntax does not blow up', () => {
    for (const query of ['AND OR "', '*', 'NEAR(', ')))', '']) {
      assert.doesNotThrow(() => listStories({ query, limit: 5 }, db));
    }
  });

  test('story detail resolves every fact citation to a real, linkable source', () => {
    const { stories } = listStories({ limit: 1 }, db);
    const story = getStory(stories[0].id, db);

    assert.ok(story);
    assert.ok(story.whatHappened.length > 30);
    assert.ok(story.articles.length > 0);
    for (const article of story.articles) {
      assert.match(article.url, /^https?:\/\//);
      assert.ok(article.sourceName);
    }
    for (const fact of story.keyFacts) {
      assert.ok(fact.sources.length > 0, `fact has no linkable source: ${fact.fact}`);
      for (const source of fact.sources) assert.match(source.url, /^https?:\/\//);
    }
  });

  test('unknown story id returns null rather than throwing', () => {
    assert.equal(getStory(999_999, db), null);
  });

  test('topics report only what actually has stories', () => {
    const { topics, total } = listTopics(db);
    assert.ok(total > 0);
    assert.ok(topics.every((entry) => entry.count > 0));
    assert.ok(topics.some((entry) => entry.topic === 'world'));
  });
});

/**
 * The grey band is where the model earns its place in clustering. To exercise it
 * deterministically the thresholds are pushed apart so every candidate pair is
 * borderline, then the adjudicator stands in for the model.
 */
describe('AI adjudication of borderline pairs', () => {
  let greyDb;
  let greyDir;
  const original = { ...config.cluster };

  const seed = async () => {
    greyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-grey-'));
    greyDb = openDatabase(path.join(greyDir, 'grey.db'));
    const local = createFixtureFetcher();
    const quakeFeeds = local.feeds.filter((feed) => ['bbc', 'npr', 'guardian'].includes(feed.sourceId));
    await ingest({ db: greyDb, feeds: quakeFeeds, fetcher: local.fetcher });
    await extractArticles({ db: greyDb, fetcher: local.fetcher });
    // Only the three quake articles should be present.
    greyDb.prepare('DELETE FROM articles WHERE id NOT IN (SELECT id FROM articles LIMIT 3)').run();
  };

  before(() => {
    // Everything becomes borderline: nothing auto-joins, nothing is dismissed.
    config.cluster.joinThreshold = 0.99;
    config.cluster.greyLow = 0.02;
  });

  after(() => {
    Object.assign(config.cluster, original);
    greyDb?.close();
    if (greyDir) fs.rmSync(greyDir, { recursive: true, force: true });
  });

  test('without an adjudicator, ambiguous coverage is left unmerged rather than guessed at', async () => {
    await seed();
    const stats = await clusterArticles({ db: greyDb, adjudicator: null });
    assert.equal(stats.adjudicated, 0);
    assert.equal(
      greyDb.prepare('SELECT COUNT(*) AS n FROM clusters').get().n,
      3,
      'a wrong merge is worse than a split, so unresolved pairs must stay apart',
    );
    greyDb.close();
    fs.rmSync(greyDir, { recursive: true, force: true });
  });

  test('an adjudicator that confirms the pairs merges them into one story', async () => {
    await seed();
    const seen = [];
    const adjudicator = async (cases) => {
      seen.push(...cases);
      return new Map(cases.map((_, index) => [index, true]));
    };

    const stats = await clusterArticles({ db: greyDb, adjudicator });

    assert.ok(stats.adjudicated > 0, 'borderline pairs should have been sent for adjudication');
    assert.equal(greyDb.prepare('SELECT COUNT(*) AS n FROM clusters').get().n, 1);

    // The adjudicator must receive enough context to actually judge.
    for (const item of seen) {
      assert.ok(item.left?.title, 'adjudication case is missing the left article');
      assert.ok(item.right?.title, 'adjudication case is missing the right article');
      assert.ok(item.left.source_name && item.right.source_name);
    }
    greyDb.close();
    fs.rmSync(greyDir, { recursive: true, force: true });
  });

  test('a failing adjudicator degrades to the conservative outcome instead of crashing', async () => {
    await seed();
    const stats = await clusterArticles({
      db: greyDb,
      adjudicator: async () => {
        throw new Error('model unavailable');
      },
    });
    assert.ok(stats.created >= 1);
    assert.equal(greyDb.prepare('SELECT COUNT(*) AS n FROM clusters').get().n, 3);
    greyDb.close();
    fs.rmSync(greyDir, { recursive: true, force: true });
  });
});

/**
 * Above the exhaustive limit the engine switches to rare-term blocking. That path
 * is what actually runs in production volumes, so it gets its own coverage.
 */
describe('clustering at scale (blocking path)', () => {
  let scaleDb;
  let scaleDir;

  before(() => {
    scaleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-scale-'));
    scaleDb = openDatabase(path.join(scaleDir, 'scale.db'));

    const insert = scaleDb.prepare(`
      INSERT INTO articles (url, guid, source_id, source_name, source_tier, feed_category,
                            title, feed_summary, body, body_source, word_count,
                            published_at, first_seen_at)
      VALUES (@url, @url, @sourceId, @sourceName, 2, 'world', @title, @summary, @body,
              'extracted', 120, @publishedAt, @publishedAt)
    `);

    // 120 distinct events, two outlets each: 240 articles, comfortably past the
    // exhaustive limit. Each event owns unique coined entities; the surrounding
    // prose is shared filler, so lexical overlap alone would merge everything.
    const now = Date.now();
    const filler =
      'The company said in a statement that the decision followed a lengthy review by the board. ' +
      'Officials confirmed the details on Tuesday and said further information would be published ' +
      'in due course. Analysts said the move had been widely expected across the sector.';

    const write = scaleDb.transaction(() => {
      for (let k = 0; k < 120; k += 1) {
        const org = `Zerinth${k}`;
        const place = `Quilloa${k}`;
        const person = `Marek Vandolin${k}`;
        const publishedAt = now - (k % 20) * 3_600_000;

        insert.run({
          url: `https://alpha.test/story-${k}`,
          sourceId: 'alpha', sourceName: 'Alpha Wire',
          title: `${org} to open ${place} facility, ${person} confirms`,
          summary: `${org} announced a new plant in ${place}.`,
          body: `${org} will open a new facility in ${place}, chief executive ${person} said. ${filler}`,
          publishedAt,
        });
        insert.run({
          url: `https://beta.test/story-${k}`,
          sourceId: 'beta', sourceName: 'Beta Report',
          title: `${person} confirms ${place} plant for ${org}`,
          summary: `${person} said ${org} would build in ${place}.`,
          body: `Plans for a ${org} plant in ${place} were confirmed by ${person}. ${filler}`,
          publishedAt: publishedAt + 900_000,
        });
      }
    });
    write();
  });

  after(() => {
    scaleDb?.close();
    if (scaleDir) fs.rmSync(scaleDir, { recursive: true, force: true });
  });

  test('groups 240 articles into their 120 events without an AI call', async () => {
    const startedAt = Date.now();
    const stats = await clusterArticles({ db: scaleDb, adjudicator: null });
    const elapsed = Date.now() - startedAt;

    assert.equal(stats.considered, 240);
    assert.equal(
      scaleDb.prepare('SELECT COUNT(*) AS n FROM clusters').get().n,
      120,
      'each event should produce exactly one story',
    );

    const wrong = scaleDb
      .prepare('SELECT cluster_id, COUNT(*) AS n FROM articles GROUP BY cluster_id HAVING n != 2')
      .all();
    assert.equal(wrong.length, 0, 'every story should hold exactly its two reports');

    // Blocking exists to keep this affordable; if it regresses to O(n²) with full
    // scoring on every pair, this is where it shows up.
    assert.ok(elapsed < 20_000, `clustering 240 articles took ${elapsed}ms`);
  });
});

describe('retention', () => {
  test('pruning drops aged-out articles and the stories left empty behind them', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    const ancient = Date.now() - 400 * 86_400_000;
    db.prepare('UPDATE articles SET published_at = ? WHERE cluster_id = (SELECT cluster_id FROM articles WHERE url = ?)')
      .run(ancient, storedUrl(EVENTS.volcano[0]));

    const stats = prune({ db });
    assert.ok(stats.articlesPruned > 0);
    assert.ok(stats.clustersPruned > 0, 'a story with no remaining articles should be removed');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n < before);

    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM articles WHERE cluster_id IS NOT NULL)')
      .get().n;
    assert.equal(orphans, 0);
  });
});
