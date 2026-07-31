import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { fetchText, mapPool } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { normalizeWhitespace, stripHtml } from '../lib/text.js';

const log = logger('extract');

/** Below this, whatever we pulled out is a cookie wall or a paywall stub, not an article. */
const MIN_USABLE_CHARS = 420;

/**
 * Upgrade articles from feed blurb to full body text.
 *
 * Accuracy depends on the model seeing the actual reporting rather than a
 * two-sentence teaser, so this is where summary quality is really won. Failures
 * are expected and fine: the feed summary remains as the body, and the article
 * is flagged so we don't keep re-fetching a page that won't give us anything.
 */
export async function extractArticles({ db = getDb(), limit, fetcher = fetchText } = {}) {
  const cap = limit ?? config.pipeline.maxExtractionsPerRun;
  const windowStart = Date.now() - config.pipeline.clusterWindowHours * 3_600_000;

  const pending = db
    .prepare(`
      SELECT id, url, title, feed_summary
      FROM articles
      WHERE extract_failed = 0
        AND (body_source IS NULL OR body_source = 'feed')
        AND published_at >= ?
      ORDER BY published_at DESC
      LIMIT ?
    `)
    .all(windowStart, cap);

  if (pending.length === 0) return { attempted: 0, extracted: 0, failed: 0 };

  const saveBody = db.prepare(`
    UPDATE articles
       SET body = ?, body_source = 'extracted', word_count = ?, extracted_at = ?
     WHERE id = ?
  `);
  const markFailed = db.prepare('UPDATE articles SET extract_failed = 1, extracted_at = ? WHERE id = ?');

  const results = await mapPool(pending, config.fetch.articleConcurrency, async (article) => {
    const { text: html, url: finalUrl } = await fetcher(article.url, { accept: 'text/html,application/xhtml+xml' });
    return { article, body: extractReadableText(html, finalUrl) };
  });

  const stats = { attempted: pending.length, extracted: 0, failed: 0 };
  const now = Date.now();

  const commit = db.transaction(() => {
    for (let i = 0; i < results.length; i += 1) {
      const outcome = results[i];
      const article = pending[i];

      if (!outcome?.ok) {
        stats.failed += 1;
        markFailed.run(now, article.id);
        log.debug(`extract failed for ${article.url}: ${outcome?.error?.message}`);
        continue;
      }

      const body = outcome.value.body;
      if (!body || body.length < MIN_USABLE_CHARS) {
        stats.failed += 1;
        markFailed.run(now, article.id);
        continue;
      }

      stats.extracted += 1;
      saveBody.run(body, body.split(/\s+/).length, now, article.id);
    }
  });
  commit();

  log.info(`extracted ${stats.extracted}/${stats.attempted} article bodies (${stats.failed} unavailable)`);
  return stats;
}

/**
 * Run Readability over a page and return clean plain text.
 * Returns '' when the page has no recoverable article content.
 */
export function extractReadableText(html, url) {
  if (!html || html.length < 200) return '';

  // JSDOM is noisy about CSS it can't parse; silence it rather than spam the log.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  let dom;
  try {
    dom = new JSDOM(html, { url, virtualConsole, contentType: 'text/html' });
  } catch {
    return '';
  }

  try {
    const { document } = dom.window;
    if (!isProbablyReaderable(document, { minContentLength: 180 })) {
      return fallbackParagraphText(document);
    }

    const parsed = new Readability(document.cloneNode(true), {
      charThreshold: 250,
      keepClasses: false,
    }).parse();

    const text = normalizeWhitespace(parsed?.textContent || '');
    if (text.length >= MIN_USABLE_CHARS) return text;
    return fallbackParagraphText(document) || text;
  } catch {
    return '';
  } finally {
    dom.window.close();
  }
}

/**
 * When Readability declines, take the paragraphs directly. Crude, but it rescues
 * plenty of liveblog and wire-copy layouts that Readability's heuristics reject.
 */
function fallbackParagraphText(document) {
  try {
    const paragraphs = [...document.querySelectorAll('article p, main p, [itemprop="articleBody"] p, p')]
      .map((node) => stripHtml(node.textContent || ''))
      .filter((text) => text.length > 60);
    if (paragraphs.length < 2) return '';
    return normalizeWhitespace(paragraphs.slice(0, 80).join('\n\n'));
  } catch {
    return '';
  }
}
