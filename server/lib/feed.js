import { XMLParser } from 'fast-xml-parser';
import { stripHtml } from './text.js';

/**
 * Minimal, tolerant RSS 2.0 / Atom / RDF parser.
 *
 * Real-world feeds are inconsistent — the same logical field shows up under half
 * a dozen names, sometimes as a string, sometimes as an object with attributes,
 * sometimes as an array. Everything here is defensive on purpose.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  cdataPropName: '__cdata',
  removeNSPrefix: false,
});

const asArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Feed values arrive as strings, {#text}, {__cdata}, or arrays of those. */
function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = textOf(entry);
      if (text) return text;
    }
    return '';
  }
  if (typeof value === 'object') {
    if (value.__cdata !== undefined) return textOf(value.__cdata);
    if (value['#text'] !== undefined) return textOf(value['#text']);
  }
  return '';
}

function firstText(node, keys) {
  for (const key of keys) {
    const text = textOf(node?.[key]);
    if (text) return text;
  }
  return '';
}

function resolveLink(node) {
  const direct = textOf(node?.link);
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  // Atom: <link rel="alternate" href="..."/>, possibly several.
  const candidates = asArray(node?.link).filter((entry) => entry && typeof entry === 'object');
  const scored = candidates
    .map((entry) => ({ href: entry['@_href'], rel: entry['@_rel'] || 'alternate', type: entry['@_type'] || '' }))
    .filter((entry) => entry.href && /^https?:\/\//i.test(entry.href))
    .sort((a, b) => rankLink(a) - rankLink(b));
  if (scored.length) return scored[0].href;

  for (const key of ['guid', 'id', 'feedburner:origLink']) {
    const text = textOf(node?.[key]);
    if (text && /^https?:\/\//i.test(text)) return text;
  }
  return '';
}

function rankLink({ rel, type }) {
  if (rel === 'alternate' && type.includes('html')) return 0;
  if (rel === 'alternate') return 1;
  if (rel === 'self') return 4;
  if (rel === 'enclosure' || rel === 'edit') return 5;
  return 2;
}

function resolveImage(node) {
  const mediaContent = asArray(node?.['media:content']).find((entry) => entry?.['@_url']);
  if (mediaContent) return mediaContent['@_url'];
  const thumb = asArray(node?.['media:thumbnail']).find((entry) => entry?.['@_url']);
  if (thumb) return thumb['@_url'];
  const enclosure = asArray(node?.enclosure).find(
    (entry) => entry?.['@_url'] && String(entry['@_type'] || '').startsWith('image/'),
  );
  if (enclosure) return enclosure['@_url'];
  return null;
}

function resolveDate(node) {
  const raw = firstText(node, [
    'pubDate',
    'published',
    'updated',
    'dc:date',
    'dcterms:created',
    'lastBuildDate',
    'date',
  ]);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function resolveBody(node) {
  const raw = firstText(node, [
    'content:encoded',
    'content',
    'description',
    'summary',
    'subtitle',
    'media:description',
  ]);
  return stripHtml(raw);
}

/**
 * Parse a feed document into normalized items.
 * Throws only when the payload isn't a recognisable feed at all.
 */
export function parseFeed(xml) {
  if (!xml || !xml.trim()) throw new Error('Empty feed document');

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new Error(`Feed is not well-formed XML: ${error.message}`);
  }

  const channel = doc?.rss?.channel ?? doc?.channel;
  const atom = doc?.feed;
  const rdf = doc?.['rdf:RDF'];

  let rawItems = [];
  let feedTitle = '';

  if (channel) {
    rawItems = asArray(channel.item);
    feedTitle = textOf(channel.title);
  } else if (atom) {
    rawItems = asArray(atom.entry);
    feedTitle = textOf(atom.title);
  } else if (rdf) {
    rawItems = asArray(rdf.item);
    feedTitle = textOf(rdf.channel?.title);
  } else {
    throw new Error('Unrecognised feed format (no rss/atom/rdf root)');
  }

  const items = [];
  for (const node of rawItems) {
    if (!node || typeof node !== 'object') continue;
    const title = stripHtml(firstText(node, ['title']));
    const url = resolveLink(node);
    if (!title || !url) continue;

    items.push({
      title,
      url,
      guid: firstText(node, ['guid', 'id']) || url,
      publishedAt: resolveDate(node),
      summary: resolveBody(node),
      imageUrl: resolveImage(node),
    });
  }

  return { feedTitle, items };
}
