// Loads public/app.js in a simulated browser (jsdom) wired to the real API handler,
// then visits every screen and checks for errors. Run: HQ_LOCAL=1 ... node test/ui-smoke.mjs

import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import assert from "node:assert/strict";
import { handle } from "../netlify/functions/api.mjs";
import { upsertConnected, addReminderAccount } from "../netlify/lib/accounts.mjs";
import { collectInsights } from "../netlify/lib/jobs.mjs";
import { createPost } from "../netlify/lib/posts.mjs";

const BASE = "https://hq.test";
let cookie = "";
async function call(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const res = await handle(new Request(new URL(url, BASE), { ...init, headers }), { site: { url: BASE } });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}

// Seed data
await call("/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "123456", password: "longpassword" }) });
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "1", name: "LIFTLINE", handle: "@info.liftline", token: "t" });
await upsertConnected({ platform: "pinterest", kind: "pin_user", remoteId: "infoliftline", name: "infoliftline", handle: "@infoliftline", token: "t", meta: { boards: [{ id: "b1", name: "Forklifts" }], defaultBoardId: "b1" } });
await upsertConnected({ platform: "youtube", kind: "yt_channel", remoteId: "UC1", name: "LIFTLINE Shorts", handle: "YouTube", token: "t" });
const rem = await addReminderAccount({ name: "Pratham (profile)", brand: "Personal" });
const fake = {
  ensureToken: async ({ account }) => ({ account, changed: false }),
  insights: async () => ({ followers: 1200, followersLabel: "Followers", reach7: 900, reach28: 4000, kpis: [{ label: "Reach", value: 4000, period: "28 days" }], posts: [{ id: "x", title: "Reel", type: "Reel", at: new Date().toISOString(), interactions: 40, views: 900 }] }),
};
await collectInsights({ platformsOverride: { instagram: fake, pinterest: { ...fake, refreshBoards: async (a) => a }, youtube: fake } });
const soon = new Date(Date.now() + 3 * 3600000).toISOString();
await createPost({ accountIds: ["instagram-1", rem.id], type: "post", caption: "Hello", media: [{ id: "m1", kind: "image", name: "a.jpg", size: 10, mime: "image/jpeg" }], scheduledAt: soon, approve: true });
await createPost({ accountIds: ["instagram-1"], type: "post", caption: "draft" });

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
vc.on("error", (e) => errors.push(String(e)));
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<script[^>]*app\.js[^>]*><\/script>/, "");
const dom = new JSDOM(html, { url: BASE + "/#/overview", runScripts: "outside-only", virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
w.fetch = async (url, init) => call(url, init);
w.URL.createObjectURL = () => "blob:x";
w.addEventListener("error", (e) => errors.push(e.message));
w.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
w.eval(fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"));

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
async function visit(hash, expect) {
  w.location.hash = hash;
  await wait(600);
  const mainEl = w.document.querySelector("#main");
  const text = mainEl ? mainEl.textContent : w.document.body.textContent;
  assert.ok(text.includes(expect), `${hash}: expected "${expect}" in page, got: ${text.slice(0, 300)}`);
  assert.ok(!/note bad/.test(mainEl?.innerHTML || "") || hash.includes("error"), `${hash}: error note shown: ${mainEl?.querySelector(".note.bad")?.textContent}`);
  console.log("✓", hash);
}

await wait(800);
await visit("#/overview", "Today");
await visit("#/plan", "Weekly plan");
await visit("#/plan?brand=LIFTLINE", "LIFTLINE");
await visit("#/create", "Post to");
// click an account chip, wait for suggestions
w.document.querySelector("#c-accounts [data-acc]").click();
await wait(900);
assert.ok(w.document.querySelector("#c-slots").textContent.includes("/ 100"), "suggestions shown: " + w.document.querySelector("#c-slots").textContent);
console.log("✓ create: account pick shows perfect times");
// choose the pinterest account and check board select appears
const pinChip = [...w.document.querySelectorAll("#c-accounts [data-acc]")].find((b) => b.dataset.acc.startsWith("pinterest"));
pinChip.click();
await wait(300);
assert.ok(w.document.querySelector("[data-board]"), "pinterest board select");
console.log("✓ create: Pinterest board picker");
await visit("#/accounts", "Connect an account");
await visit("#/accounts?error=instagram%3A%20denied", "denied");
await visit("#/insights", "Perfect time to post");
await visit("#/settings", "Redirect address");
await visit("#/settings?missing=youtube", "Add the YouTube keys");

// Edit an existing post
const list = await (await call(`/api/posts?from=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)}&drafts=1`)).json();
await visit(`#/create?id=${list[0].id}`, "Where this post stands");

// Logout -> login screen
w.document.querySelector("#logout").click();
await wait(500);
assert.ok(w.document.body.textContent.includes("Log in"), "login screen after logout");
console.log("✓ logout shows login");

assert.deepEqual(errors, [], "browser errors: " + errors.join(" | "));
console.log("\nUI smoke test passed with no browser errors.");
process.exit(0);
