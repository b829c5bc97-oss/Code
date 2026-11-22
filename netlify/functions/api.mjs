// Social HQ API: every /api/* route plus the public photo links under /m/*.

import { json, redirect, readJSON, HttpError, env, errMessage } from "../lib/util.mjs";
import { authState, requireAuth, setup, login, logoutCookie, changePassword, logoutEverywhere, securityStatus, startTwoStep, finishTwoStep, stopTwoStep, newRecoveryCodes } from "../lib/auth.mjs";
import { logEvent, listEvents } from "../lib/audit.mjs";
import { listConnections, revokeConnection } from "../lib/oauth.mjs";
import { publicSettings, updateSettings, getSettings, configured } from "../lib/settings.mjs";
import { listAccounts, publicAccount, upsertConnected, addReminderAccount, updateAccount, removeAccount, getAccount, saveAccount } from "../lib/accounts.mjs";
import { listPosts, getPost, createPost, updatePost, deletePost, approvePost, prepareNow, markManualDone, claim } from "../lib/posts.mjs";
import { initUpload, putPart, completeUpload, mediaMeta, readPart, readAll, saveBuffer, deleteMedia } from "../lib/media.mjs";
import { mixSong, mixKey, normaliseMusic } from "../lib/music.mjs";
import { listKeys, listMediaKeys, getChunk, putChunk } from "../lib/store.mjs";
import { platforms } from "../lib/platforms/index.mjs";
import { sign, verify, randomId, internalSecret } from "../lib/crypto.mjs";
import { overview, plan, suggestions, insightsList, insightsDetail } from "../lib/views.mjs";
import { triggerPublish } from "../lib/jobs.mjs";
import { getJSON, setJSON, del } from "../lib/store.mjs";
import { listRules, createRule, updateRule, deleteRule, getLog, testComment, runAutoReplies } from "../lib/autoreply.mjs";
import { cacheAvatar, readAvatar, refreshAvatars } from "../lib/avatars.mjs";
import { analysisFor } from "../lib/analysis.mjs";
import { competitorTable, addCompetitor, removeCompetitor, competitorDetail } from "../lib/competitors.mjs";
import { sendAlert, alertLog } from "../lib/alerts.mjs";
import { vapidKeys, addSubscription, removeSubscription, listSubscriptions } from "../lib/push.mjs";
import { countVotes, savedVotes } from "../lib/votes.mjs";
import { doorKey, rotateDoorKey, checkDoor, addToInbox, listInbox, removeFromInbox, importFromLink } from "../lib/door.mjs";
import { checkLogins } from "../lib/logincheck.mjs";

function siteUrl(req, context) {
  return (env("URL") || context?.site?.url || new URL(req.url).origin).replace(/\/$/, "");
}

const routes = [];
function route(method, pattern, handler, { open = false } = {}) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  routes.push({ method, re, keys, handler, open });
}

// ---------- Public photo links (Instagram fetches photos from here) ----------
route("GET", "/m/:file", async ({ params }) => {
  const id = params.file.replace(/\.[a-z0-9]+$/i, "");
  const meta = await mediaMeta(id);
  if (meta.kind !== "image") throw new HttpError(404, "Not found");
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) parts.push(await readPart(id, i));
  return new Response(Buffer.concat(parts), { headers: { "content-type": meta.mime || "image/jpeg", "cache-control": "public, max-age=86400" } });
}, { open: true });

