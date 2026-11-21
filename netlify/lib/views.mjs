// Read-only views the screens need: overview, weekly plan, insights, suggestions.

import { listAccounts, publicAccount } from "./accounts.mjs";
import { listPosts } from "./posts.mjs";
import { getJSON } from "./store.mjs";
import { alertLog } from "./alerts.mjs";
import { timingOf } from "./posts.mjs";
import { getModel } from "./jobs.mjs";
import { suggest, bestTimeOfDay, topSlots, HOURS, STARTING_WINDOWS } from "./besttime.mjs";
import { getSettings, configured } from "./settings.mjs";
import { istDateKey, istParts, addDaysKey, istToDate } from "./util.mjs";

export function weekStartKey(dateKey) {
  const { dow } = istParts(istToDate(dateKey, "12:00"));
  return addDaysKey(dateKey, -dow);
}

async function accountData(a) {
  const [latest, hist] = await Promise.all([getJSON(`ins/${a.id}/latest`), getJSON(`ins/${a.id}/hist`)]);
  return { latest, hist: hist || [] };
}

function followerChange(hist, days) {
  const withF = hist.filter((h) => typeof h.followers === "number");
  if (withF.length < 2) return null;
  const last = withF[withF.length - 1];
  const cutoff = addDaysKey(last.d, -days);
  const base = [...withF].reverse().find((h) => h.d <= cutoff) || withF[0];
  if (base === last) return null;
  return last.followers - base.followers;
}

function publicPost(p, byId) {
  return {
    ...p,
    timing: timingOf(p),
    accounts: p.accountIds.map((id) => {
      const a = byId[id];
      return a ? { id, name: a.name, platform: a.platform, brand: a.brand, handle: a.handle } : { id, name: "Removed account", platform: "unknown", brand: "" };
    }),
  };
}

