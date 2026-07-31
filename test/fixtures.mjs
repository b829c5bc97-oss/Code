/**
 * Offline corpus for the pipeline test.
 *
 * Five real-shaped events, deliberately chosen to exercise the hard part of
 * clustering: two of them (the Fed and the ECB) share topic, vocabulary and
 * timing but are different events, and must not be merged.
 */

import { canonicalizeUrl } from '../server/lib/url.js';

const HOUR = 3_600_000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toUTCString();

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const EVENTS = {
  quake: [
    {
      outlet: 'bbc',
      url: 'https://www.bbc.com/news/world-asia-quake-honshu',
      title: 'Magnitude 7.1 earthquake strikes off northern Honshu, tsunami advisory issued',
      hoursAgo: 3,
      summary:
        'A magnitude 7.1 earthquake struck off the coast of northern Honshu on Tuesday morning, ' +
        'prompting Japan’s Meteorological Agency to issue a tsunami advisory for coastal Miyagi and Iwate.',
      body:
        'A magnitude 7.1 earthquake struck off the coast of northern Honshu at 09:42 local time on Tuesday, ' +
        'the Japan Meteorological Agency said. The agency issued a tsunami advisory for coastal areas of ' +
        'Miyagi and Iwate prefectures, warning of waves of up to one metre. ' +
        'Buildings shook in Sendai and rail operator JR East suspended Shinkansen services along the ' +
        'northern corridor while engineers inspected the track. ' +
        'Tohoku Electric Power said the Onagawa nuclear plant was operating normally and no irregularities ' +
        'had been detected. Local officials in Ishinomaki reported minor damage to older buildings but no ' +
        'casualties in the first hours after the quake. ' +
        'The agency said aftershocks of magnitude 5 or greater remained possible for about a week.',
    },
    {
      outlet: 'npr',
      url: 'https://www.npr.org/2026/07/31/honshu-earthquake-tsunami-advisory',
      title: 'Tsunami advisory lifted after 7.1 quake off Japan’s northeast coast',
      hoursAgo: 2,
      summary:
        'Japan issued and then lifted a tsunami advisory after a magnitude 7.1 earthquake struck ' +
        'off northern Honshu, with no casualties reported so far.',
      body:
        'Japanese authorities lifted a tsunami advisory on Tuesday afternoon, several hours after a ' +
        'magnitude 7.1 earthquake struck off the northeastern coast of Honshu. ' +
        'The Japan Meteorological Agency had warned that waves of up to one metre could reach Miyagi and ' +
        'Iwate prefectures. Waves of roughly 30 centimetres were recorded at Ishinomaki before the advisory ' +
        'was withdrawn. ' +
        'No casualties have been reported. Shinkansen services suspended along the northern corridor ' +
        'resumed after inspections found no damage to the track, JR East said. ' +
        'Tohoku Electric Power confirmed the Onagawa nuclear plant continued to operate normally.',
    },
    {
      outlet: 'guardian',
      url: 'https://www.theguardian.com/world/2026/jul/31/japan-earthquake-honshu-tsunami',
      title: 'Japan earthquake: 7.1 magnitude tremor shakes Sendai, no casualties reported',
      hoursAgo: 2.5,
      summary:
        'The tremor was felt strongly in Sendai. Rail services were suspended as a precaution ' +
        'and the Onagawa nuclear plant reported normal operations.',
      body:
        'A powerful earthquake shook northern Japan on Tuesday, rattling buildings in Sendai and briefly ' +
        'prompting a tsunami advisory for the Pacific coast. ' +
        'The Japan Meteorological Agency put the magnitude at 7.1 and located the epicentre offshore of ' +
        'northern Honshu at a depth of about 50km. ' +
        'Residents in Ishinomaki described shelves emptying and older buildings cracking, though officials ' +
        'said no injuries had been confirmed. Bullet train services were halted for inspections. ' +
        'Japan sits on the Pacific Ring of Fire and experiences roughly a fifth of the world’s ' +
        'strongest earthquakes.',
    },
  ],

  fed: [
    {
      outlet: 'cnbc',
      url: 'https://www.cnbc.com/2026/07/31/federal-reserve-holds-rates-steady.html',
      title: 'Federal Reserve holds interest rates steady at 4.25% to 4.5%',
      hoursAgo: 6,
      summary:
        'The Federal Open Market Committee voted to keep the federal funds rate unchanged, ' +
        'citing progress on inflation but a still-resilient labour market.',
      body:
        'The Federal Reserve left its benchmark interest rate unchanged on Wednesday, holding the federal ' +
        'funds rate in a range of 4.25% to 4.5% for a third consecutive meeting. ' +
        'The Federal Open Market Committee said inflation had continued to ease toward its 2% objective ' +
        'but that the labour market remained resilient enough to warrant patience. ' +
        'Chair Jerome Powell told reporters the committee was in no hurry to cut, and that officials would ' +
        'need to see several more months of data before adjusting policy. ' +
        'The decision was unanimous. Two officials had publicly argued for a quarter-point cut in the weeks ' +
        'before the meeting. Treasury yields rose slightly after the announcement.',
    },
    {
      outlet: 'guardian',
      url: 'https://www.theguardian.com/business/2026/jul/31/federal-reserve-interest-rates-decision',
      title: 'Fed keeps US interest rates on hold as Powell signals patience on cuts',
      hoursAgo: 5.5,
      summary:
        'Jerome Powell said the central bank would wait for more evidence that inflation is ' +
        'sustainably heading back to 2% before lowering borrowing costs.',
      body:
        'The US Federal Reserve has held interest rates steady at 4.25% to 4.5%, resisting pressure to ' +
        'begin cutting borrowing costs. ' +
        'Jerome Powell, the Fed chair, said policymakers wanted more evidence that inflation was returning ' +
        'sustainably to the central bank’s 2% target before easing. ' +
        'The Federal Open Market Committee’s decision was unanimous, and marked the third meeting in a ' +
        'row without a change. ' +
        'Powell declined to be drawn on the timing of any future move, saying only that the committee would ' +
        'be guided by incoming data on employment and prices.',
    },
  ],

  ecb: [
    {
      outlet: 'dw',
      url: 'https://www.dw.com/en/ecb-cuts-rates-quarter-point/a-2026073101',
      title: 'European Central Bank cuts interest rates by a quarter point to 2.75%',
      hoursAgo: 5,
      summary:
        'The ECB lowered its deposit rate to 2.75%, its third reduction this year, as eurozone ' +
        'inflation fell to 2.1%.',
      body:
        'The European Central Bank cut its key deposit rate by a quarter of a percentage point to 2.75% on ' +
        'Thursday, the third reduction this year. ' +
        'The governing council said eurozone inflation had fallen to 2.1% in July and that the disinflation ' +
        'process was well on track. ' +
        'ECB President Christine Lagarde said the council was not pre-committing to a particular rate path ' +
        'and would continue to decide meeting by meeting. ' +
        'Growth across the eurozone has remained weak, with German industrial output contracting for a ' +
        'fourth straight month. The euro weakened slightly against the dollar following the decision.',
    },
  ],

  layoffs: [
    {
      outlet: 'theverge',
      url: 'https://www.theverge.com/2026/7/31/northbridge-software-layoffs',
      title: 'Northbridge Software to cut 1,800 jobs as it restructures cloud division',
      hoursAgo: 9,
      summary:
        'The company said the cuts amount to about 6% of its workforce and will be concentrated ' +
        'in its cloud infrastructure unit.',
      body:
        'Northbridge Software said on Wednesday it would cut 1,800 jobs, about 6% of its global workforce, ' +
        'as part of a restructuring of its cloud infrastructure division. ' +
        'In a filing, the company said most of the reductions would take place in the United States and ' +
        'Ireland, and would be completed by the end of the fourth quarter. ' +
        'Chief executive Dana Whitfield told employees in a memo that the division had grown faster than ' +
        'demand and that the company was consolidating three overlapping platform teams. ' +
        'Northbridge said it expected to record a charge of $240 million related to severance and office ' +
        'closures. Its shares rose 3% in after-hours trading.',
    },
    {
      outlet: 'techcrunch',
      url: 'https://techcrunch.com/2026/07/31/northbridge-cuts-1800-roles/',
      title: 'Northbridge lays off 1,800 as cloud restructuring lands',
      hoursAgo: 8,
      summary:
        'Roughly 6% of staff are affected, with the cloud infrastructure organisation taking the ' +
        'bulk of the reductions.',
      body:
        'Northbridge Software is laying off 1,800 employees, roughly 6% of its headcount, in a ' +
        'restructuring centred on its cloud infrastructure organisation. ' +
        'The company confirmed the cuts in a regulatory filing, saying the majority fall in the United ' +
        'States and Ireland and should conclude by the end of the fourth quarter. ' +
        'CEO Dana Whitfield wrote to staff that three platform teams with overlapping mandates were being ' +
        'merged into one. Northbridge expects a $240 million charge covering severance and office closures. ' +
        'The stock climbed about 3% after hours.',
    },
  ],

  volcano: [
    {
      outlet: 'aljazeera',
      url: 'https://www.aljazeera.com/news/2026/7/31/iceland-volcano-eruption-reykjanes',
      title: 'Volcano erupts on Iceland’s Reykjanes peninsula, Grindavik evacuated',
      hoursAgo: 11,
      summary:
        'Lava began flowing from a new fissure near Grindavik, forcing the evacuation of the ' +
        'fishing town for the fourth time in two years.',
      body:
        'A volcanic eruption began on Iceland’s Reykjanes peninsula early on Wednesday, opening a ' +
        'fissure roughly three kilometres long north of the town of Grindavik. ' +
        'The Icelandic Meteorological Office said lava was flowing away from populated areas but that ' +
        'Grindavik had been evacuated as a precaution, the fourth evacuation of the town in two years. ' +
        'The Blue Lagoon geothermal spa was closed to visitors. Keflavik International Airport remained ' +
        'open and flights were operating normally, the airport operator said. ' +
        'Civil protection officials said no ash cloud had been detected and air travel across Europe was ' +
        'not expected to be affected.',
    },
  ],
};