// ---------- Moving to a new host: the old site exports, the new site imports ----------
// The owner (logged in) makes a one-time code; the new site uses it to pull everything server-to-server.
route("POST", "/api/__export/code", async () => {
  const code = randomId(18);
  await setJSON(`exportcode/${code}`, { exp: Date.now() + 30 * 60000 });
  return json({ code });
});
async function exportCodeOk(code) {
  if (!code || !/^[A-Za-z0-9_-]{20,40}$/.test(code)) return false;
  const rec = await getJSON(`exportcode/${code}`);
  return !!rec && Date.now() < rec.exp;
}
route("GET", "/api/__export", async ({ url }) => {
  if (!(await exportCodeOk(url.searchParams.get("code")))) throw new HttpError(403, "Export code expired.");
  const part = url.searchParams.get("part") === "media" ? "media" : "kv";
  const start = Number(url.searchParams.get("cursor")) || 0;
  if (part === "media") {
    const keys = (await listMediaKeys("")).sort();
    const k = keys[start];
    if (!k) return json({ total: keys.length, done: true, items: [] });
    const buf = await getChunk(k);
    return json({ total: keys.length, next: start + 1, done: start + 1 >= keys.length, items: buf ? [{ k, b64: Buffer.from(buf).toString("base64") }] : [] });
  }
  const keys = (await listKeys("")).filter((k) => !k.startsWith("exportcode/") && !k.startsWith("lock/")).sort();
  const batch = keys.slice(start, start + 250);
  const items = [];
  for (let i = 0; i < batch.length; i += 25) {
    const vals = await Promise.all(batch.slice(i, i + 25).map(async (k) => ({ k, v: await getJSON(k).catch(() => null) })));
    for (const it of vals) if (it.v !== null && it.v !== undefined) items.push(it);
  }
  const out = { total: keys.length, next: start + batch.length, done: start + batch.length >= keys.length, items };
  if (start === 0) out.secrets = { MASTER_KEY: env("MASTER_KEY") || "", SETUP_CODE: env("SETUP_CODE") || "" };
  return json(out);
}, { open: true });
route("POST", "/api/__export/finalize", async ({ url, req }) => {
  if (!(await exportCodeOk(url.searchParams.get("code")))) throw new HttpError(403, "Export code expired.");
  const b = await readJSON(req);
  // Make the old copy inert so the old site's timers can't post or reply twice.
  const rules = (await getJSON("auto/rules")) || [];
  for (const r of rules) r.on = false;
  await setJSON("auto/rules", rules);
  let parked = 0;
  for (const k of await listKeys("post/")) {
    const p = await getJSON(k);
    if (p && ["scheduled", "needs_ok", "failed", "partial"].includes(p.status)) {
      p.status = "draft";
      p.note = "Moved to the new Social HQ";
      await setJSON(k, p);
      parked++;
    }
  }
  await setJSON("meta/moved", { at: new Date().toISOString(), to: String(b.to || "").slice(0, 200) });
  return json({ ok: true, rulesOff: rules.length, parked });
}, { open: true });