export async function overview() {
  const now = new Date();
  const today = istDateKey(now);
  const wk = weekStartKey(today);
  const [accounts, settings, weekPosts, recent, drafts] = await Promise.all([
    listAccounts(),
    getSettings(),
    listPosts({ from: wk, to: addDaysKey(wk, 6) }),
    listPosts({ from: addDaysKey(today, -14), to: addDaysKey(today, 30) }),
    listPosts({ from: today, to: today, drafts: true }),
  ]);
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const data = await Promise.all(accounts.map(accountData));

  const rows = accounts.map((a, i) => {
    const { latest, hist } = data[i];
    const next = recent
      .filter((p) => p.scheduledAt && new Date(p.scheduledAt) > now && p.accountIds.includes(a.id) && ["scheduled", "needs_ok"].includes(p.status))
      .sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt))[0];
    const spark = hist.slice(-8).map((h) => h.reach7 ?? h.followers ?? 0);
    return {
      ...publicAccount(a),
      followers: latest?.followers ?? null,
      followersLabel: latest?.followersLabel || "Followers",
      reach7: latest?.reach7 ?? null,
      change7: followerChange(hist, 7),
      spark,
      nextAt: next?.scheduledAt || null,
      insightsAt: latest?.at || null,
    };
  });

  const todayPosts = recent.filter((p) => p.scheduledAt && istDateKey(p.scheduledAt) === today).map((p) => publicPost(p, byId));
  const needsOk = recent.filter((p) => p.status === "needs_ok");
  const failed = recent.filter((p) => ["failed", "partial"].includes(p.status));
  const reminders = [];
  for (const p of recent) {
    for (const [accId, t] of Object.entries(p.targets || {})) {
      if (t.status === "reminder") reminders.push({ post: publicPost(p, byId), accountId: accId, accountName: byId[accId]?.name || "Account" });
    }
  }
  const attention = [];
  const beat = await getJSON("meta/scheduler-run");
  const silentMin = beat?.at ? Math.round((now.getTime() - new Date(beat.at).getTime()) / 60000) : null;
  const posting = { lastRunAt: beat?.at || null, minutesAgo: silentMin, ok: silentMin !== null && silentMin <= 15 };
  if (!posting.ok) attention.push({ kind: "failed", title: "Automatic posting is NOT running", detail: silentMin === null ? "The posting timer has never run here." : `It last ran ${silentMin} minutes ago, so scheduled posts aren't going out.`, action: "Open Overview", href: "#/overview" });
  const overdue = recent.filter((p) => timingOf(p, now).overdueMin > 0);
  if (overdue.length) attention.push({ kind: "failed", title: `${overdue.length} post${overdue.length > 1 ? "s are" : " is"} overdue — not posted yet`, detail: "Its time has passed and it hasn't gone out. Social HQ keeps trying; open it to see why.", action: "Open", href: `#/create?id=${overdue[0].id}` });
  if (needsOk.length) attention.push({ kind: "ok", title: `${needsOk.length} post${needsOk.length > 1 ? "s" : ""} need your OK`, detail: "Approve them and they go out at their set time.", action: "Review", href: "#/plan" });
  if (failed.length) attention.push({ kind: "failed", title: `${failed.length} post${failed.length > 1 ? "s" : ""} didn't go out`, detail: failed[0] ? firstError(failed[0]) : "", action: "See what happened", href: `#/create?id=${failed[0].id}` });
  if (reminders.length) attention.push({ kind: "reminder", title: `${reminders.length} reminder post${reminders.length > 1 ? "s" : ""} to do by hand`, detail: "Facebook doesn't let any app post to personal profiles. Copy the caption, download the media, post, then tick it off.", action: "Open reminders", href: "#/overview?reminders=1" });
  for (const a of accounts.map(publicAccount)) {
    if (["error", "expired"].includes(a.status)) attention.push({ kind: "login", title: `${a.name}: reconnect needed`, detail: a.lastError || a.loginNote, action: "Reconnect", href: "#/accounts" });
    else if (a.status === "expiring") attention.push({ kind: "login", title: `${a.name}: login ends soon`, detail: a.loginNote, action: "Reconnect", href: "#/accounts" });
  }
  const anyConfigured = ["instagram", "facebook", "linkedin", "youtube", "pinterest"].some((p) => configured(settings, p));
  if (!accounts.length) attention.push({ kind: "setup", title: anyConfigured ? "Connect your first account" : "Add your platform app keys", detail: anyConfigured ? "Go to Accounts and press Connect." : "Each platform needs its developer app keys once. Settings shows exactly where they go.", action: anyConfigured ? "Open Accounts" : "Open Settings", href: anyConfigured ? "#/accounts" : "#/settings" });

  const sum = (arr) => arr.reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
  const counts = {};
  for (const a of accounts) counts[a.platform] = (counts[a.platform] || 0) + 1;
  return {
    now: now.toISOString(),
    today,
    kpis: {
      accounts: accounts.length,
      auto: accounts.filter((a) => a.platform !== "manual").length,
      reminderOnly: accounts.filter((a) => a.platform === "manual").length,
      counts,
      scheduledThisWeek: weekPosts.filter((p) => p.status !== "draft").length,
      weekFrom: wk,
      needsOk: needsOk.length,
      reach7: rows.some((r) => typeof r.reach7 === "number") ? sum(rows.map((r) => r.reach7)) : null,
      newFollowers7: rows.some((r) => typeof r.change7 === "number") ? sum(rows.map((r) => r.change7)) : null,
    },
    today_posts: todayPosts,
    posting,
    attention,
    alerts: (await alertLog()).filter((a) => Date.now() - new Date(a.at).getTime() < 3 * 86400000).slice(0, 6),
    reminders,
    accounts: rows,
    drafts: drafts.filter((p) => p.status === "draft").length,
  };
}

function firstError(p) {
  const t = Object.values(p.targets || {}).find((x) => x.status === "failed");
  return t?.error || "";
}

