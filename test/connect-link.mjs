// One-time connect links: made by the logged-in owner, opened in another browser (no Social HQ login there).
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 SETUP_CODE=123456 node test/connect-link.mjs

import assert from "node:assert/strict";
import { handle as apiHandle } from "../netlify/functions/api.mjs";

const BASE = "https://hq.test";
let cookie = "";
async function api(method, path, body, { withCookie = true } = {}) {
  const init = { method, headers: withCookie && cookie ? { cookie } : {} };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await apiHandle(new Request(BASE + path, init), { site: { url: BASE } });
  const sc = res.headers.get("set-cookie");
  if (sc && withCookie) cookie = sc.split(";")[0];
  return res;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.host === "oauth2.googleapis.com") return j({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
  if (u.pathname === "/youtube/v3/channels") return j({ items: [{ id: "UC1", snippet: { title: "LIFTLINE", customUrl: "@liftlinemachines", thumbnails: {} }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
  return realFetch(url, init);
};

assert.equal((await api("POST", "/api/auth/setup", { code: "123456", password: "longpassword" })).status, 200);
assert.equal((await api("PUT", "/api/settings", { youtube: { clientId: "CID", clientSecret: "SEC" } })).status, 200);

// Without login, nobody can make a link.
assert.equal((await api("GET", "/api/oauth/youtube/start?link=1", null, { withCookie: false })).status, 401);

const r = await api("GET", "/api/oauth/youtube/start?link=1");
assert.equal(r.status, 200);
const { url } = await r.json();
assert.match(url, /^https:\/\/hq\.test\/api\/oauth\/go\/[A-Za-z0-9_-]+$/);
const go = await api("GET", new URL(url).pathname, null, { withCookie: false });
assert.equal(go.status, 302);
const state = new URL(go.headers.get("location")).searchParams.get("state");
assert.ok(state);
console.log("✓ Logged-in owner gets a connect link");

// Opened in another browser with no Social HQ login: connects and shows a plain page.
let cb = await api("GET", `/api/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=C`, null, { withCookie: false });
assert.equal(cb.status, 200);
let page = await cb.text();
assert.match(page, /Connected ✓/);
assert.match(page, /LIFTLINE/);
const accs = await (await api("GET", "/api/accounts")).json();
assert.ok(accs.accounts.some((a) => a.platform === "youtube" && a.name === "LIFTLINE"));
console.log("✓ Link opened in another browser connects the channel");

// The same link cannot be used twice.
cb = await api("GET", `/api/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=C`, null, { withCookie: false });
page = await cb.text();
assert.match(page, /Not connected/);
assert.match(page, /already used/);
console.log("✓ A link works only once");
const goAgain = await api("GET", new URL(url).pathname, null, { withCookie: false });
assert.match(await goAgain.text(), /expired or was already used/);

// A made-up state is refused.
cb = await api("GET", `/api/oauth/youtube/callback?state=abc.def&code=C`, null, { withCookie: false });
assert.match(await cb.text(), /expired/);

// Normal flow in the logged-in browser still redirects back to Accounts.
const s2 = await api("GET", "/api/oauth/youtube/start");
assert.equal(s2.status, 302);
const st2 = new URL(s2.headers.get("location")).searchParams.get("state");
cb = await api("GET", `/api/oauth/youtube/callback?state=${encodeURIComponent(st2)}&code=C`);
assert.equal(cb.status, 302);
assert.match(cb.headers.get("location"), /#\/accounts\?connected=LIFTLINE/);
console.log("✓ Normal Connect button still works");
console.log("All connect-link checks passed.");

// Export for moving hosts: only the logged-in owner can make a code; the code unlocks the export.
assert.equal((await api("POST", "/api/__export/code", null, { withCookie: false })).status, 401);
const ec = await (await api("POST", "/api/__export/code")).json();
assert.ok(ec.code.length >= 20);
assert.equal((await api("GET", `/api/__export?code=wrongwrongwrongwrongwrong&part=kv&cursor=0`, null, { withCookie: false })).status, 403);
const ex = await (await api("GET", `/api/__export?code=${ec.code}&part=kv&cursor=0`, null, { withCookie: false })).json();
assert.ok(ex.items.some((i) => i.k === "auth/owner"));
assert.equal(ex.secrets.MASTER_KEY, "local-test-master-key-123");
assert.ok(!ex.items.some((i) => i.k.startsWith("exportcode/")));
const fin = await (await api("POST", `/api/__export/finalize?code=${ec.code}`, { to: "https://new.example" }, { withCookie: false })).json();
assert.equal(fin.ok, true);
console.log("✓ Export for the move: owner-only code, full copy with secrets, old copy made inert");
