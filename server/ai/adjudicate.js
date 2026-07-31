import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { truncate } from '../lib/text.js';
import { structured, isAvailable } from './client.js';
import { ADJUDICATE_SCHEMA, ADJUDICATE_SYSTEM } from './prompts.js';

const log = logger('adjudicate');

const BATCH_SIZE = 20;
const EXCERPT_CHARS = 480;

/**
 * Decide, for each borderline pair, whether both articles cover the same event.
 *
 * Returns a Map of case index → boolean. Anything the model doesn't answer for
 * stays absent, and callers treat absence as "don't merge" — the safe default,
 * since a wrong merge produces a briefing that conflates two events.
 */
export async function adjudicatePairs(cases) {
  const verdicts = new Map();
  if (!isAvailable() || cases.length === 0) return verdicts;

  const batches = [];
  for (let i = 0; i < cases.length; i += BATCH_SIZE) {
    batches.push({ offset: i, items: cases.slice(i, i + BATCH_SIZE) });
  }

  for (const batch of batches) {
    try {
      const result = await structured({
        system: ADJUDICATE_SYSTEM,
        user: renderBatch(batch.items),
        schema: ADJUDICATE_SCHEMA,
        effort: config.ai.utilityEffort,
        maxTokens: 4000,
        label: `adjudicate(${batch.items.length} pairs)`,
      });
      for (const verdict of result.verdicts ?? []) {
        const index = batch.offset + verdict.index;
        if (index >= 0 && index < cases.length) verdicts.set(index, verdict.same_event === true);
      }
    } catch (error) {
      log.warn(`batch at offset ${batch.offset} failed: ${error.message}`);
    }
  }

  const merged = [...verdicts.values()].filter(Boolean).length;
  log.info(`adjudicated ${cases.length} borderline pairs — ${merged} merged`);
  return verdicts;
}

function renderBatch(items) {
  const blocks = items.map((item, index) => {
    const left = renderArticle(item.left);
    const right = renderArticle(item.right);
    return `### Pair ${index}\n\nARTICLE A\n${left}\n\nARTICLE B\n${right}`;
  });

  return `Decide for each pair whether the two articles report the same specific event.\n\n${blocks.join('\n\n---\n\n')}\n\nReturn one verdict per pair, using the pair number as "index".`;
}

function renderArticle(article) {
  if (!article) return '(unavailable)';
  const when = Number.isFinite(article.published_at)
    ? new Date(article.published_at).toISOString().replace('T', ' ').slice(0, 16)
    : 'unknown time';
  const excerpt = truncate(article.body || article.feed_summary || '', EXCERPT_CHARS);
  return `Source: ${article.source_name} (${when})\nHeadline: ${article.title}\nExcerpt: ${excerpt || '(no text available)'}`;
}
