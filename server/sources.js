/**
 * Curated feed registry.
 *
 * Every entry is a publicly documented RSS/Atom feed from an established news
 * organisation. `tier` encodes editorial weight and is used two ways: to break
 * ties when picking which coverage to feed the model, and to reward stories that
 * are corroborated across independent outlets rather than syndicated once.
 *
 *   tier 1 — wire services and public-service broadcasters
 *   tier 2 — major national outlets
 *   tier 3 — respected specialist desks
 *
 * `category` is the feed's own beat. It seeds the topic before the model reads
 * the story; the model can override it with what the coverage is actually about.
 */
export const SOURCES = [
  // ---- World / general -----------------------------------------------------
  { id: 'ap', name: 'Associated Press', tier: 1, homepage: 'https://apnews.com',
    feeds: [{ url: 'https://feeds.apnews.com/rss/apf-topnews', category: 'world' }] },

  { id: 'bbc', name: 'BBC News', tier: 1, homepage: 'https://www.bbc.com/news',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'world' },
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
      { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business' },
      { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'technology' },
      { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
      { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'entertainment' },
      { url: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sports' },
    ] },

  { id: 'npr', name: 'NPR', tier: 1, homepage: 'https://www.npr.org',
    feeds: [
      { url: 'https://feeds.npr.org/1001/rss.xml', category: 'world' },
      { url: 'https://feeds.npr.org/1006/rss.xml', category: 'business' },
      { url: 'https://feeds.npr.org/1019/rss.xml', category: 'technology' },
      { url: 'https://feeds.npr.org/1007/rss.xml', category: 'science' },
      { url: 'https://feeds.npr.org/1014/rss.xml', category: 'politics' },
    ] },

  { id: 'guardian', name: 'The Guardian', tier: 1, homepage: 'https://www.theguardian.com',
    feeds: [
      { url: 'https://www.theguardian.com/world/rss', category: 'world' },
      { url: 'https://www.theguardian.com/uk/business/rss', category: 'business' },
      { url: 'https://www.theguardian.com/uk/technology/rss', category: 'technology' },
      { url: 'https://www.theguardian.com/science/rss', category: 'science' },
      { url: 'https://www.theguardian.com/uk/sport/rss', category: 'sports' },
      { url: 'https://www.theguardian.com/uk/culture/rss', category: 'entertainment' },
    ] },

  { id: 'aljazeera', name: 'Al Jazeera', tier: 1, homepage: 'https://www.aljazeera.com',
    feeds: [{ url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' }] },

  { id: 'cbc', name: 'CBC News', tier: 1, homepage: 'https://www.cbc.ca/news',
    feeds: [
      { url: 'https://www.cbc.ca/webfeed/rss/rss-topstories', category: 'world' },
      { url: 'https://www.cbc.ca/webfeed/rss/rss-business', category: 'business' },
      { url: 'https://www.cbc.ca/webfeed/rss/rss-technology', category: 'technology' },
    ] },

  { id: 'dw', name: 'Deutsche Welle', tier: 1, homepage: 'https://www.dw.com',
    feeds: [{ url: 'https://rss.dw.com/rdf/rss-en-all', category: 'world' }] },

  { id: 'france24', name: 'France 24', tier: 1, homepage: 'https://www.france24.com',
    feeds: [{ url: 'https://www.france24.com/en/rss', category: 'world' }] },

  { id: 'skynews', name: 'Sky News', tier: 2, homepage: 'https://news.sky.com',
    feeds: [
      { url: 'https://feeds.skynews.com/feeds/rss/world.xml', category: 'world' },
      { url: 'https://feeds.skynews.com/feeds/rss/technology.xml', category: 'technology' },
    ] },

  // ---- Business / markets --------------------------------------------------
  { id: 'cnbc', name: 'CNBC', tier: 2, homepage: 'https://www.cnbc.com',
    feeds: [
      { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', category: 'business' },
      { url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html', category: 'technology' },
    ] },

  { id: 'marketwatch', name: 'MarketWatch', tier: 2, homepage: 'https://www.marketwatch.com',
    feeds: [{ url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: 'business' }] },

  // ---- Technology ----------------------------------------------------------
  { id: 'arstechnica', name: 'Ars Technica', tier: 3, homepage: 'https://arstechnica.com',
    feeds: [{ url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'technology' }] },

  { id: 'theverge', name: 'The Verge', tier: 3, homepage: 'https://www.theverge.com',
    feeds: [{ url: 'https://www.theverge.com/rss/index.xml', category: 'technology' }] },

  { id: 'techcrunch', name: 'TechCrunch', tier: 3, homepage: 'https://techcrunch.com',
    feeds: [{ url: 'https://techcrunch.com/feed/', category: 'technology' }] },

  // ---- Politics ------------------------------------------------------------
  { id: 'politico', name: 'Politico', tier: 2, homepage: 'https://www.politico.com',
    feeds: [{ url: 'https://rss.politico.com/politics-news.xml', category: 'politics' }] },

  { id: 'thehill', name: 'The Hill', tier: 2, homepage: 'https://thehill.com',
    feeds: [{ url: 'https://thehill.com/news/feed/', category: 'politics' }] },

  // ---- Science -------------------------------------------------------------
  { id: 'sciencedaily', name: 'ScienceDaily', tier: 3, homepage: 'https://www.sciencedaily.com',
    feeds: [{ url: 'https://www.sciencedaily.com/rss/top/science.xml', category: 'science' }] },

  { id: 'nasa', name: 'NASA', tier: 1, homepage: 'https://www.nasa.gov',
    feeds: [{ url: 'https://www.nasa.gov/news-release/feed/', category: 'science' }] },

  // ---- Sports --------------------------------------------------------------
  { id: 'espn', name: 'ESPN', tier: 2, homepage: 'https://www.espn.com',
    feeds: [{ url: 'https://www.espn.com/espn/rss/news', category: 'sports' }] },

  { id: 'skysports', name: 'Sky Sports', tier: 3, homepage: 'https://www.skysports.com',
    feeds: [{ url: 'https://www.skysports.com/rss/12040', category: 'sports' }] },

  // ---- Entertainment -------------------------------------------------------
  { id: 'variety', name: 'Variety', tier: 3, homepage: 'https://variety.com',
    feeds: [{ url: 'https://variety.com/feed/', category: 'entertainment' }] },

  { id: 'hollywoodreporter', name: 'The Hollywood Reporter', tier: 3, homepage: 'https://www.hollywoodreporter.com',
    feeds: [{ url: 'https://www.hollywoodreporter.com/feed/', category: 'entertainment' }] },
];

export const TOPICS = [
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
  'entertainment',
];

/** Flattened [{ sourceId, sourceName, tier, homepage, url, category }] for the fetcher. */
export function allFeeds() {
  return SOURCES.flatMap((source) =>
    source.feeds.map((feed) => ({
      sourceId: source.id,
      sourceName: source.name,
      tier: source.tier,
      homepage: source.homepage,
      url: feed.url,
      category: feed.category,
    })),
  );
}

export function sourceById(id) {
  return SOURCES.find((s) => s.id === id);
}
