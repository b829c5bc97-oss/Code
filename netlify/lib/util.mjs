// Small shared helpers: env, responses, cookies, time (India Standard Time).

export function env(key) {
  try {
    const v = globalThis.Netlify?.env?.get(key);
    if (v !== undefined && v !== null && v !== "") return v;
  } catch (_) { /* not on Netlify */ }
  return process.env[key];
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "cache-control": "no-store", ...headers } });
}

export async function readJSON(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new HttpError(400, "That request was not valid JSON.");
  }
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Lax`;
  if (httpOnly) c += "; HttpOnly";
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// India has no daylight saving: IST is always UTC+05:30.
export const IST_OFFSET_MIN = 330;

export function istParts(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MIN * 60000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    dow: (d.getUTCDay() + 6) % 7, // 0 = Monday
  };
}

export function istDateKey(date) {
  const p = istParts(date);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// "2026-11-23" + "19:30" in IST -> Date
export function istToDate(dateKey, hhmm = "00:00") {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - IST_OFFSET_MIN * 60000);
}

export function addDaysKey(dateKey, n) {
  const dt = istToDate(dateKey, "12:00");
  return istDateKey(new Date(dt.getTime() + n * 86400000));
}

export function dateKeysBetween(fromKey, toKey, max = 62) {
  const out = [];
  let k = fromKey;
  while (k <= toKey && out.length < max) {
    out.push(k);
    k = addDaysKey(k, 1);
  }
  return out;
}

export function clean(str, max = 5000) {
  if (str === undefined || str === null) return "";
  return String(str).slice(0, max);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMessage(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  return e.message || String(e);
}
