import crypto from 'node:crypto';

/**
 * Text analysis used by the clustering engine.
 *
 * The goal is cheap, deterministic signals that get us most of the way to
 * "these articles are about the same event" without an LLM call, so the model
 * is only spent on the genuinely ambiguous pairs.
 */

const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be because been before being
below between both but by can cannot could couldn't did didn't do does doesn't doing don't down during
each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself
his how i if in into is isn't it its itself let's me more most mustn't my myself no nor not of off on
once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such
than that the their theirs them themselves then there these they this those through to too under until
up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't
you your yours yourself yourselves says said told according reported report reports news latest update
updates say will also new one two first last year years time week month day today monday tuesday
wednesday thursday friday saturday sunday
`.trim().split(/\s+/));

/**
 * Frequent English words that must not count as named entities even when they
 * appear capitalized. Headlines are often title-cased, so case alone is not
 * enough to tell "Trump" from "Announces".
 */
const COMMON_WORDS = new Set(`
${[...STOPWORDS].join(' ')}
after amid announces announced announcement back begin begins big call called calls come comes coming
could deal death deaths end ends face faces find finds get gets give gives go goes going good great
help helps high higher hit hits hold holds home huge keep keeps kill killed killing know known large
launch launched launches lead leads leader left less like little long look looks lose loses loss made
make makes making many may meet meets might move moves near need needs never next old open opens part
people plan plans play plays point points push pushes put puts raise raises reach reaches ready record
report return returns rise rises run runs see sees set sets show shows sign signs since small start
starts state states stay still stop stops take takes talk talks tell tells think three thought top
turn turns use used uses want wants warn warns way well what's why win wins work works world would
years ago already among another anti back become becomes been before behind best better between
billion million thousand hundred percent per cent case cases change changes city country day days
during early far first full future government group groups head hour hours idea important later law
laws level line local major million most much national number official officials order others place
public real report right rights second several since single site small social study team teams than
their there they think third those three time today total under until using version very view week
weeks well while whole within without work year yet
`.trim().split(/\s+/));

export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeWhitespace(text) {
  return (text || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  // Prefer cutting at a sentence boundary so the model never sees a half sentence.
  const slice = text.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
  if (lastStop > max * 0.6) return slice.slice(0, lastStop + 1);
  return `${slice.trimEnd()}…`;
}

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && token.length < 30 && !STOPWORDS.has(token));
}

export function countTerms(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

/** Inverse document frequency across a corpus of term-count maps. */
export function buildIdf(docTermMaps) {
  const docFreq = new Map();
  for (const terms of docTermMaps) {
    for (const term of terms.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }
  const total = docTermMaps.length || 1;
  const idf = new Map();
  for (const [term, freq] of docFreq) {
    idf.set(term, Math.log((total + 1) / (freq + 0.5)));
  }
  return idf;
}

/** L2-normalized TF-IDF vector, so cosine similarity is a plain dot product. */
export function tfidfVector(termCounts, idf) {
  const vector = new Map();
  let norm = 0;
  for (const [term, count] of termCounts) {
    const weight = (1 + Math.log(count)) * (idf.get(term) ?? Math.log(2));
    if (weight <= 0) continue;
    vector.set(term, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (const [term, weight] of vector) vector.set(term, weight / norm);
  return vector;
}

export function cosine(a, b) {
  // Iterate the smaller vector; the result is identical either way.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) dot += weight * other;
  }
  return dot;
}

/** The highest-IDF terms in a document — used to build the candidate-pair index. */
export function topTerms(vector, limit) {
  return [...vector.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * Proper-noun-ish spans plus numbers. Two articles about the same event tend to
 * name the same people, places and figures even when the prose differs entirely.
 */
export function extractEntities(text, { limit = 60 } = {}) {
  const entities = new Set();
  if (!text) return entities;

  const sample = text.slice(0, 6000);
  const wordPattern = /[A-Z][\w&.'’-]*/g;
  const words = sample.split(/(?<=[.!?])\s+|\n+/);

  for (const sentence of words) {
    const matches = [...sentence.matchAll(wordPattern)];
    let run = [];
    let lastEnd = -1;
    for (const match of matches) {
      const raw = match[0].replace(/[.,'’]+$/, '');
      const lower = raw.toLowerCase();
      const contiguous = match.index === lastEnd + 1;
      lastEnd = match.index + match[0].length;
      if (raw.length < 2 || COMMON_WORDS.has(lower)) {
        if (run.length) {
          entities.add(run.join(' ').toLowerCase());
          run = [];
        }
        continue;
      }
      if (!contiguous && run.length) {
        entities.add(run.join(' ').toLowerCase());
        run = [];
      }
      run.push(raw);
      if (run.length >= 4) {
        entities.add(run.join(' ').toLowerCase());
        run = [];
      }
    }
    if (run.length) entities.add(run.join(' ').toLowerCase());
    if (entities.size > limit * 3) break;
  }

  // Figures are a strong same-event fingerprint: death tolls, scores, sums, dates.
  for (const match of sample.matchAll(/(?:[$£€]\s?)?\d[\d,.]*\s?(?:%|bn|billion|million|m|k|per cent|percent)?/g)) {
    const value = match[0].trim().toLowerCase();
    if (value.replace(/\D/g, '').length >= 2) entities.add(`#${value}`);
    if (entities.size > limit * 4) break;
  }

  return new Set([...entities].slice(0, limit * 4));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Overlap coefficient: shared items over the size of the *smaller* set.
 *
 * Preferred over Jaccard for comparing articles, because coverage lengths differ
 * wildly — a 200-word wire brief and a 1,500-word feature about the same event
 * share nearly all of the brief's entities, but Jaccard punishes that heavily for
 * the entities only the longer piece mentions. On the fixture corpus this roughly
 * doubles the separation between same-event and same-topic pairs.
 */
export function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / small.size;
}

/** 1 at zero separation, decaying smoothly to 0 across `halfLifeHours`. */
export function timeProximity(msA, msB, halfLifeHours = 18) {
  const hours = Math.abs(msA - msB) / 3_600_000;
  return Math.exp(-hours / halfLifeHours);
}

export function hashString(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

/** Split into sentences — used by the extractive fallback when AI is disabled. */
export function sentences(text) {
  if (!text) return [];
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"“'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 400);
}
