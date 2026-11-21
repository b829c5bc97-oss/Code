// Checks the Instagram (Unified login) and Facebook Pages connectors against a fake Meta.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/meta-unified.mjs

import assert from "node:assert/strict";
import * as instagram from "../netlify/lib/platforms/instagram.mjs";
import * as facebook from "../netlify/lib/platforms/facebook.mjs";

const settings = {
  instagram: { appId: "APP", appSecret: "SEC", configId: "222" },
  facebook: { configId: "186" },
  general: { graphVersion: "v25.0" },
};
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  seen.push(`${init.method || "GET"} ${u.pathname}`);
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.pathname.endsWith("/oauth/access_token")) {
    assert.equal(u.searchParams.get("client_secret"), "SEC");
    return j({ access_token: u.searchParams.get("fb_exchange_token") ? "LONGUSER" : "SUAT", token_type: "bearer" });
  }
  if (u.pathname.endsWith("/debug_token")) return j({ data: { granular_scopes: [{ scope: "instagram_basic", target_ids: ["17841", "17842"] }, { scope: "ads_read", target_ids: ["act_1"] }] } });
  if (u.pathname.endsWith("/me/assigned_instagram_accounts")) return j({ data: [{ id: "17842" }] });
  if (u.pathname.endsWith("/me/instagram_accounts")) return new Response(JSON.stringify({ error: { message: "Unknown path", code: 100 } }), { status: 400 });
  if (u.pathname.endsWith("/17841")) return j({ id: "17841", username: "info.liftline", name: "LIFTLINE", profile_picture_url: "https://x/p.jpg" });
  if (u.pathname.endsWith("/17842")) return j({ id: "17842", username: "coinwisekids", name: "Coinwise Kids" });
  if (u.pathname.endsWith("/me/accounts")) {
    assert.equal(u.searchParams.get("access_token"), "LONGUSER");
    return j({ data: [{ id: "55", name: "Lift Line", access_token: "PAGETOKEN", username: "liftline" }] });
  }
  return new Response(JSON.stringify({ error: { message: "unexpected " + u.pathname } }), { status: 400 });
};

const igUrl = new URL(instagram.authUrl({ settings, redirectUri: "https://hq.test/api/oauth/instagram/callback", state: "S" }));
assert.equal(igUrl.origin + igUrl.pathname, "https://www.facebook.com/v25.0/dialog/oauth");
assert.equal(igUrl.searchParams.get("config_id"), "222");
assert.equal(igUrl.searchParams.get("override_default_response_type"), "true");

const ig = await instagram.callback({ settings, redirectUri: "https://hq.test/api/oauth/instagram/callback", code: "C" });
assert.deepEqual(ig.map((a) => a.handle), ["@info.liftline", "@coinwisekids"]);
assert.equal(ig[0].token, "SUAT");
assert.equal(ig[0].tokenExpiresAt, null, "Unified login keys never expire");
assert.equal(ig[0].remoteId, "17841");
console.log("✓ Instagram unified login finds every ticked account");

const fb = await facebook.callback({ settings, redirectUri: "https://hq.test/api/oauth/facebook/callback", code: "C" });
assert.equal(fb[0].token, "PAGETOKEN");
assert.equal(fb[0].handle, "@liftline");
const fbUrl = new URL(facebook.authUrl({ settings, redirectUri: "https://hq.test/api/oauth/facebook/callback", state: "S" }));
assert.equal(fbUrl.searchParams.get("client_id"), "APP");
assert.equal(fbUrl.searchParams.get("config_id"), "186");
console.log("✓ Facebook Pages login uses the shared Meta app and its configuration");