// The new site pulls everything once, from the old site (only allowed until the first import finishes).
route("POST", "/api/__import", async ({ req }) => {
  if (await getJSON("meta/imported")) throw new HttpError(403, "Already imported.");
  const b = await readJSON(req);
  const from = String(b.from || "").replace(/\/$/, "");
  if (!/^https:\/\/([a-z0-9-]+--)?socialhq-pratham\.netlify\.app$/.test(from)) throw new HttpError(400, "Import only from the old Social HQ.");
  const code = String(b.code || "");
  const pull = async (part, cursor) => {
    const r = await fetch(`${from}/api/__export?code=${encodeURIComponent(code)}&part=${part}&cursor=${cursor}`);
    const d = await r.json();
    if (!r.ok) throw new HttpError(502, d.error || `Export answered ${r.status}`);
    return d;
  };
  const { setMany } = await import("../lib/store.mjs");
  // Resumable: records and secrets first, then pictures/videos 4 at a time. If time runs short the
  // answer says where to continue (mediaFrom), and the old site is only switched off at the very end.
  const started = Date.now();
  const budget = Number(b.budgetMs) > 0 ? Math.min(Number(b.budgetMs), 250000) : 230000;
  let cursor = 0, kvCount = 0, mediaCount = 0, secrets = null, total = 0;
  if (!b.mediaFrom) {
    for (let guard = 0; guard < 200; guard++) {
      const d = await pull("kv", cursor);
      if (d.secrets) secrets = d.secrets;
      if (d.items.length) await setMany(d.items);
      kvCount += d.items.length;
      if (d.done) break;
      cursor = d.next;
    }
    if (secrets?.MASTER_KEY) await setJSON("secret/MASTER_KEY", { v: secrets.MASTER_KEY });
    if (secrets?.SETUP_CODE) await setJSON("secret/SETUP_CODE", { v: secrets.SETUP_CODE });
    if (!(await getJSON("secret/CRON_SECRET"))) await setJSON("secret/CRON_SECRET", { v: randomId(24) });
  }
  if (b.media !== false) {
    cursor = Number(b.mediaFrom) || 0;
    for (let guard = 0; guard < 2000; guard++) {
      if (Date.now() - started > budget) return json({ ok: true, partial: true, next: cursor, total, kv: kvCount, media: mediaCount });
      const batch = await Promise.all([0, 1, 2, 3].map((i) => pull("media", cursor + i)));
      total = batch[0].total;
      for (const d of batch) for (const it of d.items) await putChunk(it.k, Buffer.from(it.b64, "base64"));
      mediaCount += batch.reduce((n, d) => n + d.items.length, 0);
      cursor += 4;
      if (cursor >= total) break;
    }
  }
  let finalized = null;
  try {
    const r = await fetch(`${from}/api/__export/finalize?code=${encodeURIComponent(code)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: new URL(req.url).origin }) });
    finalized = await r.json();
  } catch (e) {
    finalized = { error: errMessage(e) };
  }
  await setJSON("meta/imported", { at: new Date().toISOString(), from, kv: kvCount, media: mediaCount });
  return json({ ok: true, kv: kvCount, media: mediaCount, finalized });
}, { open: true });

// ---------- Saved profile pictures ----------
route("GET", "/m/av/:id", async ({ params }) => {
  const buf = await readAvatar(params.id);
  if (!buf) return new Response("Not found", { status: 404 });
  let type = "image/jpeg";
  try { type = (await getAccount(params.id)).avatarType || type; } catch (_) { /* removed account */ }
  return new Response(buf, { headers: { "content-type": type, "cache-control": "public, max-age=604800, immutable" } });
}, { open: true });

// ---------- Login ----------
route("GET", "/api/auth/state", async ({ req }) => json(await authState(req)), { open: true });
route("POST", "/api/auth/setup", async ({ req }) => {
  const c = await setup(await readJSON(req));
  await logEvent("security", "Password set up for the first time", req);
  return json({ ok: true }, 200, { "Set-Cookie": c });
}, { open: true });
route("POST", "/api/auth/login", async ({ req }) => {
  try {
    const r = await login(await readJSON(req));
    await logEvent("login", r.usedRecovery ? `Logged in with a recovery code (${r.recoveryLeft} left)` : "Logged in", req);
    return json({ ok: true, recoveryLeft: r.usedRecovery ? r.recoveryLeft : undefined }, 200, { "Set-Cookie": r.cookie });
  } catch (e) {
    if (e.extra?.code !== "totp" || e.status !== 401) await logEvent("login", `Login failed: ${errMessage(e)}`, req);
    throw e;
  }
}, { open: true });
route("POST", "/api/auth/logout", async () => json({ ok: true }, 200, { "Set-Cookie": logoutCookie() }), { open: true });
route("POST", "/api/auth/password", async ({ req }) => {
  const c = await changePassword(await readJSON(req));
  await logEvent("security", "Password changed (all other sessions logged out)", req);
  return json({ ok: true }, 200, { "Set-Cookie": c });
});

// ---------- Security + Claude connection ----------
route("GET", "/api/security", async ({ req, context }) => {
  const s = await getSettings();
  return json({
    ...(await securityStatus()),
    mcpUrl: `${siteUrl(req, context)}/mcp`,
    claudeNeedsOk: !!s.claude?.requireApproval,
    connections: await listConnections(),
    events: await listEvents(80),
  });
});
route("POST", "/api/security/two-step/start", async () => json(await startTwoStep()));
route("POST", "/api/security/two-step/finish", async ({ req }) => {
  const r = await finishTwoStep(await readJSON(req));
  await logEvent("security", "2-step login turned on (other sessions logged out)", req);
  return json({ recovery: r.recovery }, 200, { "Set-Cookie": r.cookie });
});
route("POST", "/api/security/two-step/stop", async ({ req }) => {
  await stopTwoStep(await readJSON(req));
  await logEvent("security", "2-step login turned off", req);
  return json({ ok: true });
});
route("POST", "/api/security/recovery-codes", async ({ req }) => {
  const r = await newRecoveryCodes(await readJSON(req));
  await logEvent("security", "New recovery codes made (old ones stop working)", req);
  return json(r);
});
route("POST", "/api/security/logout-everywhere", async ({ req }) => {
  const c = await logoutEverywhere();
  await logEvent("security", "Logged out on every other device", req);
  return json({ ok: true }, 200, { "Set-Cookie": c });
});
route("DELETE", "/api/claude/connections/:id", async ({ req, params }) => {
  await revokeConnection(params.id);
  await logEvent("claude", params.id === "all" ? "Cut off every Claude connection" : "Cut off a Claude connection", req);
  return json({ ok: true });
});

// ---------- Settings ----------
route("GET", "/api/settings", async ({ req, context }) => json(await publicSettings(siteUrl(req, context))));
route("PUT", "/api/settings", async ({ req, context }) => {
  const patch = await readJSON(req);
  await updateSettings(patch);
  await logEvent("settings", `Changed settings: ${Object.keys(patch || {}).join(", ")}`, req);
  return json(await publicSettings(siteUrl(req, context)));
});
// ---------- Private upload door + Inbox ----------
route("GET", "/api/door", async ({ req, context }) => {
  const key = await doorKey();
  const site = siteUrl(req, context);
  return json({ page: `${site}/upload.html#k=${key}`, api: `${site}/api/door/${key}`, inbox: (await listInbox()).length });
});
route("POST", "/api/door/rotate", async ({ req, context }) => {
  const key = await rotateDoorKey();
  await logEvent("security", "Made a new private upload link (the old one stopped working)", req);
  const site = siteUrl(req, context);
  return json({ page: `${site}/upload.html#k=${key}`, api: `${site}/api/door/${key}` });
});
route("GET", "/api/inbox-files", async () => json({ files: await listInbox() }));
route("DELETE", "/api/inbox-files/:id", async ({ params }) => { await removeFromInbox(params.id); return json({ ok: true }); });
route("POST", "/api/inbox-files/link", async ({ req }) => {
  const b = await readJSON(req);
  const m = await importFromLink(b.url, { name: b.name });
  return json({ file: await addToInbox(m, { caption: b.caption, note: b.note, source: "link" }), warn: m.warn || undefined });
});
// Open (the secret key in the address is the password)
route("GET", "/api/door/:key", async ({ params }) => { await checkDoor(params.key); return json({ ok: true, chunkSize: 3 * 1024 * 1024 }); }, { open: true });
route("POST", "/api/door/:key/start", async ({ req, params }) => { await checkDoor(params.key); return json(await initUpload(await readJSON(req))); }, { open: true });
route("PUT", "/api/door/:key/part/:id/:index", async ({ req, params }) => { await checkDoor(params.key); return json(await putPart(params.id, params.index, await req.arrayBuffer())); }, { open: true });
route("POST", "/api/door/:key/finish/:id", async ({ req, params }) => {
  await checkDoor(params.key);
  const b = await readJSON(req).catch(() => ({}));
  const m = await completeUpload(params.id);
  return json({ file: await addToInbox(m, { caption: b?.caption, note: b?.note, source: "door" }) });
}, { open: true });
route("POST", "/api/door/:key/link", async ({ req, params }) => {
  await checkDoor(params.key);
  const b = await readJSON(req);
  const m = await importFromLink(b.url, { name: b.name });
  return json({ file: await addToInbox(m, { caption: b.caption, note: b.note, source: "door-link" }), warn: m.warn || undefined });
}, { open: true });

// ---------- Vote counter (this-or-that posts) ----------
route("GET", "/api/votes/:acc/:media", async ({ params }) => json((await savedVotes(params.acc, params.media)) || {}));
route("POST", "/api/votes/:acc/:media", async ({ req, params }) => {
  const b = await readJSON(req).catch(() => ({}));
  return json(await countVotes(params.acc, params.media, { options: Array.isArray(b?.options) ? b.options : undefined }));
});

// ---------- Phone notifications (Web Push) ----------
route("GET", "/api/push", async () => {
  const k = await vapidKeys();
  return json({ publicKey: k.publicKey, devices: (await listSubscriptions()).map((s) => ({ id: s.id, device: s.device, at: s.at })) });
});
route("POST", "/api/push/subscribe", async ({ req }) => {
  const b = await readJSON(req);
  try {
    return json(await addSubscription(b.subscription, b.device));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
route("DELETE", "/api/push/:id", async ({ params }) => { await removeSubscription(params.id); return json({ ok: true }); });

// ---------- Alerts ----------
route("GET", "/api/alerts", async () => json({ alerts: await alertLog() }));
route("POST", "/api/alerts/test", async ({ req, context }) =>
  json(await sendAlert(await getSettings(), { title: "Test alert", text: "Alerts are working. Social HQ will message you here when a post fails or an account's login is about to end.", link: siteUrl(req, context) }))
);
route("POST", "/api/alerts/check-logins", async ({ req, context }) => json(await checkLogins({ siteUrl: siteUrl(req, context) })));

route("GET", "/api/health", async () => {
  const s = await getSettings();
  return json({
    masterKey: !!env("MASTER_KEY"),
    setupCode: !!env("SETUP_CODE"),
    platforms: Object.fromEntries(["instagram", "facebook", "linkedin", "youtube", "pinterest"].map((p) => [p, configured(s, p)])),
  });
});

// ---------- Accounts ----------
route("GET", "/api/accounts", async () => {
  const s = await getSettings();
  const accounts = (await listAccounts()).map(publicAccount);
  return json({
    accounts,
    configured: Object.fromEntries(["instagram", "facebook", "linkedin", "youtube", "pinterest"].map((p) => [p, configured(s, p)])),
    pinterestSandbox: !!s.pinterest.sandbox,
    linkedinOrg: !!s.linkedin.orgAccess,
  });
});
route("POST", "/api/accounts/reminder", async ({ req }) => json(publicAccount(await addReminderAccount(await readJSON(req)))));
route("PATCH", "/api/accounts/:id", async ({ req, params }) => json(publicAccount(await updateAccount(params.id, await readJSON(req)))));
route("DELETE", "/api/accounts/:id", async ({ req, params }) => {
  await removeAccount(params.id);
  await logEvent("account", `Removed account ${params.id}`, req);
  return json({ ok: true });
});
route("POST", "/api/accounts/:id/boards", async ({ params }) => {
  const a = await getAccount(params.id);
  if (a.platform !== "pinterest") throw new HttpError(400, "Only Pinterest accounts have boards.");
  const s = await getSettings();
  const { account } = await platforms.pinterest.ensureToken({ account: a, settings: s });
  await platforms.pinterest.refreshBoards(account);
  await saveAccount(account);
  return json(publicAccount(account));
});

// ---------- One account's own page: profile, past posts, one post's numbers ----------
async function liveAccount(id) {
  const a = await getAccount(id);
  const settings = await getSettings();
  const p = platforms[a.platform];
  if (!p) return { account: a, settings, p: null };
  const { account, changed } = await p.ensureToken({ account: a, settings });
  if (changed) await saveAccount(account);
  return { account, settings, p };
}
function istKey(d) {
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
route("GET", "/api/accounts/:id/profile", async ({ params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  const today = new Date();
  const posts = await listPosts({ from: istKey(new Date(today.getTime() - 30 * 86400000)), to: istKey(new Date(today.getTime() + 60 * 86400000)), drafts: true });
  const mine = posts.filter((x) => (x.accountIds || []).includes(account.id) || x.targets?.[account.id]).map((x) => ({
    id: x.id,
    at: x.targets?.[account.id]?.at || x.scheduledAt,
    status: x.targets?.[account.id]?.status || x.status,
    url: x.targets?.[account.id]?.url || "",
    type: x.type,
    caption: (x.captions?.[account.platform] || x.caption || x.title || "").slice(0, 140),
  })).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  let profile = null, error = "";
  if (p?.profile) {
    try { profile = await p.profile({ settings, account }); } catch (e) { error = errMessage(e); }
    if (profile?.avatar && (profile.avatar !== account.avatar || !account.avatarCached)) {
      if (await cacheAvatar(account, profile.avatar)) await saveAccount(account);
    }
    if (profile && account.avatarCached) profile.avatar = `/m/av/${encodeURIComponent(account.id)}?v=${account.avatarCached}`;
  }
  return json({ account: publicAccount(account), profile, error, hq: mine, canBrowse: !!p?.feed });
});
route("GET", "/api/accounts/:id/feed", async ({ params, url }) => {
  const { account, settings, p } = await liveAccount(params.id);
  if (!p?.feed) {
    const latest = await getJSON(`ins/${account.id}/latest`);
    return json({ posts: (latest?.posts || []).map((x) => ({ ...x, caption: x.title || "" })), next: null, saved: true });
  }
  return json(await p.feed({ settings, account, after: url.searchParams.get("after") || undefined }));
});
route("GET", "/api/accounts/:id/feed/:postId", async ({ params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  if (!p?.postDetail) throw new HttpError(400, "Post details for this platform come soon.");
  return json(await p.postDetail({ settings, account, postId: params.postId }));
});

// Posts already live on the platforms (from the 6-hourly insights), for the month calendar.
route("GET", "/api/published", async ({ url }) => {
  const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
  const out = [];
  for (const a of await listAccounts()) {
    if (a.platform === "manual") continue;
    const latest = await getJSON(`ins/${a.id}/latest`);
    for (const p of latest?.posts || []) {
      if (!p.at) continue;
      const d = new Date(new Date(p.at).getTime() + 330 * 60000).toISOString().slice(0, 10);
      if ((from && d < from) || (to && d > to)) continue;
      out.push({ accountId: a.id, platform: a.platform, brand: a.brand, name: a.name, at: p.at, type: p.type, title: p.title || "", url: p.url || "", reach: p.reach || 0, views: p.views || 0, interactions: p.interactions || 0 });
    }
  }
  return json(out);
});

// ---------- Auto-replies ----------
route("GET", "/api/autoreplies", async () => json({ rules: await listRules(), log: await getLog(), lastRun: await getJSON("auto/run") }));
route("POST", "/api/autoreplies", async ({ req }) => {
  const r = await createRule(await readJSON(req));
  await logEvent("settings", `Auto-reply “${r.name}” created (${r.on ? "on" : "off"})`, req);
  return json(r);
});
route("PUT", "/api/autoreplies/:id", async ({ req, params }) => {
  const r = await updateRule(params.id, await readJSON(req));
  await logEvent("settings", `Auto-reply “${r.name}” saved (${r.on ? "on" : "off"})`, req);
  return json(r);
});
route("DELETE", "/api/autoreplies/:id", async ({ req, params }) => {
  await deleteRule(params.id);
  await logEvent("settings", "Auto-reply removed", req);
  return json({ ok: true });
});
route("POST", "/api/autoreplies/test", async ({ req }) => json(await testComment(await readJSON(req))));
route("POST", "/api/autoreplies/run", async () => {
  const r = await runAutoReplies();
  return json({ checked: r.checked, replied: r.replied });
});

// ---------- Competitors ----------
route("GET", "/api/competitors", async ({ url }) => json(await competitorTable({ force: url.searchParams.get("fresh") === "1" })));
route("POST", "/api/competitors", async ({ req }) => {
  const b = await readJSON(req);
  const row = await addCompetitor(b.username);
  await logEvent("settings", `Started tracking @${row.username}`, req);
  return json(row);
});
route("GET", "/api/competitors/:u", async ({ params }) => json(await competitorDetail(params.u)));
route("DELETE", "/api/competitors/:u", async ({ req, params }) => {
  await removeCompetitor(params.u);
  await logEvent("settings", `Stopped tracking @${params.u}`, req);
  return json({ ok: true });
});

route("POST", "/api/accounts-avatars", async () => json(await refreshAvatars()));

route("GET", "/api/analysis/:id", async ({ params, url }) => json(await analysisFor(params.id, { refresh: url.searchParams.get("refresh") === "1" })));

// ---------- Comments inbox ----------
route("GET", "/api/accounts/:id/audience", async ({ params, url }) => {
  const key = `aud/${params.id}`;
  const cached = url.searchParams.get("fresh") ? null : await getJSON(key);
  if (cached && Date.now() - new Date(cached.at).getTime() < 6 * 3600000) return json(cached);
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "audience", "Audience details");
  const out = { ...(await p.audience({ settings, account })), at: new Date().toISOString() };
  await setJSON(key, out);
  return json(out);
});


function needs(p, fn, what) {
  if (!p?.[fn]) throw new HttpError(400, `${what} for this platform is not available yet.`);
}
route("GET", "/api/inbox/:id", async ({ params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "recentComments", "Comments");
  const comments = await p.recentComments({ settings, account });
  const seen = (await getJSON("inbox/seen")) || {};
  return json({ account: publicAccount(account), comments, seenAt: seen[account.id] || null });
});
route("POST", "/api/inbox/seen", async ({ req }) => {
  const body = await readJSON(req);
  const seen = (await getJSON("inbox/seen")) || {};
  const now = new Date().toISOString();
  for (const id of Array.isArray(body.ids) ? body.ids.slice(0, 50) : []) seen[String(id).slice(0, 80)] = now;
  await setJSON("inbox/seen", seen);
  return json({ ok: true });
});
route("GET", "/api/accounts/:id/feed/:postId/comments", async ({ params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "comments", "Comments");
  return json({ comments: await p.comments({ settings, account, postId: params.postId }) });
});
route("POST", "/api/comments/:id/:commentId/reply", async ({ req, params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "replyComment", "Replying");
  const body = await readJSON(req);
  const message = String(body.message || "").trim().slice(0, 2200);
  if (!message) throw new HttpError(400, "Write a reply first.");
  const r = await p.replyComment({ settings, account, commentId: params.commentId, message });
  await logEvent("comment", `Replied to a comment on ${account.name}`, req);
  return json(r);
});
route("POST", "/api/comments/:id/:commentId/hide", async ({ req, params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "hideComment", "Hiding comments");
  const body = await readJSON(req);
  const r = await p.hideComment({ settings, account, commentId: params.commentId, hide: body.hide !== false });
  await logEvent("comment", `${body.hide !== false ? "Hid" : "Unhid"} a comment on ${account.name}`, req);
  return json(r);
});
route("DELETE", "/api/comments/:id/:commentId", async ({ req, params }) => {
  const { account, settings, p } = await liveAccount(params.id);
  needs(p, "deleteComment", "Deleting comments");
  const r = await p.deleteComment({ settings, account, commentId: params.commentId });
  await logEvent("comment", `Deleted a comment on ${account.name}`, req);
  return json(r);
});

// ---------- Connecting accounts (OAuth) ----------
route("GET", "/api/oauth/:platform/start", async ({ req, params, context, url }) => {
  const p = platforms[params.platform];
  if (!p) throw new HttpError(404, "Unknown platform.");
  const settings = await getSettings();
  const asLink = url.searchParams.get("link") === "1";
  if (!configured(settings, params.platform)) {
    if (asLink) throw new HttpError(400, "Add this platform's app keys in Settings first.");
    return redirect(`/#/settings?missing=${params.platform}`);
  }
  // Each login link works once and for 15 minutes. Only a logged-in owner can make one,
  // so the link can also be opened in another browser or phone that is signed in to the account.
  const n = randomId(12);
  const exp = Date.now() + 15 * 60000;
  const state = sign({ p: params.platform, n, exp }, "oauth");
  const target = p.authUrl({ settings, redirectUri: `${siteUrl(req, context)}/api/oauth/${params.platform}/callback`, state });
  await setJSON(`oauthstate/${n}`, { p: params.platform, exp, url: asLink ? target : "" });
  if (asLink) return json({ url: `${siteUrl(req, context)}/api/oauth/go/${n}`, expiresAt: new Date(exp).toISOString() });
  return redirect(target);
});

// Short connect link (for another browser or a phone): sends you on to the platform's login.
route("GET", "/api/oauth/go/:n", async ({ params }) => {
  const rec = /^[A-Za-z0-9_-]{8,40}$/.test(params.n) ? await getJSON(`oauthstate/${params.n}`) : null;
  if (!rec || !rec.url || Date.now() > rec.exp) return doneHtml(false, "This connect link has expired or was already used. Make a new one on the Accounts screen.");
  return redirect(rec.url);
}, { open: true });

function doneHtml(ok, text) {
  const safe = String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Social HQ</title>
<style>body{font:16px system-ui,-apple-system,Segoe UI,sans-serif;background:#F6F7FB;color:#14172B;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
.c{background:#fff;border:1px solid #E3E6F0;border-radius:16px;padding:28px;max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#5B6178;margin:0}</style></head>
<body><div class="c"><h1>${ok ? "Connected ✓" : "Not connected"}</h1><p>${safe}</p><p style="margin-top:12px">You can close this tab.</p></div></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}

route("GET", "/api/oauth/:platform/callback", async ({ req, params, context }) => {
  const url = new URL(req.url);
  const platform = params.platform;
  let loggedIn = true;
  try { await requireAuth(req); } catch (_) { loggedIn = false; }
  const back = (q) => {
    if (loggedIn) return redirect(`/#/accounts?${q}`);
    const sp = new URLSearchParams(q);
    return sp.get("connected") ? doneHtml(true, `Social HQ now has: ${sp.get("connected")}.`) : doneHtml(false, sp.get("error") || "Something went wrong.");
  };
  try {
    if (!platforms[platform]) return back("error=" + encodeURIComponent("Unknown platform."));
    const st = verify(url.searchParams.get("state"), "oauth");
    if (!st || st.p !== platform || !st.n) return back("error=" + encodeURIComponent("That login link expired. Press Connect again."));
    const key = `oauthstate/${st.n}`;
    if (!(await getJSON(key))) return back("error=" + encodeURIComponent("That login link was already used. Press Connect again."));
    await del(key);
    const err = url.searchParams.get("error_description") || url.searchParams.get("error_message") || url.searchParams.get("error");
    if (err) return back("error=" + encodeURIComponent(`${platform}: ${err}`));
    const code = url.searchParams.get("code");
    if (!code) return back("error=" + encodeURIComponent("No login code came back."));
    const settings = await getSettings();
    const found = await platforms[platform].callback({ settings, redirectUri: `${siteUrl(req, context)}/api/oauth/${platform}/callback`, code });
    const names = [];
    for (const acc of found) {
      const saved = await upsertConnected(acc);
      names.push(saved.name);
    }
    await logEvent("account", `Connected ${platform}: ${names.join(", ")}${loggedIn ? "" : " (link opened in another browser)"}`, req);
    return back("connected=" + encodeURIComponent(names.join(", ")));
  } catch (e) {
    return back("error=" + encodeURIComponent(`${platform}: ${errMessage(e)}`));
  }
}, { open: true });

// ---------- Posts ----------
route("GET", "/api/posts", async ({ url }) => {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to") || from;
  if (!from) throw new HttpError(400, "from= is needed.");
  return json(await listPosts({ from, to, drafts: url.searchParams.get("drafts") === "1" }));
});
route("POST", "/api/posts", async ({ req, context }) => {
  const body = await readJSON(req);
  let post = await createPost(body);
  if (body.publishNow) post = await publishNow(post.id, req, context);
  return json(post);
});
route("GET", "/api/posts/:id", async ({ params }) => json(await getPost(params.id)));
route("PUT", "/api/posts/:id", async ({ req, params, context }) => {
  const body = await readJSON(req);
  let post = await updatePost(params.id, body);
  if (body.publishNow) post = await publishNow(post.id, req, context);
  return json(post);
});
route("DELETE", "/api/posts/:id", async ({ params }) => {
  await deletePost(params.id);
  return json({ ok: true });
});
route("POST", "/api/posts/:id/approve", async ({ params, req, context }) => {
  const post = await approvePost(params.id);
  if (post.status === "scheduled" && new Date(post.scheduledAt) <= new Date()) return json(await publishNow(post.id, req, context));
  return json(post);
});
route("POST", "/api/posts/:id/publish-now", async ({ params, req, context }) => json(await publishNow(params.id, req, context)));
route("POST", "/api/posts/:id/retry", async ({ params, req, context }) => {
  await prepareNow(params.id, { retry: true });
  await kick(params.id, req, context);
  return json(await getPost(params.id));
});
route("POST", "/api/posts/:id/done/:account", async ({ params }) => json(await markManualDone(params.id, params.account)));

async function kick(id, req, context) {
  if (await claim(id)) await triggerPublish(siteUrl(req, context), id);
}
async function publishNow(id, req, context) {
  await prepareNow(id);
  await kick(id, req, context);
  return await getPost(id);
}

// ---------- Media ----------
route("POST", "/api/media", async ({ req }) => json(await initUpload(await readJSON(req))));
route("PUT", "/api/media/:id/part/:index", async ({ req, params }) => json(await putPart(params.id, params.index, await req.arrayBuffer())));
route("POST", "/api/media/:id/complete", async ({ params }) => json(await completeUpload(params.id)));
route("GET", "/api/media/:id", async ({ params }) => json(await mediaMeta(params.id)));
// Makes the final video with the song mixed in, so it can be played back before scheduling.
// Posting reuses it if the settings haven't changed since.
route("POST", "/api/music/mix", async ({ req }) => {
  const body = await readJSON(req);
  const music = normaliseMusic({ ...(body.music || {}), mode: "mix" });
  if (!music.mediaId) throw new HttpError(400, "Pick the song first.");
  const video = await mediaMeta(String(body.videoId || ""));
  if (video.kind !== "video") throw new HttpError(400, "A song can only be added to a video.");
  const r = await mixSong({ video: await readAll(video.id), song: await readAll(music.mediaId), startSec: music.startSec, musicVol: music.musicVol, voiceVol: music.voiceVol, duck: music.duck, fade: music.fade });
  // keep: false = only check that the mix works (nothing is stored).
  if (body.keep === false) return json({ ok: true, size: r.buf.length, duration: r.duration, songDuration: r.songDuration, hadVoice: r.hadVoice });
  const saved = await saveBuffer({ name: video.name.replace(/(\.[^.]+)?$/, " (with song).mp4"), mime: "video/mp4", buf: r.buf });
  if (body.previousId && body.previousId !== saved.id) {
    try {
      const prev = await mediaMeta(String(body.previousId));
      if (/\(with song\)/.test(prev.name)) await deleteMedia(prev.id);
    } catch (_) { /* already gone */ }
  }
  return json({ id: saved.id, size: saved.size, mime: saved.mime, chunks: saved.chunks, key: mixKey(video.id, music), duration: r.duration, songDuration: r.songDuration, hadVoice: r.hadVoice });
});
route("GET", "/api/media/:id/part/:index", async ({ params }) => {
  const meta = await mediaMeta(params.id);
  return new Response(await readPart(params.id, params.index), { headers: { "content-type": meta.mime, "cache-control": "private, max-age=3600" } });
});

// ---------- Screens ----------
route("GET", "/api/overview", async () => json(await overview()));
route("GET", "/api/plan", async ({ url }) => json(await plan({ from: url.searchParams.get("from"), brand: url.searchParams.get("brand") })));
route("POST", "/api/suggest", async ({ req }) => {
  const b = await readJSON(req);
  return json(await suggestions({ accountIds: b.accountIds || [], dateKey: b.date || null }));
});
route("GET", "/api/insights", async () => json(await insightsList()));
route("GET", "/api/insights/:id", async ({ params }) => {
  const d = await insightsDetail(params.id);
  if (!d) throw new HttpError(404, "Account not found.");
  return json(d);
});
route("POST", "/api/insights/refresh", async ({ req, context, url }) => {
  const res = await fetch(`${siteUrl(req, context)}/internal/insights`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hq-secret": internalSecret() },
    body: JSON.stringify({ only: url.searchParams.get("account") || null }),
  });
  return json({ started: res.status === 202 || res.ok });
});

export async function handle(req, context) {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      // Changes must come from Social HQ's own pages (blocks other sites posting forms here).
      if (req.method !== "GET" && !path.startsWith("/m/")) {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin && origin !== siteUrl(req, context)) throw new HttpError(403, "Request from another website was blocked.");
      }
      if (!r.open) await requireAuth(req);
      return await r.handler({ req, context, params, url });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status && e.status >= 400 && e.status < 600 ? 502 : 500;
    if (status >= 500) console.error(e);
    return json({ error: errMessage(e), ...(e.extra || {}) }, status);
  }
}

export default handle;

export const config = {
  path: ["/api/*", "/m/*"],
};
