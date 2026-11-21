// Shared HTTP helpers for talking to the platforms.

export class PlatformError extends Error {
  constructor(message, { status, data, authProblem } = {}) {
    super(message);
    this.status = status;
    this.data = data;
    this.authProblem = !!authProblem;
  }
}

function pickMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === "string") return data.slice(0, 300) || fallback;
  const e = data.error;
  if (e) {
    if (typeof e === "string") return data.error_description || data.message || e;
    return e.error_user_msg || e.message || e.code || fallback;
  }
  return data.message || data.error_description || data.serviceErrorCode || fallback;
}

export async function call(url, { method = "GET", headers = {}, body, json, form, raw = false, timeout = 60000 } = {}) {
  const h = { ...headers };
  let payload = body;
  if (json !== undefined) {
    h["content-type"] = h["content-type"] || "application/json";
    payload = JSON.stringify(json);
  } else if (form !== undefined) {
    h["content-type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null)).toString();
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, signal: ctrl.signal });
  } catch (e) {
    throw new PlatformError(e.name === "AbortError" ? "The platform took too long to answer." : `Could not reach the platform: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (raw) return res;
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) { /* keep text */ }
  if (!res.ok || (data && typeof data === "object" && data.error && !Array.isArray(data))) {
    const authProblem = res.status === 401 || data?.error?.code === 190 || data?.error?.type === "OAuthException";
    throw new PlatformError(pickMessage(data, `HTTP ${res.status}`), { status: res.status, data, authProblem });
  }
  return { data, headers: res.headers, status: res.status };
}

export function qs(obj) {
  return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
}

export function captionFor(post, platform) {
  return (post.captions?.[platform] || post.caption || "").trim();
}

export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

export function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export async function waitFor(fn, { tries = 40, every = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fn(i);
    if (r) return r;
    await new Promise((res) => setTimeout(res, every));
  }
  return null;
}
