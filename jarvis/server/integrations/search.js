import { config } from '../config.js';
import { HttpError } from '../http.js';

export function searchStatus() {
  const { provider, tavilyKey, braveKey } = config.search;
  const configured = (provider === 'tavily' && !!tavilyKey) || (provider === 'brave' && !!braveKey);
  return { provider: configured ? provider : 'none', configured };
}

/** Real web search through Tavily or Brave. Results are tagged as external information. */
export async function webSearch(query, max = 5) {
  const { provider, configured } = searchStatus();
  if (!configured) throw new HttpError(400, 'Web search is not configured. Set TAVILY_API_KEY or BRAVE_API_KEY on the server.');
  let results;
  if (provider === 'tavily') {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.search.tavilyKey}` },
      body: JSON.stringify({ api_key: config.search.tavilyKey, query, max_results: max, search_depth: 'basic' }), signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new HttpError(502, `Search provider error (${res.status}).`);
    const j = await res.json();
    results = (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 500) }));
  } else {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(max) })}`, {
      headers: { accept: 'application/json', 'x-subscription-token': config.search.braveKey }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new HttpError(502, `Search provider error (${res.status}).`);
    const j = await res.json();
    results = (j.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description?.replace(/<[^>]+>/g, '') }));
  }
  return { source: `external web search (${provider})`, query, retrieved_at: new Date().toISOString(), results };
}
