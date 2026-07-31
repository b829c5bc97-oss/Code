const TRACKING_PARAMS = [
  /^utm_/i,
  /^ic[ei]d$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_[ce]id$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^cmpid$/i,
  /^cmp$/i,
  /^smid$/i,
  /^partner$/i,
  /^at_medium$/i,
  /^at_campaign$/i,
  /^__twitter_impression$/i,
  /^sh$/i,
  /^srnd$/i,
];

/**
 * Strip tracking noise so the same article syndicated through different campaign
 * links collapses to one row. Anything unparsable is returned untouched.
 */
export function canonicalizeUrl(input) {
  try {
    const url = new URL(input);
    url.hash = '';
    // Lowercase the host, but leave `www.` alone: the canonical URL is both what
    // we fetch and what we send readers to, and plenty of publishers serve only
    // one of the two forms. The dedupe win isn't worth a broken link.
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
    }
    url.search = url.searchParams.toString() ? `?${url.searchParams.toString()}` : '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return input;
  }
}
