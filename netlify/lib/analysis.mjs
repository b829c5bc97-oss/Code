// Content analysis: what works on each account, from its own posts.
// collect*: per-post numbers (cached; old posts are not re-read every time).
// analyse(): pure function that turns posts into findings and plain-language tips.

import { getJSON, setJSON } from "./store.mjs";
import { getSettings } from "./settings.mjs";
import { getAccount, saveAccount } from "./accounts.mjs";
import { platforms } from "./platforms/index.mjs";
import { HttpError } from "./util.mjs";

const DAY = 86400000;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PARTS = [
  { label: "Late night (12–6 AM)", from: 0, to: 6 },
  { label: "Morning (6–11 AM)", from: 6, to: 11 },
  { label: "Midday (11 AM–3 PM)", from: 11, to: 15 },
  { label: "Evening (3–7 PM)", from: 15, to: 19 },
  { label: "Night (7 PM–12 AM)", from: 19, to: 24 },
];
const CTA = /(comment|dm\b|direct message|link in bio|save (this|it)|share (this|it|with)|tag (a|your|someone)|follow (us|for)|whatsapp|call us|visit|book (a|your)|msg|message us)/i;

export function hashtagsOf(text) {
  return [...new Set((String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()))];
}
function ist(iso) {
  const d = new Date(new Date(iso).getTime() + 330 * 60000);
  return { dow: (d.getUTCDay() + 6) % 7, h: d.getUTCHours(), key: d.toISOString().slice(0, 10) };
}
const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);
const round = (x, d = 0) => (x === null || x === undefined || isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function group(posts, keyFn, valueOf) {
  const g = {};
  for (const p of posts) {
    const keys = [].concat(keyFn(p));
    for (const k of keys) {
      if (k === null || k === undefined) continue;
      (g[k] = g[k] || []).push(p);
    }
  }
  return Object.entries(g).map(([k, list]) => ({ key: k, n: list.length, avg: round(avg(list.map(valueOf))), index: round(avg(list.map((p) => p._i)), 2), ids: list.map((p) => p.id) }));
}

export function analyse(rawPosts, { platform = "instagram", now = Date.now() } = {}) {
  const posts = rawPosts.filter((p) => p && p.at).map((p) => ({ ...p, hashtags: p.hashtags || hashtagsOf(p.caption) }));
  const interactions = (p) => p.interactions ?? ((p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.saves || 0));
  const share = (k) => posts.filter((p) => (p[k] || 0) > 0).length / Math.max(posts.length, 1);
  const metric = share("reach") >= 0.5 ? "reach" : share("views") >= 0.5 ? "views" : "interactions";
  const metricLabel = metric === "reach" ? (platform === "facebook" ? "people reached" : "accounts reached") : metric === "views" ? "views" : "interactions";
  const valueOf = (p) => (metric === "interactions" ? interactions(p) : p[metric] || 0);
  const out = { metric, metricLabel, posts: posts.length, enough: posts.length >= 4, tips: [] };
  if (!posts.length) return { ...out, note: "No posts to analyse yet." };
  const M = median(posts.map(valueOf)) || avg(posts.map(valueOf)) || 1;
  for (const p of posts) p._i = valueOf(p) / M;
  // For hashtags, compare each post with posts of the same type (reels with reels), so a tag
  // isn't called "working" just because it only goes on reels.
  const typeMed = {};
  for (const t of new Set(posts.map((p) => p.type || "Post"))) {
    const vals = posts.filter((p) => (p.type || "Post") === t).map(valueOf);
    if (vals.length >= 3) typeMed[t] = median(vals) || avg(vals) || null;
  }
  for (const p of posts) p._ti = typeMed[p.type || "Post"] ? valueOf(p) / typeMed[p.type || "Post"] : p._i;
  out.median = round(M);
  out.average = round(avg(posts.map(valueOf)));
  const mature = posts.filter((p) => now - new Date(p.at) > 2 * DAY);

  // Content types
  out.types = group(posts, (p) => p.type || "Post", valueOf).map((t) => {
    const list = posts.filter((p) => (p.type || "Post") === t.key);
    return { ...t, type: t.key, likes: round(avg(list.map((p) => p.likes || 0))), comments: round(avg(list.map((p) => p.comments || 0)), 1), shares: round(avg(list.map((p) => p.shares || 0)), 1), saves: round(avg(list.map((p) => p.saves || 0)), 1), watchSec: round(avg(list.filter((p) => p.watchMs).map((p) => p.watchMs / 1000)), 1) };
  }).sort((a, b) => b.index - a.index);

  // Hashtags
  const tagRows = group(posts, (p) => p.hashtags, valueOf).map((t) => {
    const list = posts.filter((p) => p.hashtags.includes(t.key));
    return { tag: t.key, uses: t.n, avg: t.avg, index: round(avg(list.map((p) => p._ti)), 2), ids: t.ids };
  });
  const repeated = tagRows.filter((t) => t.uses >= 2);
  out.hashtags = {
    distinct: tagRows.length,
    working: repeated.filter((t) => t.index >= 1.15).sort((a, b) => b.index - a.index),
    notWorking: repeated.filter((t) => t.index <= 0.85).sort((a, b) => a.index - b.index),
    average: repeated.filter((t) => t.index > 0.85 && t.index < 1.15).sort((a, b) => b.uses - a.uses),
    once: tagRows.filter((t) => t.uses === 1).sort((a, b) => b.index - a.index),
  };
  const withTags = posts.filter((p) => p.hashtags.length), noTags = posts.filter((p) => !p.hashtags.length);
  out.hashtags.withVsWithout = { with: { n: withTags.length, index: round(avg(withTags.map((p) => p._i)), 2) }, without: { n: noTags.length, index: round(avg(noTags.map((p) => p._i)), 2) } };
  const buckets = [["None", 0, 0], ["1–3", 1, 3], ["4–7", 4, 7], ["8–15", 8, 15], ["16 or more", 16, 99]];
  out.hashtags.count = buckets.map(([label, lo, hi]) => {
    const list = posts.filter((p) => p.hashtags.length >= lo && p.hashtags.length <= hi);
    return { label, n: list.length, index: round(avg(list.map((p) => p._i)), 2), avg: round(avg(list.map(valueOf))) };
  }).filter((b) => b.n);

  // Timing (India time)
  out.days = DAYS.map((d, i) => {
    const list = posts.filter((p) => ist(p.at).dow === i);
    return { label: d, n: list.length, index: round(avg(list.map((p) => p._i)), 2), avg: round(avg(list.map(valueOf))) };
  });
  out.dayparts = PARTS.map((part) => {
    const list = posts.filter((p) => { const h = ist(p.at).h; return h >= part.from && h < part.to; });
    return { label: part.label, n: list.length, index: round(avg(list.map((p) => p._i)), 2), avg: round(avg(list.map(valueOf))) };
  });

  // Captions and calls to action
  const textLen = (p) => String(p.caption || "").replace(/#[\p{L}\p{N}_]+/gu, "").trim().length;
  out.captions = [["Short (under 80 letters)", 0, 79], ["Medium (80–250)", 80, 250], ["Long (over 250)", 251, 1e9]].map(([label, lo, hi]) => {
    const list = posts.filter((p) => textLen(p) >= lo && textLen(p) <= hi);
    return { label, n: list.length, index: round(avg(list.map((p) => p._i)), 2), comments: round(avg(list.map((p) => p.comments || 0)), 1) };
  }).filter((b) => b.n);
  const withCta = posts.filter((p) => CTA.test(p.caption || "")), noCta = posts.filter((p) => !CTA.test(p.caption || ""));
  out.cta = { with: { n: withCta.length, comments: round(avg(withCta.map((p) => p.comments || 0)), 1), index: round(avg(withCta.map((p) => p._i)), 2) }, without: { n: noCta.length, comments: round(avg(noCta.map((p) => p.comments || 0)), 1), index: round(avg(noCta.map((p) => p._i)), 2) } };

  // How people engage
  const tot = (k) => posts.reduce((t, p) => t + (p[k] || 0), 0);
  const reachTot = tot("reach");
  out.engagement = {
    likes: tot("likes"), comments: tot("comments"), shares: tot("shares"), saves: tot("saves"),
    perThousand: reachTot ? { likes: round((tot("likes") / reachTot) * 1000, 1), comments: round((tot("comments") / reachTot) * 1000, 1), shares: round((tot("shares") / reachTot) * 1000, 1), saves: round((tot("saves") / reachTot) * 1000, 1) } : null,
    rate: reachTot ? round((posts.reduce((t, p) => t + interactions(p), 0) / reachTot) * 100, 2) : null,
  };

  // Consistency and trend
  const weekStart = (key) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const thisWeek = weekStart(ist(new Date(now).toISOString()).key);
  out.weeks = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(thisWeek + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7 * (7 - i));
    const wk = d.toISOString().slice(0, 10);
    return { week: wk, posts: posts.filter((p) => weekStart(ist(p.at).key) === wk).length };
  });
  out.perWeek = round(avg(out.weeks.slice(0, 7).map((w) => w.posts)), 1);
  const times = posts.map((p) => new Date(p.at).getTime()).filter((t) => now - t < 60 * DAY).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, (times[i] - times[i - 1]) / DAY);
  out.longestGapDays = round(gap, 1);
  const newest = Math.max(...posts.map((p) => new Date(p.at).getTime()));
  out.daysSinceLastPost = round((now - newest) / DAY, 1);
  const byTime = [...mature].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (byTime.length >= 6) {
    const k = Math.min(5, Math.floor(byTime.length / 2));
    const recent = avg(byTime.slice(0, k).map(valueOf)), before = avg(byTime.slice(k, 2 * k).map(valueOf));
    out.trend = { recent: round(recent), before: round(before), change: before ? round(((recent - before) / before) * 100) : null, k };
  }

  const slim = (p) => ({ id: p.id, at: p.at, type: p.type, caption: String(p.caption || "").slice(0, 140), url: p.url, thumb: p.thumb, value: valueOf(p), index: round(p._i, 2), likes: p.likes ?? null, comments: p.comments ?? null, shares: p.shares ?? null, saves: p.saves ?? null });
  out.top = [...posts].sort((a, b) => b._i - a._i).slice(0, 5).map(slim);
  out.bottom = [...mature].sort((a, b) => a._i - b._i).slice(0, 5).map(slim);

  // Plain-language tips
  const tips = [];
  const pctTxt = (i) => `${Math.round(Math.abs(i - 1) * 100)}%`;
  const strong = out.types.filter((t) => t.n >= 2);
  if (strong.length >= 2 && strong[0].avg && strong[strong.length - 1].avg && strong[0].avg / Math.max(strong[strong.length - 1].avg, 1) >= 1.3) {
    tips.push({ kind: "type", text: `${strong[0].type}s get about ${round(strong[0].avg / Math.max(strong[strong.length - 1].avg, 1), 1)}× the ${metricLabel} of ${strong[strong.length - 1].type.toLowerCase()}s here. Make more ${strong[0].type.toLowerCase()}s.` });
  }
  if (out.hashtags.working.length) tips.push({ kind: "tags", text: `Keep using ${out.hashtags.working.slice(0, 4).map((t) => t.tag).join(", ")}: posts with ${out.hashtags.working.length > 1 ? "them" : "it"} get ${pctTxt(avg(out.hashtags.working.slice(0, 4).map((t) => t.index)))} more ${metricLabel} than similar posts without ${out.hashtags.working.length > 1 ? "them" : "it"}.` });
  if (out.hashtags.notWorking.length) tips.push({ kind: "tags", text: `${out.hashtags.notWorking.slice(0, 4).map((t) => t.tag).join(", ")} ${out.hashtags.notWorking.length > 1 ? "sit" : "sits"} on posts that do ${pctTxt(avg(out.hashtags.notWorking.slice(0, 4).map((t) => t.index)))} worse than similar posts. Try swapping them for tags closer to what buyers search.` });
  const bestCount = out.hashtags.count.filter((b) => b.n >= 2).sort((a, b) => b.index - a.index)[0];
  if (bestCount && out.hashtags.count.filter((b) => b.n >= 2).length >= 2) tips.push({ kind: "tags", text: `Posts with ${bestCount.label === "None" ? "no hashtags" : `${bestCount.label} hashtags`} did best (${bestCount.n} posts).` });
  const bestPart = out.dayparts.filter((d) => d.n >= 2).sort((a, b) => b.index - a.index)[0];
  if (bestPart && bestPart.index >= 1.2) tips.push({ kind: "time", text: `Your ${bestPart.label.charAt(0).toLowerCase() + bestPart.label.slice(1)} posts do ${pctTxt(bestPart.index)} better than your usual post.` });
  const bestDay = out.days.filter((d) => d.n >= 2).sort((a, b) => b.index - a.index)[0];
  if (bestDay && bestDay.index >= 1.2) tips.push({ kind: "time", text: `${bestDay.label} posts do best so far (${bestDay.n} posts, ${pctTxt(bestDay.index)} above usual).` });
  if (out.cta.with.n >= 2 && out.cta.without.n >= 2 && out.cta.with.comments > out.cta.without.comments * 1.3 && out.cta.with.comments >= 1) tips.push({ kind: "caption", text: `Posts that ask people to act (comment, DM, save) get ${round(out.cta.with.comments / Math.max(out.cta.without.comments, 0.1), 1)}× more comments. Add a clear ask to every post.` });
  if (out.cta.without.n === 0 && posts.length >= 4) tips.push({ kind: "caption", text: "Every post already asks people to act. Good: keep the ask short and specific." });
  const bestCap = out.captions.filter((c) => c.n >= 2).sort((a, b) => b.index - a.index)[0];
  if (bestCap && out.captions.filter((c) => c.n >= 2).length >= 2 && bestCap.index >= 1.15) tips.push({ kind: "caption", text: `${bestCap.label.split(" (")[0]} captions work best here (${pctTxt(bestCap.index)} above usual).` });
  if (out.perWeek !== null && out.perWeek < 3) tips.push({ kind: "rhythm", text: `You post about ${out.perWeek} times a week. Small accounts grow faster at 4–5 posts a week, so use the Plan screen to fill the gaps.` });
  if (out.daysSinceLastPost >= 4) tips.push({ kind: "rhythm", text: `Nothing posted for ${Math.floor(out.daysSinceLastPost)} days. Long gaps slow down reach for the next post.` });
  if (out.trend && out.trend.change !== null && Math.abs(out.trend.change) >= 25) tips.push({ kind: "trend", text: out.trend.change > 0 ? `Your last ${out.trend.k} posts got ${out.trend.change}% more ${metricLabel} than the ${out.trend.k} before. Whatever changed, keep it.` : `Your last ${out.trend.k} posts got ${Math.abs(out.trend.change)}% fewer ${metricLabel} than the ${out.trend.k} before. Compare them with your best posts below.` });
  if (out.engagement.perThousand && out.engagement.perThousand.saves + out.engagement.perThousand.shares < 5 && reachTot > 500) tips.push({ kind: "engage", text: "Few people save or share your posts. Useful posts (tips, price lists, comparisons) get saved and shared far more, which pushes reach up." });
  out.tips = tips;
  if (!out.enough) out.note = "Only a few posts so far: the findings get more reliable as you post more.";
  return out;
}

// Collect and cache per-post numbers for one account.
export async function collectAnalysis({ account, settings, impl = platforms }) {
  const p = impl[account.platform];
  if (!p?.analysisPosts) throw new HttpError(400, "Analysis for this platform comes soon.");
  const key = `ana/${account.id}`;
  const old = (await getJSON(key)) || { posts: [] };
  const cache = Object.fromEntries((old.posts || []).map((x) => [x.id, x]));
  const posts = await p.analysisPosts({ settings, account, cache });
  const rec = { at: new Date().toISOString(), posts };
  await setJSON(key, rec);
  return rec;
}

export async function analysisFor(id, { refresh = false } = {}) {
  let account = await getAccount(id);
  let rec = await getJSON(`ana/${id}`);
  if (refresh || !rec) {
    const settings = await getSettings();
    const p = platforms[account.platform];
    if (!p?.analysisPosts) throw new HttpError(400, "Analysis for this platform comes soon.");
    const { account: fresh, changed } = await p.ensureToken({ account, settings });
    if (changed) await saveAccount(fresh);
    account = fresh;
    rec = await collectAnalysis({ account, settings });
  }
  return { at: rec.at, analysis: analyse(rec.posts || [], { platform: account.platform }) };
}