const OUTLET_NAMES = {
  bbc: 'BBC News',
  npr: 'NPR',
  guardian: 'The Guardian',
  cnbc: 'CNBC',
  dw: 'Deutsche Welle',
  theverge: 'The Verge',
  techcrunch: 'TechCrunch',
  aljazeera: 'Al Jazeera',
};

const OUTLET_TIER = {
  bbc: 1, npr: 1, guardian: 1, dw: 1, aljazeera: 1, cnbc: 2, theverge: 3, techcrunch: 3,
};

const CATEGORY = {
  quake: 'world', volcano: 'world', fed: 'business', ecb: 'business', layoffs: 'technology',
};

/** Every fixture article, flattened, with its event key attached. */
export function allArticles() {
  return Object.entries(EVENTS).flatMap(([eventKey, articles]) =>
    articles.map((article) => ({ ...article, eventKey, category: CATEGORY[eventKey] })),
  );
}

/** One feed per outlet, so ingestion sees the same shape it will in production. */
export function buildFeeds() {
  const byOutlet = new Map();
  for (const article of allArticles()) {
    if (!byOutlet.has(article.outlet)) byOutlet.set(article.outlet, []);
    byOutlet.get(article.outlet).push(article);
  }

  const feeds = [];
  for (const [outlet, articles] of byOutlet) {
    // Alternate RSS 2.0 and Atom so both parser paths are exercised.
    const useAtom = ['npr', 'techcrunch'].includes(outlet);
    feeds.push({
      sourceId: outlet,
      sourceName: OUTLET_NAMES[outlet],
      tier: OUTLET_TIER[outlet],
      homepage: `https://example.test/${outlet}`,
      url: `https://feeds.test/${outlet}.xml`,
      category: articles[0].category,
      xml: useAtom ? atomFeed(outlet, articles) : rssFeed(outlet, articles),
    });
  }
  return feeds;
}

