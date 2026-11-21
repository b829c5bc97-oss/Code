// "Perfect time" engine.
// Starts from sensible windows for an Indian audience, then learns from each account's own
// posts (when they went out and how well they did). More posts = more weight on real data.

import { istParts, istDateKey, istToDate, addDaysKey } from "./util.mjs";

export const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6 AM .. 11 PM
const bump = (h, centre, width = 1.2) => Math.exp(-Math.pow(h - centre, 2) / (2 * width * width));

// Starting windows (IST). dow: 0 = Monday.
export function prior(platform, dow, h) {
  const weekend = dow >= 5;
  switch (platform) {
    case "instagram":
      return weekend ? Math.max(0.75 * bump(h, 12), 0.95 * bump(h, 20.5, 1.4)) : Math.max(0.6 * bump(h, 13.2), 1.0 * bump(h, 20.2, 1.3));
    case "facebook":
    case "manual":
      return weekend ? Math.max(0.7 * bump(h, 12), 0.7 * bump(h, 20)) : Math.max(1.0 * bump(h, 14), 0.6 * bump(h, 20));
    case "linkedin": {
      const dayW = [0.75, 1, 1, 1, 0.7, 0.25, 0.2][dow];
      return dayW * Math.max(bump(h, 10, 1.1), 0.45 * bump(h, 13), 0.3 * bump(h, 20.5));
    }
    case "youtube":
      return weekend ? Math.max(0.8 * bump(h, 12), 0.9 * bump(h, 18)) : 1.0 * bump(h, 18, 1.3);
    case "pinterest":
      return weekend ? Math.max(0.6 * bump(h, 11), 0.9 * bump(h, 21)) : 1.0 * bump(h, 21, 1.3);
    default:
      return 0.5;
  }
}

export const STARTING_WINDOWS = {
  instagram: "Weekdays 7–9:30 PM · lunch 12:30–2 PM",
  facebook: "Weekdays 1–3 PM",
  linkedin: "Tue–Thu 9–11 AM",
  youtube: "Daily 5–7 PM",
  pinterest: "Daily 8–10 PM",
  manual: "Weekdays 1–3 PM",
};

// Build a 7 x 18 grid of scores 0..100 for one account.
export function model(account, snapshot) {
  const platform = account.platform;
  const grid = [];
  for (let d = 0; d < 7; d++) grid.push(HOURS.map((h) => prior(platform, d, h)));

  const posts = (snapshot?.posts || []).filter((p) => p.at);
  const perf = posts.map((p) => (p.interactions || 0) + 0.05 * (p.views || 0) + 0.02 * (p.reach || 0));
  const sorted = [...perf].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] || 1 : 1;
  const learned = [];
  for (let d = 0; d < 7; d++) learned.push(HOURS.map(() => ({ sum: 0, w: 0 })));
  posts.forEach((p, i) => {
    const { dow, h } = istParts(p.at);
    const ratio = Math.min(4, perf[i] / Math.max(median, 1));
    for (let d = 0; d < 7; d++) {
      HOURS.forEach((hh, hi) => {
        const dayW = d === dow ? 1 : 0.35;
        const w = dayW * bump(hh, h, 1.0);
        if (w < 0.05) return;
        learned[d][hi].sum += ratio * w;
        learned[d][hi].w += w;
      });
    }
  });
  const n = posts.length;
  const trust = n / (n + 8);
  let max = 0;
  for (let d = 0; d < 7; d++) {
    for (let hi = 0; hi < HOURS.length; hi++) {
      const l = learned[d][hi].w ? learned[d][hi].sum / learned[d][hi].w / 2 : grid[d][hi];
      grid[d][hi] = (1 - trust) * grid[d][hi] + trust * Math.min(1, l);
      max = Math.max(max, grid[d][hi]);
    }
  }
  const scores = grid.map((row) => row.map((v) => Math.round((v / (max || 1)) * 100)));
  return { scores, learnedFrom: n, trust: Math.round(trust * 100), updatedAt: new Date().toISOString() };
}

export function topSlots(m, count = 3) {
  const cells = [];
  m.scores.forEach((row, d) => row.forEach((v, hi) => cells.push({ d, h: HOURS[hi], v })));
  cells.sort((a, b) => b.v - a.v);
  const out = [];
  for (const c of cells) {
    if (out.length >= count) break;
    if (out.some((o) => o.d === c.d)) continue;
    out.push(c);
  }
  return out;
}

function scoreAt(models, accounts, date) {
  const { dow, h, min } = istParts(date);
  const hi = HOURS.indexOf(h);
  if (hi < 0) return -1;
  let total = 0;
  for (const a of accounts) {
    const m = models[a.id];
    const row = m.scores[dow];
    let v = row[hi];
    if (min >= 30 && hi + 1 < row.length) v = (v + row[hi + 1]) / 2;
    total += v;
  }
  return total / Math.max(accounts.length, 1);
}

// Suggest the best upcoming times for a set of accounts, avoiding times within 3 hours
// of another post on the same account.
export function suggest({ accounts, models, posts, from = new Date(), days = 7, count = 3, onlyDateKey = null }) {
  if (!accounts.length) return [];
  const busy = [];
  for (const p of posts || []) {
    if (!p.scheduledAt) continue;
    for (const id of p.accountIds || []) busy.push({ id, t: new Date(p.scheduledAt).getTime() });
  }
  const start = Math.ceil((from.getTime() + 20 * 60000) / 1800000) * 1800000;
  const end = from.getTime() + days * 86400000;
  const cands = [];
  for (let t = start; t <= end; t += 1800000) {
    const date = new Date(t);
    if (onlyDateKey && istDateKey(date) !== onlyDateKey) continue;
    const clash = accounts.some((a) => busy.some((b) => b.id === a.id && Math.abs(b.t - t) < 3 * 3600000));
    if (clash) continue;
    const s = scoreAt(models, accounts, date);
    if (s < 0) continue;
    cands.push({ at: date.toISOString(), score: Math.round(s) });
  }
  cands.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at));
  const picked = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(new Date(p.at) - new Date(c.at)) < 6 * 3600000)) continue;
    picked.push(c);
  }
  return picked;
}

export function bestTimeOfDay({ accounts, models, dateKey }) {
  if (!accounts.length) return null;
  let best = null;
  for (let hi = 0; hi < HOURS.length * 2; hi++) {
    const h = HOURS[0] + hi / 2;
    const hh = Math.floor(h);
    const mm = h % 1 ? "30" : "00";
    const date = istToDate(dateKey, `${String(hh).padStart(2, "0")}:${mm}`);
    const s = scoreAt(models, accounts, date);
    if (!best || s > best.score) best = { at: date.toISOString(), score: Math.round(s) };
  }
  return best;
}

export { addDaysKey };
