// Activity log: logins, security changes, connections and everything Claude does.
// Kept in Blobs under audit/<time>; the newest 400 entries are kept.

import { setJSON, listKeys, getMany, del } from "./store.mjs";
import { randomId } from "./crypto.mjs";
import { clean } from "./util.mjs";

const KEEP = 400;

export function clientInfo(req) {
  if (!req?.headers) return {};
  const h = req.headers;
  const ip = h.get("x-nf-client-connection-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim() || "";
  const ua = h.get("user-agent") || "";
  const country = (() => {
    try {
      const geo = h.get("x-nf-geo");
      if (!geo) return "";
      const g = JSON.parse(Buffer.from(geo, "base64").toString("utf8"));
      return [g.city, g.country?.name || g.country?.code].filter(Boolean).join(", ");
    } catch (_) {
      return "";
    }
  })();
  return { ip: clean(ip, 64), device: describeDevice(ua), where: clean(country, 80) };
}

function describeDevice(ua) {
  if (!ua) return "";
  if (/Claude-User|Anthropic|claude/i.test(ua)) return "Claude";
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "";
  return [br, os].filter(Boolean).join(" on ") || clean(ua, 60);
}

// kind: "login", "security", "claude", "account", "settings"
export async function logEvent(kind, text, req, extra = {}) {
  try {
    const at = new Date().toISOString();
    await setJSON(`audit/${at}-${randomId(4)}`, { at, kind, text: clean(text, 300), ...clientInfo(req), ...extra });
    if (Math.random() < 0.05) await trim();
  } catch (e) {
    console.error("audit log failed", e);
  }
}

async function trim() {
  const keys = (await listKeys("audit/")).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) await del(k);
}

export async function listEvents(limit = 100) {
  const keys = (await listKeys("audit/")).sort().reverse().slice(0, limit);
  return (await getMany(keys)).filter(Boolean);
}
