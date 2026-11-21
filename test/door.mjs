// Private upload door, Inbox, and downloading files from Google Drive / Dropbox links.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 SETUP_CODE=123456 node test/door.mjs

import assert from "node:assert/strict";
import { handle } from "../netlify/functions/api.mjs";
import { directLink } from "../netlify/lib/door.mjs";
import { callTool } from "../netlify/lib/mcp-tools.mjs";
import { upsertConnected } from "../netlify/lib/accounts.mjs";

const BASE = "https://hq.test";
let cookie = "";
async function call(method, path, body, { raw = false, auth = true } = {}) {
  const init = { method, headers: auth && cookie ? { cookie } : {} };
  if (body !== undefined) {
    if (raw) { init.body = body; init.headers["content-type"] = "application/octet-stream"; }
    else { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  }
  const res = await handle(new Request(BASE + path, init), { site: { url: BASE } });
  const sc = res.headers.get("set-cookie");
  if (sc && auth) cookie = sc.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let r = await call("POST", "/api/auth/setup", { code: "123456", password: "longpassword" });
assert.equal(r.status, 200);

// 1. The door link (owner only) and the open door
r = await call("GET", "/api/door");
assert.equal(r.status, 200);
const key = new URL(r.data.page).hash.split("k=")[1];
assert.ok(key && key.length >= 30);
assert.equal((await call("GET", "/api/door", undefined, { auth: false })).status, 401, "the link itself needs login to see");
assert.equal((await call("GET", `/api/door/${key}`, undefined, { auth: false })).status, 200);
assert.equal((await call("GET", `/api/door/wrongkeywrongkeywrongkeywrongkey12`, undefined, { auth: false })).status, 403);
console.log("✓ secret door link: works without login, wrong key refused, only the owner sees the link");

// 2. Send a 7 MB video in pieces, no login
const size = 7 * 1024 * 1024;
r = await call("POST", `/api/door/${key}/start`, { name: "night12.mp4", size, mime: "video/mp4" }, { auth: false });
assert.equal(r.status, 200);
const { id, chunks, chunkSize } = r.data;
assert.equal(chunks, 3);
for (let i = 0; i < chunks; i++) {
  const part = Buffer.alloc(Math.min(chunkSize, size - i * chunkSize), i + 1);
  assert.equal((await call("PUT", `/api/door/${key}/part/${id}/${i}`, part, { raw: true, auth: false })).status, 200);
}
r = await call("POST", `/api/door/${key}/finish/${id}`, { caption: "Door A or Door B?" }, { auth: false });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.file.kind, "video");
r = await call("GET", "/api/inbox-files");
assert.equal(r.data.files.length, 1);
assert.equal(r.data.files[0].caption, "Door A or Door B?");
console.log("✓ a 7 MB video sent through the door lands in the Inbox with its caption");

// 3. Links: Drive and Dropbox turned into direct downloads
assert.equal(directLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing").url, "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp&export=download&confirm=t");
assert.match(directLink("https://www.dropbox.com/s/xyz/reel.mp4?dl=0").url, /dl=1/);
assert.throws(() => directLink("http://example.com/a.mp4"), /https/);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://drive.usercontent.google.com/")) return new Response(Buffer.alloc(4 * 1024 * 1024, 9), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(4 * 1024 * 1024), "content-disposition": 'attachment; filename="liftline-oneton.mp4"' } });
  if (u.startsWith("https://private.example/")) return new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  return realFetch(url);
};
r = await call("POST", `/api/door/${key}/link`, { url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", caption: "OneTon demo" }, { auth: false });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.file.name, "liftline-oneton.mp4");
assert.equal(r.data.file.kind, "video");
assert.equal(r.data.file.size, 4 * 1024 * 1024);
r = await call("POST", `/api/door/${key}/link`, { url: "https://private.example/x" }, { auth: false });
assert.equal(r.status, 400);
assert.match(r.data.error, /web page/);
console.log("✓ Google Drive link downloaded into the Inbox (name from Drive, 2 pieces); a sign-in page is refused clearly");

// 4. Claude tools: inbox_files and using a file in a post (it then leaves the Inbox)
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "321", name: "Mystery Choices", handle: "@mysterychoices", token: "T" });
const inbox = await callTool("inbox_files", {});
assert.equal(inbox.files.length, 2);
const vid = inbox.files.find((f) => f.name === "night12.mp4");
const made = await callTool("create_post", { account_ids: ["instagram-321"], type: "reel", caption: "Door A or Door B?", media_ids: [vid.media_id], ai_label: true, trial: "manual" });
assert.ok(made.created || made.post || made.id, JSON.stringify(made));
const after = await callTool("inbox_files", {});
assert.equal(after.files.length, 1, "the used file left the Inbox");
const imp = await callTool("import_link", { url: "https://drive.google.com/file/d/1ZZZZZZZZZZZZZZ/view" });
assert.ok(imp.media_id);
globalThis.fetch = realFetch;
console.log("✓ Claude can list the Inbox, schedule from it (file leaves the Inbox) and import Drive links");

// 5. New link: the old one stops working
r = await call("POST", "/api/door/rotate");
assert.equal(r.status, 200);
assert.equal((await call("GET", `/api/door/${key}`, undefined, { auth: false })).status, 403);
console.log("✓ making a new link switches the old one off");

console.log("\nDoor test passed.");