function rssFeed(outlet, articles) {
  const items = articles
    .map(
      (article) => `
    <item>
      <title>${escape(article.title)}</title>
      <link>${escape(article.url)}</link>
      <guid isPermaLink="true">${escape(article.url)}</guid>
      <pubDate>${at(article.hoursAgo)}</pubDate>
      <description><![CDATA[${article.summary}]]></description>
    </item>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${escape(OUTLET_NAMES[outlet])}</title>
  <link>https://example.test/${outlet}</link>
  <description>Test feed</description>${items}
</channel></rss>`;
}

function atomFeed(outlet, articles) {
  const entries = articles
    .map(
      (article) => `
  <entry>
    <title>${escape(article.title)}</title>
    <link rel="alternate" type="text/html" href="${escape(article.url)}"/>
    <id>${escape(article.url)}</id>
    <published>${new Date(Date.now() - article.hoursAgo * HOUR).toISOString()}</published>
    <summary type="html">${escape(article.summary)}</summary>
  </entry>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escape(OUTLET_NAMES[outlet])}</title>
  <id>https://feeds.test/${outlet}</id>${entries}
</feed>`;
}

/** A realistic article page: chrome, navigation, and the body inside <article>. */
export function articlePage(article) {
  const paragraphs = article.body
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .reduce((groups, sentence, index) => {
      const bucket = Math.floor(index / 2);
      groups[bucket] = (groups[bucket] || '') + ' ' + sentence;
      return groups;
    }, [])
    .map((paragraph) => `<p>${escape(paragraph.trim())}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(article.title)}</title></head>
<body>
  <nav><a href="/">Home</a> <a href="/world">World</a> <a href="/business">Business</a></nav>
  <header><h1>${escape(article.title)}</h1></header>
  <article>
    ${paragraphs}
  </article>
  <aside><h2>Most read</h2><ul><li>Something else entirely</li></ul></aside>
  <footer><p>Copyright test fixture</p></footer>
</body></html>`;
}

/** Stub for `fetchText` — serves feeds and article pages from memory. */
export function createFixtureFetcher() {
  const feeds = buildFeeds();
  const byUrl = new Map();
  // Register both the raw and canonicalized forms: the pipeline canonicalizes a
  // URL on ingest and then fetches that version, exactly as it would in production.
  const register = (url, body) => {
    byUrl.set(url, body);
    byUrl.set(canonicalizeUrl(url), body);
  };
  for (const feed of feeds) register(feed.url, feed.xml);
  for (const article of allArticles()) register(article.url, articlePage(article));

  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const text = byUrl.get(url);
    if (!text) throw new Error(`No fixture registered for ${url}`);
    return { text, url, contentType: url.endsWith('.xml') ? 'application/xml' : 'text/html' };
  };

  return { fetcher, feeds, calls };
}
