// Social HQ API: every /api/* route plus the public photo links under /m/*.

import { json, redirect, readJSON, HttpError, env, errMessage } from "../lib/util.mjs";
import { authState, requireAuth, setup, login, logoutCookie, changePassword } from "../lib/auth.mjs";
import { publicSettings, updateSettings, getSettings, configured } from "../lib/settings.mjs";
import { listAccounts, publicAccount, upsertConnected, addReminderAccount, updateAccount, removeAccount, getAccount, saveAccount } from "../lib/accounts.mjs";
import { listPosts, getPost, createPost, updatePost, deletePost, approvePost, prepareNow, markManualDone, claim } from "../lib/posts.mjs";
import { initUpload, putPart, completeUpload, mediaMeta, readPart } from "../lib/media.mjs";
import { platforms } from "../lib/platforms/index.mjs";
import { sign, verify, randomId, internalSecret } from "../lib/crypto.mjs";
import { overview, plan, suggestions, insightsList, insightsDetail } from "../lib/views.mjs";
import { triggerPublish } from "../lib/jobs.mjs";

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

// ---------- Login ----------
route("GET", "/api/auth/state", async ({ req }) => json(await authState(req)), { open: true });
route("POST", "/api/auth/setup", async ({ req }) => {
  const c = await setup(await readJSON(req));
  return json({ ok: true }, 200, { "Set-Cookie": c });
}, { open: true });
route("POST", "/api/auth/login", async ({ req }) => {
  const c = await login(await readJSON(req));
  return json({ ok: true }, 200, { "Set-Cookie": c });
}, { open: true });
route("POST", "/api/auth/logout", async () => json({ ok: true }, 200, { "Set-Cookie": logoutCookie() }), { open: true });
route("POST", "/api/auth/password", async ({ req }) => {
  const c = await changePassword(await readJSON(req));
  return json({ ok: true }, 200, { "Set-Cookie": c });
});

// ---------- Settings ----------
route("GET", "/api/settings", async ({ req, context }) => json(await publicSettings(siteUrl(req, context))));
route("PUT", "/api/settings", async ({ req, context }) => {
  await updateSettings(await readJSON(req));
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
route("DELETE", "/api/accounts/:id", async ({ params }) => {
  await removeAccount(params.id);
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

// ---------- Connecting accounts (OAuth) ----------
route("GET", "/api/oauth/:platform/start", async ({ req, params, context }) => {
  const p = platforms[params.platform];
  if (!p) throw new HttpError(404, "Unknown platform.");
  const settings = await getSettings();
  if (!configured(settings, params.platform)) return redirect(`/#/settings?missing=${params.platform}`);
  const state = sign({ p: params.platform, n: randomId(8), exp: Date.now() + 15 * 60000 }, "oauth");
  return redirect(p.authUrl({ settings, redirectUri: `${siteUrl(req, context)}/api/oauth/${params.platform}/callback`, state }));
});

route("GET", "/api/oauth/:platform/callback", async ({ req, params, context }) => {
  const url = new URL(req.url);
  const platform = params.platform;
  const back = (q) => redirect(`/#/accounts?${q}`);
  try {
    const st = verify(url.searchParams.get("state"), "oauth");
    if (!st || st.p !== platform) return back("error=" + encodeURIComponent("That login link expired. Press Connect again."));
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
    return back("connected=" + encodeURIComponent(names.join(", ")));
  } catch (e) {
    return back("error=" + encodeURIComponent(`${platform}: ${errMessage(e)}`));
  }
});

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
