// Competitor tracking with Instagram Business Discovery: public numbers of any business or
// creator Instagram account (followers, posts, likes, comments), read through your own
// connected Instagram login. Snapshots build a growth history.

import { call, qs, PlatformError } from "./platforms/common.mjs";
import { listAccounts, tokenOf } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { getJSON, setJSON, del } from "./store.mjs";
import { HttpError } from "./util.mjs";

const FIELDS = "id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website,media.limit(30){id,caption,like_count,comments_count,timestamp,permalink,media_type,media_product_type,media_url,thumbnail_url}";
const FRESH_MS = 6 * 3600000;

function cleanName(u) {
  return String(u || "").trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/[/?#].*$/, "").replace(/^@/, "").toLowerCase();
}

async function viewer() {
  const accounts = (await listAccounts()).filter((a) => a.platform === "instagram" && a.status !== "error");
  if (!accounts.length) throw new HttpError(400, "Connect at least one Instagram account first: competitor numbers are read through it.");
  return accounts[0];
}

function typeOf(m) {
  if (m.media_product_type === "REELS") return "Reel";
  if (m.media_type === "CAROUSEL_ALBUM") return "Carousel";
  if (m.media_type === "VIDEO") return "Video";
  return "Photo";
}

export function summarise(bd, hist = []) {
  const media = (bd.media?.data || []).map((m) => ({
    id: m.id,
    type: typeOf(m),
    caption: (m.caption || "").slice(0, 300),
    url: m.permalink || "",
    at: m.timestamp,
    thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : "") || "",
    likes: typeof m.like_count === "number" ? m.like_count : null,
    comments: typeof m.comments_count === "number" ? m.comments_count : 0,
  }));
  const now = Date.now();
  const last28 = media.filter((m) => m.at && now - new Date(m.at) < 28 * 86400000);
  const recent = media.slice(0, 12);
  const withLikes = recent.filter((m) => m.likes !== null);
  const avgLikes = withLikes.length ? withLikes.reduce((t, m) => t + m.likes, 0) / withLikes.length : null;
  const avgComments = recent.length ? recent.reduce((t, m) => t + m.comments, 0) / recent.length : null;
  const followers = bd.followers_count ?? null;
  const change = (days) => {
    const pts = hist.filter((h) => typeof h.followers === "number");
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1];
    const cutoff = new Date(new Date(last.d + "T12:00:00Z").getTime() - days * 86400000).toISOString().slice(0, 10);
    const base = [...pts].reverse().find((h) => h.d <= cutoff) || pts[0];
    return base === last ? null : last.followers - base.followers;
  };
  const types = {};
  for (const m of recent) types[m.type] = (types[m.type] || 0) + 1;
  return {
    username: bd.username,
    name: bd.name || bd.username,
    avatar: bd.profile_picture_url || "",
    bio: bd.biography || "",
    website: bd.website || "",
    followers,
    following: bd.follows_count ?? null,
    posts: bd.media_count ?? null,
    postsPerWeek: Math.round((last28.length / 4) * 10) / 10,
    avgLikes: avgLikes === null ? null : Math.round(avgLikes),
    avgComments: avgComments === null ? null : Math.round(avgComments * 10) / 10,
    engagement: followers && avgLikes !== null ? (avgLikes + (avgComments || 0)) / followers : null,
    lastPostAt: media[0]?.at || null,
    change7: change(7),
    change28: change(28),
    types,
    media,
  };
}

async function discover(username) {
  const settings = await getSettings();
  const v = await viewer();
  const base = `https://graph.facebook.com/${settings.general.graphVersion || "v25.0"}`;
  try {
    const { data } = await call(`${base}/${v.remoteId}?${qs({ fields: `business_discovery.username(${username}){${FIELDS}}`, access_token: tokenOf(v) })}`);
    if (!data.business_discovery) throw new PlatformError("not found");
    return data.business_discovery;
  } catch (e) {
    if (/not found|does not exist|cannot be found|Invalid user id|110|business_discovery/i.test(e.message)) {
      throw new HttpError(400, `Couldn't read @${username}. It must be a public business or creator Instagram account (personal accounts can't be tracked).`);
    }
    throw e;
  }
}

async function snapshot(username, { force = false } = {}) {
  const key = `comp/snap/${username}`;
  const old = (await getJSON(key)) || { hist: [] };
  if (!force && old.at && Date.now() - new Date(old.at).getTime() < FRESH_MS && old.raw) return { ...old, summary: summarise(old.raw, old.hist) };
  const raw = await discover(username);
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const hist = (old.hist || []).filter((h) => h.d !== today);
  hist.push({ d: today, followers: raw.followers_count ?? null, posts: raw.media_count ?? null });
  const rec = { at: new Date().toISOString(), raw, hist: hist.slice(-180) };
  await setJSON(key, rec);
  return { ...rec, summary: summarise(raw, rec.hist) };
}

export async function listCompetitors() {
  return (await getJSON("comp/list")) || [];
}

export async function addCompetitor(input) {
  const username = cleanName(input);
  if (!/^[a-z0-9._]{1,30}$/.test(username)) throw new HttpError(400, "Type an Instagram username, like liftline_india.");
  const list = await listCompetitors();
  if (list.some((c) => c.username === username)) throw new HttpError(400, `@${username} is already on the list.`);
  if (list.length >= 25) throw new HttpError(400, "You can track up to 25 accounts.");
  const s = await snapshot(username, { force: true });
  list.push({ username, addedAt: new Date().toISOString() });
  await setJSON("comp/list", list);
  return s.summary;
}

export async function removeCompetitor(username) {
  const u = cleanName(username);
  await setJSON("comp/list", (await listCompetitors()).filter((c) => c.username !== u));
  await del(`comp/snap/${u}`);
  return { ok: true };
}

// Table rows: your own Instagram accounts (marked "you") and every tracked competitor.
export async function competitorTable({ force = false } = {}) {
  const list = await listCompetitors();
  const own = (await listAccounts()).filter((a) => a.platform === "instagram").map((a) => (a.meta?.username || a.handle || "").replace(/^@/, "").toLowerCase()).filter(Boolean);
  const names = [...own.map((u) => ({ username: u, you: true })), ...list.map((c) => ({ username: c.username, you: false }))];
  const rows = await Promise.all(names.map(async (n) => {
    try {
      const s = await snapshot(n.username, { force });
      const { media, ...rest } = s.summary;
      const best = [...media].filter((m) => m.likes !== null).sort((a, b) => b.likes - a.likes)[0] || null;
      return { ...rest, you: n.you, best, at: s.at };
    } catch (e) {
      return { username: n.username, you: n.you, error: e.message };
    }
  }));
  return { rows, tracked: list.length };
}

export async function competitorDetail(username) {
  const s = await snapshot(cleanName(username));
  return { ...s.summary, hist: s.hist, at: s.at };
}

export async function refreshCompetitors() {
  return competitorTable({ force: true });
}
