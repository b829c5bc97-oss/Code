// Social HQ API: every /api/* route plus the public photo links under /m/*.

import { json, redirect, readJSON, HttpError, env, errMessage } from "../lib/util.mjs";
import { authState, requireAuth, setup, login, logoutCookie, changePassword, logoutEverywhere, securityStatus, startTwoStep, finishTwoStep, stopTwoStep, newRecoveryCodes } from "../lib/auth.mjs";
import { logEvent, listEvents } from "../lib/audit.mjs";
import { listConnections, revokeConnection } from "../lib/oauth.mjs";
import { publicSettings, updateSettings, getSettings, configured } from "../lib/settings.mjs";
import { listAccounts, publicAccount, upsertConnected, addReminderAccount, updateAccount, removeAccount, getAccount, saveAccount } from "../lib/accounts.mjs";
import { listPosts, getPost, createPost, updatePost, deletePost, approvePost, prepareNow, markManualDone, claim } from "../lib/posts.mjs";
import { initUpload, putPart, completeUpload, mediaMeta, readPart } from "../lib/media.mjs";
import { platforms } from "../lib/platforms/index.mjs";
import { sign, verify, randomId, internalSecret } from "../lib/crypto.mjs";
import { overview, plan, suggestions, insightsList, insightsDetail } from "../lib/views.mjs";
import { triggerPublish } from "../lib/jobs.mjs";
import { getJSON, setJSON, del } from "../lib/store.mjs";
import { listRules, createRule, updateRule, deleteRule, getLog, testComment, runAutoReplies } from "../lib/autoreply.mjs";
import { cacheAvatar, readAvatar, refreshAvatars } from "../lib/avatars.mjs";
import { analysisFor } from "../lib/analysis.mjs";
import { competitorTable, addCompetitor, removeCompetitor, competitorDetail } from "../lib/competitors.mjs";

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

// ---------- One-time move to the new host (runs on the old Netlify site, token-protected) ----------
route("POST", "/api/__migrate", async ({ req }) => {
  const token = env("MIGRATE_TOKEN");
  const b = await readJSON(req);
  if (!token || !b.token || b.token.length < 20 || b.token !== token) throw new HttpError(403, "No.");
  const target = (env("MIGRATE_SUPABASE_URL") || "").replace(/\/$/, "");
  const key = env("MIGRATE_SUPABASE_KEY");
  if (!target || !key) throw new HttpError(400, "Target not set.");
  const { getStore } = await import("@netlify/blobs");
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const src = getStore({ name: b.store === "hq-media" ? "hq-media" : "hq", consistency: "strong" });
  if (b.finalize) {
    // Make the old copy inert so the old timers can't post or reply twice.
    const hq = getStore({ name: "hq", consistency: "strong" });
    const rules = (await hq.get("auto/rules", { type: "json" })) || [];
    for (const r of rules) r.on = false;
    await hq.setJSON("auto/rules", rules);
    const { blobs } = await hq.list({ prefix: "post/" });
    let parked = 0;
    for (const x of blobs) {
      const p = await hq.get(x.key, { type: "json" });
      if (p && ["scheduled", "needs_ok", "failed", "partial"].includes(p.status)) {
        p.status = "draft";
        p.note = "Moved to the new Social HQ";
        await hq.setJSON(x.key, p);
        parked++;
      }
    }
    await hq.setJSON("meta/moved", { at: new Date().toISOString(), to: b.to || "" });
    return json({ ok: true, rulesOff: rules.length, parked });
  }
  const { blobs } = await src.list();
  const keys = blobs.map((x) => x.key).sort();
  const start = Number(b.cursor) || 0;
  if (b.store === "hq-media") {
    const batch = keys.slice(start, start + 8);
    for (const k of batch) {
      const buf = await src.get(k, { type: "arrayBuffer" });
      if (!buf) continue;
      const path = k.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(`${target}/storage/v1/object/media/${path}`, { method: "POST", headers: { ...H, "content-type": "application/octet-stream", "x-upsert": "true" }, body: buf });
      if (!r.ok) throw new HttpError(502, `Media copy failed for ${k}: ${r.status} ${(await r.text()).slice(0, 120)}`);
    }
    return json({ total: keys.length, next: start + batch.length, done: start + batch.length >= keys.length });
  }
  const batch = keys.slice(start, start + 120);
  const items = [];
  for (let i = 0; i < batch.length; i += 12) {
    const vals = await Promise.all(batch.slice(i, i + 12).map(async (k) => ({ k, v: await src.get(k, { type: "json" }).catch(() => null) })));
    for (const it of vals) if (it.v !== null && it.v !== undefined) items.push(it);
  }
  if (items.length) {
    const r = await fetch(`${target}/rest/v1/rpc/kv_set_many`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ items }) });
    if (!r.ok) throw new HttpError(502, `Copy failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return json({ total: keys.length, next: start + batch.length, copied: items.length, done: start + batch.length >= keys.length });
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
