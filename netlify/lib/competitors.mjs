// Competitor tracking with Instagram Business Discovery: public numbers of any business or
// creator Instagram account (followers, posts, likes, comments), read through your own
// connected Instagram login. Snapshots build a growth history.

import { call, qs, PlatformError } from "./platforms/common.mjs";
import { listAccounts, tokenOf } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { getJSON, setJSON, del } from "./store.mjs";
import { HttpError } from "./util.mjs";
import { analyse, hashtagsOf } from "./analysis.mjs";

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
      const recent = media.slice(0, 12);
      const tagCount = {};
      for (const m of recent) for (const t of hashtagsOf(m.caption)) tagCount[t] = (tagCount[t] || 0) + 1;
      const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const reelsShare = recent.length ? Math.round(((rest.types.Reel || 0) / recent.length) * 100) : null;
      const maxLikes = recent.reduce((m2, x) => Math.max(m2, x.likes || 0), 0);
      return { ...rest, you: n.you, best, at: s.at, topTag, reelsShare, maxLikes };
    } catch (e) {
      return { username: n.username, you: n.you, error: e.message };
    }
  }));
  return { rows, tracked: list.length };
}

// Your own hashtags (from your accounts' analysed posts), to spot tags worth testing.
async function ownHashtags() {
  const tags = new Set();
  for (const a of (await listAccounts()).filter((x) => x.platform === "instagram")) {
    const rec = await getJSON(`ana/${a.id}`);
    for (const p of rec?.posts || []) for (const t of hashtagsOf(p.caption)) tags.add(t);
  }
  return tags;
}

export async function competitorDetail(username) {
  const s = await snapshot(cleanName(username));
  const posts = s.summary.media.map((m) => ({ ...m, interactions: (m.likes || 0) + (m.comments || 0) }));
  const an = analyse(posts, { platform: "instagram" });
  const mine = await ownHashtags();
  const tagTotals = {};
  for (const p of posts) for (const t of hashtagsOf(p.caption)) tagTotals[t] = (tagTotals[t] || 0) + 1;
  const mostUsed = Object.entries(tagTotals).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, uses]) => ({ tag, uses, yours: mine.has(tag) }));
  const toTry = [...an.hashtags.working, ...an.hashtags.average.filter((t) => t.index >= 1)].filter((t) => !mine.has(t.tag)).slice(0, 12);
  const withTags = posts.filter((p) => hashtagsOf(p.caption).length);
  const busiest = an.days.filter((d) => d.n).sort((a, b) => b.n - a.n).slice(0, 2).map((d) => d.label);
  const busiestPart = an.dayparts.filter((d) => d.n).sort((a, b) => b.n - a.n)[0]?.label || null;
  const insights = [];
  const t = an.types.filter((x) => x.n >= 2);
  if (t.length >= 2 && t[0].avg && t[t.length - 1].avg) insights.push(`Their ${t[0].type.toLowerCase()}s get ${Math.round((t[0].avg / Math.max(t[t.length - 1].avg, 1)) * 10) / 10}× the likes and comments of their ${t[t.length - 1].type.toLowerCase()}s.`);
  if (s.summary.postsPerWeek) insights.push(`They post about ${s.summary.postsPerWeek} times a week${busiest.length ? `, mostly on ${busiest.join(" and ")}` : ""}${busiestPart ? `, usually in the ${busiestPart.split(" (")[0].toLowerCase()}` : ""}.`);
  if (an.hashtags.working.length) insights.push(`Hashtags that do best for them: ${an.hashtags.working.slice(0, 5).map((x) => x.tag).join(", ")}.`);
  if (toTry.length) insights.push(`Tags they use well that you haven't tried: ${toTry.slice(0, 6).map((x) => x.tag).join(", ")}.`);
  if (an.cta.with.n >= 2 && an.cta.without.n >= 2) insights.push(an.cta.with.comments > an.cta.without.comments ? `Asking for comments works for them: ${an.cta.with.comments} comments a post with an ask vs ${an.cta.without.comments} without.` : `Their posts with an ask don't get more comments (${an.cta.with.comments} vs ${an.cta.without.comments}).`);
  if (an.trend && an.trend.change !== null) insights.push(`Their last ${an.trend.k} posts got ${Math.abs(an.trend.change)}% ${an.trend.change >= 0 ? "more" : "fewer"} likes and comments than the ${an.trend.k} before.`);
  if (s.summary.change28 !== null) insights.push(`Followers: ${s.summary.change28 >= 0 ? "+" : ""}${s.summary.change28} in the last 28 days.`);
  return {
    ...s.summary,
    hist: s.hist,
    at: s.at,
    analysis: an,
    hashtagsPerPost: posts.length ? Math.round((posts.reduce((t2, p) => t2 + hashtagsOf(p.caption).length, 0) / posts.length) * 10) / 10 : 0,
    postsWithHashtags: withTags.length,
    captionLength: posts.length ? Math.round(posts.reduce((t2, p) => t2 + String(p.caption || "").replace(/#[\p{L}\p{N}_]+/gu, "").trim().length, 0) / posts.length) : 0,
    mostUsed,
    toTry,
    insights,
  };
}

export async function refreshCompetitors() {
  return competitorTable({ force: true });
}
