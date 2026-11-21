// Claude connector + security test: OAuth sign-in, MCP tools, 2-step login, cut-off, activity.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 SETUP_CODE=123456 node test/claude-mcp.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handle as apiHandle } from "../netlify/functions/api.mjs";
import { handle as mcpHandle } from "../netlify/functions/mcp.mjs";
import { upsertConnected } from "../netlify/lib/accounts.mjs";
import { codeAt, currentCounter } from "../netlify/lib/totp.mjs";

const BASE = "https://hq.test";
const ctx = { site: { url: BASE } };
let cookie = "";

async function api(method, path, body, headers = {}) {
  const init = { method, headers: { cookie, ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await apiHandle(new Request(BASE + path, init), ctx);
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function mcp(method, path, { body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  if (form) {
    init.body = new URLSearchParams(form).toString();
    init.headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return await mcpHandle(new Request(BASE + path, init), ctx);
}

// Owner + one Facebook Page
assert.equal((await api("POST", "/api/auth/setup", { code: "123456", password: "longpassword" })).status, 200);
await upsertConnected({ platform: "facebook", kind: "fb_page", remoteId: "55", name: "Lift Line", handle: "@liftline", token: "PAGETOKEN" });

// Discovery
let res = await mcp("GET", "/.well-known/oauth-protected-resource");
assert.equal((await res.json()).resource, BASE + "/mcp");
res = await mcp("GET", "/.well-known/oauth-authorization-server");
const meta = await res.json();
assert.equal(meta.token_endpoint, BASE + "/oauth/token");
assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
res = await mcp("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
assert.equal(res.status, 401);
assert.ok(res.headers.get("www-authenticate").includes("resource_metadata="));
console.log("✓ discovery + 401 challenge");

// Registration only for Claude's return addresses
res = await mcp("POST", "/oauth/register", { body: { redirect_uris: ["https://evil.example/cb"], client_name: "Evil" } });
assert.equal(res.status, 400);
res = await mcp("POST", "/oauth/register", { body: { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" } });
assert.equal(res.status, 201);
const client = await res.json();
console.log("✓ only Claude can register");

// Approval page
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: BASE + "/mcp" });
res = await mcp("GET", "/oauth/authorize?" + q);
assert.equal(res.status, 200);
let html = await res.text();
assert.ok(html.includes("Let Claude use Social HQ?"));
const reqToken = html.match(/name="req" value="([^"]+)"/)[1].replace(/&amp;/g, "&");
res = await mcp("GET", "/oauth/authorize?" + new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" }));
assert.equal(res.status, 400);
res = await mcp("POST", "/oauth/authorize", { form: { req: reqToken, password: "wrong", decision: "allow" } });
assert.equal(res.status, 400);
assert.ok((await res.text()).includes("Wrong password"));
res = await mcp("POST", "/oauth/authorize", { form: { req: reqToken, password: "longpassword", decision: "allow" } });
assert.equal(res.status, 303);
const back = new URL(res.headers.get("location"));
assert.equal(back.origin + back.pathname, "https://claude.ai/api/mcp/auth_callback");
assert.equal(back.searchParams.get("state"), "xyz");
const code = back.searchParams.get("code");
console.log("✓ approval needs the Social HQ password");

// Keys
res = await mcp("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: "wrong-verifier" } });
assert.equal(res.status, 400);
// A failed PKCE check burns the code too, so approve again.
res = await mcp("POST", "/oauth/authorize", { form: { req: reqToken, password: "longpassword", decision: "allow" } });
const code2 = new URL(res.headers.get("location")).searchParams.get("code");
res = await mcp("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: code2, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier } });
assert.equal(res.status, 200);
let tok = await res.json();
assert.ok(tok.access_token && tok.refresh_token);
res = await mcp("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: code2, client_id: client.client_id, code_verifier: verifier } });
assert.equal(res.status, 400, "a code works only once");
console.log("✓ PKCE token exchange, one-time codes");

// MCP calls
const auth = () => ({ authorization: `Bearer ${tok.access_token}` });
const rpc = async (method, params, id = 1) => {
  const r = await mcp("POST", "/mcp", { body: { jsonrpc: "2.0", id, method, params }, headers: auth() });
  assert.equal(r.status, 200, `${method} -> ${r.status}`);
  return (await r.json()).result;
};
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
assert.equal(init.protocolVersion, "2025-06-18");
assert.equal((await mcp("POST", "/mcp", { body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: auth() })).status, 202);
const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
for (const t of ["list_accounts", "week_plan", "create_post", "update_post", "delete_post", "get_insights", "best_times"]) assert.ok(tools.includes(t), t);
const accs = (await rpc("tools/call", { name: "list_accounts", arguments: {} })).structuredContent.accounts;
assert.equal(accs[0].name, "Lift Line");
const created = await rpc("tools/call", { name: "create_post", arguments: { account_ids: [accs[0].id], type: "text", caption: "Mini Pro lifts 300 kg to the 4th floor.", when: "2030-01-07 19:30" } });
assert.ok(!created.isError, JSON.stringify(created));
const post = created.structuredContent.created;
assert.equal(post.status, "scheduled");
assert.equal(post.when, "2030-01-07 19:30 IST (Mon)");
const moved = await rpc("tools/call", { name: "update_post", arguments: { post_id: post.id, when: "2030-01-08 09:15" } });
assert.equal(moved.structuredContent.updated.when, "2030-01-08 09:15 IST (Tue)");
const bad = await rpc("tools/call", { name: "create_post", arguments: { account_ids: [accs[0].id], type: "text", caption: "x", when: "next tuesday-ish" } });
assert.equal(bad.isError, true);
const planned = await rpc("tools/call", { name: "week_plan", arguments: { date: "2030-01-08" } });
assert.equal(planned.structuredContent.days[1].posts.length, 1);
assert.equal((await rpc("tools/call", { name: "delete_post", arguments: { post_id: post.id } })).structuredContent.deleted, post.id);
console.log("✓ MCP initialize, tools/list, create/move/plan/delete");

// Claude's posts can be set to wait for an OK
await api("PUT", "/api/settings", { claude: { requireApproval: true } });
const held = await rpc("tools/call", { name: "create_post", arguments: { account_ids: [accs[0].id], type: "text", caption: "Held", when: "2030-01-09 10:00" } });
assert.equal(held.structuredContent.created.status, "needs_ok");
console.log("✓ 'needs my OK' switch");

// Refresh keys rotate
res = await mcp("POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id } });
const tok2 = await res.json();
assert.ok(tok2.access_token);
res = await mcp("POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: tok.refresh_token } });
assert.equal(res.status, 400, "old refresh key stops working");
tok = tok2;
console.log("✓ refresh key rotation");

// 2-step login
let r = await api("POST", "/api/security/two-step/start");
const secret = r.data.secret.replace(/\s/g, "");
assert.ok(r.data.qr.startsWith("<svg"));
r = await api("POST", "/api/security/two-step/finish", { code: "000000" });
assert.equal(r.status, 403);
r = await api("POST", "/api/security/two-step/finish", { code: codeAt(secret, currentCounter()) });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.recovery.length, 8);
const recovery = r.data.recovery;
cookie = "";
r = await api("POST", "/api/auth/login", { password: "longpassword" });
assert.equal(r.status, 401);
assert.equal(r.data.code, "totp");
r = await api("POST", "/api/auth/login", { password: "longpassword", code: codeAt(secret, currentCounter()) });
assert.equal(r.status, 403, "the same code can't be used twice");
r = await api("POST", "/api/auth/login", { password: "longpassword", code: recovery[0] });
assert.equal(r.status, 200);
assert.equal(r.data.recoveryLeft, 7);
r = await api("POST", "/api/auth/login", { password: "longpassword", code: recovery[0] });
assert.equal(r.status, 403, "recovery codes work once");
r = await api("GET", "/api/security");
assert.equal(r.data.twoStep, true);
assert.equal(r.data.connections.length, 1);
assert.ok(r.data.events.some((e) => e.kind === "claude"));
// Approval page now asks for the code as well
res = await mcp("GET", "/oauth/authorize?" + q);
assert.ok((await res.text()).includes('name="code"'));
console.log("✓ 2-step login, replay block, recovery codes");

// Cut off Claude
await api("DELETE", `/api/claude/connections/${r.data.connections[0].id}`);
res = await mcp("POST", "/mcp", { body: { jsonrpc: "2.0", id: 9, method: "tools/list" }, headers: auth() });
assert.equal(res.status, 401);
console.log("✓ cutting off Claude works at once");

// Requests from other websites are blocked
r = await api("PUT", "/api/settings", { general: { graphVersion: "v1" } }, { origin: "https://evil.example" });
assert.equal(r.status, 403);
console.log("✓ other-website requests blocked");

console.log("\nClaude connector + security tests passed.");