export async function plan({ from, brand }) {
  const wk = weekStartKey(from || istDateKey(new Date()));
  const to = addDaysKey(wk, 6);
  const [accountsAll, postsAll] = await Promise.all([listAccounts(), listPosts({ from: addDaysKey(wk, -1), to: addDaysKey(to, 1), drafts: true })]);
  const accounts = brand && brand !== "All" ? accountsAll.filter((a) => a.brand === brand) : accountsAll;
  const byIdAll = Object.fromEntries(accountsAll.map((a) => [a.id, a]));
  const ids = new Set(accounts.map((a) => a.id));
  const inWeek = postsAll.filter((p) => p.scheduledAt && istDateKey(p.scheduledAt) >= wk && istDateKey(p.scheduledAt) <= to);
  const posts = inWeek.filter((p) => p.accountIds.some((id) => ids.has(id)));
  const models = {};
  for (const a of accounts) models[a.id] = await getModel(a);
  const autoAccounts = accounts.filter((a) => a.platform !== "manual");

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dk = addDaysKey(wk, i);
    const dayPosts = posts.filter((p) => istDateKey(p.scheduledAt) === dk);
    const igLike = autoAccounts.filter((a) => a.platform === "instagram");
    const best = bestTimeOfDay({ accounts: igLike.length ? igLike : autoAccounts, models, dateKey: dk });
    days.push({ date: dk, posts: dayPosts.map((p) => ({ ...publicPost(p, byIdAll), best: isPerfect(p, models, byIdAll) })), perfect: best?.at || null });
  }

  // Gaps: accounts with a weekly target ("cadence") that the week doesn't meet yet.
  const gaps = [];
  const now = new Date();
  for (const a of accounts) {
    if (!a.cadence) continue;
    const n = inWeek.filter((p) => p.accountIds.includes(a.id)).length;
    if (n >= a.cadence) continue;
    const startFrom = new Date(Math.max(now.getTime(), istToDate(wk, "00:00").getTime()));
    const daysLeft = Math.max(1, Math.ceil((istToDate(to, "23:59").getTime() - startFrom.getTime()) / 86400000));
    const slot = suggest({ accounts: [a], models, posts: postsAll, from: startFrom, days: daysLeft, count: 1 })[0];
    gaps.push({ accountId: a.id, name: a.name, platform: a.platform, brand: a.brand, have: n, want: a.cadence, slot: slot?.at || null });
  }

  const brands = [...new Set(accountsAll.map((a) => a.brand))].sort();
  const counts = {};
  for (const p of posts) for (const id of p.accountIds) if (ids.has(id)) counts[byIdAll[id].platform] = (counts[byIdAll[id].platform] || 0) + 1;
  return {
    weekFrom: wk,
    weekTo: to,
    brands,
    days,
    gaps,
    counts,
    total: posts.length,
    perfectCount: days.reduce((s, d) => s + d.posts.filter((p) => p.best).length, 0),
    windows: STARTING_WINDOWS,
    drafts: postsAll.filter((p) => p.status === "draft").map((p) => publicPost(p, byIdAll)),
  };
}

function isPerfect(p, models, byId) {
  if (!p.scheduledAt) return false;
  const { dow, h } = istParts(p.scheduledAt);
  const hi = HOURS.indexOf(h);
  if (hi < 0) return false;
  const vals = p.accountIds.map((id) => models[id]?.scores?.[dow]?.[hi]).filter((v) => typeof v === "number");
  if (!vals.length) return false;
  return vals.reduce((a, b) => a + b, 0) / vals.length >= 75;
}

export async function suggestions({ accountIds, dateKey }) {
  const accountsAll = await listAccounts();
  const accounts = accountsAll.filter((a) => accountIds.includes(a.id));
  if (!accounts.length) return [];
  const models = {};
  for (const a of accounts) models[a.id] = await getModel(a);
  const today = istDateKey(new Date());
  const posts = await listPosts({ from: today, to: addDaysKey(today, 8) });
  return suggest({ accounts, models, posts, from: new Date(), days: 7, count: 3, onlyDateKey: dateKey || null });
}

export async function insightsList() {
  const accounts = await listAccounts();
  const rows = [];
  for (const a of accounts) {
    if (a.platform === "manual") continue;
    const { latest, hist } = await accountData(a);
    rows.push({
      ...publicAccount(a),
      followers: latest?.followers ?? null,
      followersLabel: latest?.followersLabel || "Followers",
      reach28: latest?.reach28 ?? null,
      engagementRate: latest?.engagementRate ?? null,
      posts28: (latest?.posts || []).filter((p) => p.at && Date.now() - new Date(p.at) < 28 * 86400000).length,
      growth28: followerChange(hist, 28),
      at: latest?.at || null,
    });
  }
  const run = await getJSON("meta/insights-run");
  return { accounts: rows, lastRun: run?.at || null };
}

export async function insightsDetail(id) {
  const accounts = await listAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return null;
  const { latest, hist } = await accountData(a);
  const m = await getModel(a);
  const today = istDateKey(new Date());
  const ours = (await listPosts({ from: addDaysKey(today, -28), to: today })).filter((p) => p.targets?.[id]?.status === "posted");
  return {
    account: publicAccount(a),
    latest,
    hist,
    model: m,
    hours: HOURS,
    top: topSlots(m, 3),
    startingWindow: STARTING_WINDOWS[a.platform],
    postedFromHQ: ours.map((p) => ({ id: p.id, at: p.targets[id].at, url: p.targets[id].url, caption: (p.captions?.[a.platform] || p.caption || "").slice(0, 90), type: p.type })),
  };
}
