import { config } from '../config.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Last request time per host, so we stay polite to publishers we hit repeatedly. */
const lastHitByHost = new Map();

async function waitForHostSlot(host) {
  const delay = config.fetch.perHostDelayMs;
  if (!delay) return;
  const last = lastHitByHost.get(host) ?? 0;
  const wait = last + delay - Date.now();
  // Reserve the slot before awaiting so concurrent callers queue behind each other
  // instead of all reading the same stale timestamp and firing at once.
  lastHitByHost.set(host, Math.max(Date.now(), last + delay));
  if (wait > 0) await sleep(wait);
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status, url, retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryable = retryable;
  }
}

/**
 * Fetch text with a timeout, bounded retries and per-host pacing.
 * Returns { text, url, contentType } — `url` is the post-redirect URL.
 */
export async function fetchText(url, { timeoutMs, maxBytes, attempts = 3, accept } = {}) {
  const limitMs = timeoutMs ?? config.fetch.timeoutMs;
  const limitBytes = maxBytes ?? config.fetch.maxArticleBytes;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new HttpError(`Invalid URL: ${url}`, { url });
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForHostSlot(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': config.fetch.userAgent,
          accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} for ${url}`, {
          status: response.status,
          url,
          retryable: RETRYABLE_STATUS.has(response.status),
        });
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limitBytes) {
        throw new HttpError(`Response too large (${declared} bytes) for ${url}`, { url });
      }

      const text = await readCapped(response, limitBytes);
      return {
        text,
        url: response.url || url,
        contentType: response.headers.get('content-type') || '',
      };
    } catch (error) {
      lastError = normalizeError(error, url);
      const isLast = attempt === attempts;
      if (isLast || !lastError.retryable) break;
      await sleep(400 * 2 ** (attempt - 1) + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function readCapped(response, limitBytes) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        break; // Truncate rather than fail — a partial article still summarizes.
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function normalizeError(error, url) {
  if (error instanceof HttpError) return error;
  if (error?.name === 'AbortError') {
    return new HttpError(`Timed out fetching ${url}`, { url, retryable: true });
  }
  return new HttpError(`${error?.message || 'Network error'} (${url})`, { url, retryable: true });
}

/**
 * Run `worker` over `items` with bounded concurrency. Never rejects — each result
 * is `{ ok: true, value }` or `{ ok: false, error, item }`, so one dead feed can't
 * take down a whole ingestion cycle.
 */
export async function mapPool(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error, item: list[index] };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
