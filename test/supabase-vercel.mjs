// Supabase storage backend + Vercel entry, against a fake Supabase.
// Run: SUPABASE_URL=https://fake.supabase.co SUPABASE_SERVICE_KEY=k MASTER_KEY=local-test-master-key-123 SETUP_CODE=123456 CRON_SECRET=cronsecret node test/supabase-vercel.mjs

import assert from "node:assert/strict";

const kv = new Map();
const objects = new Map();
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host !== "fake.supabase.co") return realFetch(url, init);
  assert.equal(init.headers.apikey, "k");
  const j = (o, s = 200) => new Response(s === 204 ? null : o === undefined ? "" : JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push(u.pathname);
  const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
  if (m) {
    const fn = m[1];
    if (fn === "kv_get") return j(kv.has(body.k) ? kv.get(body.k) : null);
    if (fn === "kv_set") { kv.set(body.k, body.v); return j(undefined, 204); }
    if (fn === "kv_set_new") { if (kv.has(body.k)) return j(false); kv.set(body.k, body.v); return j(true); }
    if (fn === "kv_set_many") { for (const it of body.items) kv.set(it.k, it.v); return j(body.items.length); }
    if (fn === "kv_del") { kv.delete(body.k); return j(undefined, 204); }
    if (fn === "kv_list") return j([...kv.keys()].filter((k) => k.startsWith(body.p)).sort());
    if (fn === "kv_get_many") return j(body.ks.filter((k) => kv.has(k)).map((k) => ({ key: k, value: kv.get(k) })));
  }
  if (u.pathname.startsWith("/storage/v1/object/list/media")) {
    const pre = body.prefix ? body.prefix + "/" : "";
    const names = [...objects.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/")).map((k) => ({ id: "x", name: k.slice(pre.length) }));
    return j(names);
  }
  if (u.pathname === "/storage/v1/object/media" && init.method === "DELETE") { for (const p of body.prefixes) objects.delete(p); return j([]); }
  const om = /^\/storage\/v1\/object\/media\/(.+)$/.exec(u.pathname);
  if (om) {
    const key = om[1].split("/").map(decodeURIComponent).join("/");
    if (init.method === "POST") { objects.set(key, Buffer.from(init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body)); return j({ Key: key }); }
    if (!objects.has(key)) return j({ statusCode: "404", error: "not_found" }, 400);
    return new Response(objects.get(key), { status: 200 });
  }
  return j({ message: "unexpected " + u.pathname }, 404);
};

const store = await import("../netlify/lib/store.mjs");
await store.setJSON("a/1", { x: 1 });
await store.setJSON("a/2", { x: 2 });
await store.setJSON("b/1", { y: 1 });
assert.deepEqual(await store.getJSON("a/1"), { x: 1 });
assert.equal(await store.getJSON("nope"), null);
assert.deepEqual(await store.listKeys("a/"), ["a/1", "a/2"]);
assert.deepEqual((await store.getMany(["a/2", "zz", "a/1"])).map((v) => v.x), [2, 1]);
assert.equal((await store.setJSON("lock/1", { t: 1 }, { onlyIfNew: true })).modified, true);
assert.equal((await store.setJSON("lock/1", { t: 2 }, { onlyIfNew: true })).modified, false);
await store.del("a/1");
assert.deepEqual(await store.listKeys("a/"), ["a/2"]);
await store.putChunk("vid1/0", Buffer.from("hello"));
await store.putChunk("vid1/1", Buffer.from("world"));
await store.putChunk("av/instagram-1", Buffer.from("pic"));
assert.equal(Buffer.from(await store.getChunk("vid1/1")).toString(), "world");
assert.equal(await store.getChunk("vid1/9"), null);
assert.deepEqual(await store.listMediaKeys("vid1/"), ["vid1/0", "vid1/1"]);
await store.delMedia("vid1/0");
assert.deepEqual(await store.listMediaKeys("vid1/"), ["vid1/1"]);
console.log("✓ Supabase backend: get/set/list/getMany/only-if-new/delete, media chunks");

const entry = await import("../api/hq.mjs");
const BASE = "https://social-hq-pratham.vercel.app";
let cookie = "";
async function call(path, init = {}) {
  const u = new URL("/api/hq", BASE);
  const [p, q] = path.split("?");
  u.searchParams.set("__p", p);
  if (q) for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const req = new Request(u, { ...init, headers });
  const fn = entry[req.method];
  const res = await fn(req);
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
let r = await call("/api/auth/state");
assert.deepEqual(await r.json(), { setupDone: false, loggedIn: false });
r = await call("/api/auth/setup", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ code: "123456", password: "longpassword" }) });
assert.equal(r.status, 200);
r = await call("/api/accounts");
assert.equal(r.status, 200);
r = await call("/.well-known/oauth-authorization-server");
assert.equal(r.status, 200);
assert.ok((await r.json()).token_endpoint);
r = await call("/internal/cron/autoreply", { method: "POST" });
assert.equal(r.status, 403, "cron needs the secret");
r = await call("/internal/cron/autoreply", { method: "POST", headers: { "x-cron-secret": "cronsecret" } });
assert.equal(r.status, 202);
r = await call("/m/av/instagram-1");
assert.equal(await r.text(), "pic");
console.log("✓ Vercel entry: original paths, API, OAuth discovery, cron secret, saved pictures");
