// Loads public/app.js in a simulated browser (jsdom) wired to the real API handler,
// then visits every screen and checks for errors. Run: HQ_LOCAL=1 ... node test/ui-smoke.mjs

import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import assert from "node:assert/strict";
import { handle } from "../netlify/functions/api.mjs";
import { upsertConnected, addReminderAccount } from "../netlify/lib/accounts.mjs";
import { collectInsights } from "../netlify/lib/jobs.mjs";
import { createPost } from "../netlify/lib/posts.mjs";
import { platforms } from "../netlify/lib/platforms/index.mjs";

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

// Fake live account data for the account page.
platforms.instagram = {
  ...platforms.instagram,
  ensureToken: async ({ account }) => ({ account, changed: false }),
  profile: async () => ({ name: "LIFTLINE", handle: "@info.liftline", avatar: "", bio: "Compact electric lifts", website: "https://liftline.in", link: "https://www.instagram.com/info.liftline/", linkLabel: "Open on Instagram", counts: [{ label: "Posts", value: 31 }, { label: "Followers", value: 1200 }, { label: "Following", value: 40 }] }),
  feed: async ({ after }) => ({ posts: [{ id: after ? "m3" : "m1", type: "Reel", caption: "Lift demo", url: "https://instagram.com/p/1", at: new Date().toISOString(), thumb: "", likes: 12, comments: 3 }, { id: after ? "m4" : "m2", type: "Photo", caption: "Warehouse", url: "https://instagram.com/p/2", at: new Date().toISOString(), thumb: "https://x.test/a.jpg", likes: 5, comments: 0 }], next: after ? null : "CUR" }),
  postDetail: async ({ postId }) => ({ id: postId, type: "Reel", caption: "Lift demo", url: "https://instagram.com/p/1", at: new Date().toISOString(), media: [{ kind: "video", url: "https://x.test/v.mp4", thumb: "" }], stats: [{ label: "Accounts reached", value: 900 }, { label: "Avg. watch time", value: null, text: "7s" }], engagementRate: 0.05, note: "", linkLabel: "Open on Instagram" }),
};
const sent = [];
const fakeComment = (id, text, replied = false) => ({ id, text, username: "buyer_" + id, at: new Date().toISOString(), likes: 1, hidden: false, mine: false, replied, replies: replied ? [{ id: id + "r", text: "Thanks!", username: "info.liftline", at: new Date().toISOString(), likes: 0, hidden: false, mine: true }] : [], media: { id: "m1", type: "Reel", caption: "Lift demo", url: "https://instagram.com/p/1", thumb: "", at: new Date().toISOString() } });
platforms.instagram.recentComments = async () => [fakeComment("c1", "Price?"), fakeComment("c2", "Nice lift", true)];
platforms.instagram.comments = async () => [fakeComment("c1", "Price?")];
platforms.instagram.replyComment = async ({ commentId, message }) => (sent.push([commentId, message]), { id: "new" });
platforms.instagram.hideComment = async () => ({ ok: true });
platforms.instagram.audience = async () => ({ age: [{ label: "25-34", value: 40 }], gender: [{ label: "Men", value: 60 }, { label: "Women", value: 40 }], city: [{ label: "Delhi, Delhi", value: 30 }], country: [{ label: "IN", value: 90 }], online: { grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => (h === 21 ? 50 : 10))), days: 20 }, note: "" });
platforms.youtube = { ...platforms.youtube, ensureToken: async ({ account }) => ({ account, changed: false }), profile: async () => { throw new Error("offline"); }, feed: async () => ({ posts: [], next: null }) };

// Fake Business Discovery for the competitors screen.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const m = /business_discovery\.username\(([^)]+)\)/.exec(u.searchParams.get("fields") || "");
  if (u.host === "graph.facebook.com" && m) return new Response(JSON.stringify({ business_discovery: { username: m[1], name: m[1], followers_count: m[1] === "rival_lifts" ? 900 : 100, media_count: 5, media: { data: [{ id: "a", caption: "Big lift", like_count: 40, comments_count: 2, timestamp: new Date().toISOString(), permalink: "https://ig/p/a", media_type: "IMAGE", media_url: "https://x.test/a.jpg" }] } } }), { status: 200, headers: { "content-type": "application/json" } });
  return nodeFetch(url, init);
};

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
await visit("#/plan?view=month", "Month plan");
{
  const chipEl = w.document.querySelector("#mgrid [data-move]");
  assert.ok(chipEl, "a scheduled post shows in the month");
  const fromDay = chipEl.closest(".mcell").dataset.day;
  const todayKey = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const target = [...w.document.querySelectorAll("#mgrid .mcell")].map((c) => c.dataset.day).find((d) => d > todayKey && d !== fromDay && d > fromDay);
  const cell = w.document.querySelector(`#mgrid .mcell[data-day="${target}"]`);
  const fire = (el, type) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: { setData() {}, effectAllowed: "" } }); el.dispatchEvent(e); };
  fire(chipEl, "dragstart");
  fire(cell, "dragover");
  fire(cell, "drop");
  await wait(700);
  const moved = await (await call(`/api/posts?from=${target}&to=${target}`)).json();
  assert.ok(moved.some((p) => p.caption === "Hello"), "post moved to " + target);
  console.log("✓ month plan: drag a post to another day");
  w.document.querySelector(`#mgrid .mcell[data-day="${target}"]`).click();
  assert.ok(!w.document.querySelector("#mday-list").hidden, "tapping a day lists its posts");
}
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
await visit("#/account?id=instagram-1", "Posts on the account");
await wait(300);
assert.equal(w.document.querySelectorAll("#pgrid .ptile").length, 2, "first page of posts shows");
assert.ok(w.document.querySelector("#main").textContent.includes("Compact electric lifts"));
w.document.querySelector("#more").click();
await wait(500);
assert.equal(w.document.querySelectorAll("#pgrid .ptile").length, 4, "older posts load");
w.document.querySelector("#psort").value = "likes";
w.document.querySelector("#psort").dispatchEvent(new w.Event("change"));
assert.ok(w.document.querySelector("#pgrid .ptile").textContent.includes("12"), "most liked first");
w.document.querySelector("#pgrid .ptile").click();
await wait(500);
assert.ok(w.document.querySelector(".sheet").textContent.includes("Accounts reached"), "post numbers show");
assert.ok(w.document.querySelector(".sheet").textContent.includes("7s"));
w.document.querySelector(".sheet [data-close]").click();
assert.equal(w.document.querySelector(".sheet"), null, "post sheet closes");
console.log("✓ account page: posts grid, load more, post numbers");
await visit("#/account?id=instagram-1&tab=hq", "Planned in Social HQ");
await visit("#/account?id=instagram-1&tab=audience", "When your followers are online");
assert.ok(w.document.querySelector("#main").textContent.includes("Delhi, Delhi"));
assert.ok(w.document.querySelector("#main").textContent.includes("9 PM"));
await visit("#/competitors", "Side by side");
w.document.querySelector('#comp-form input[name="username"]').value = "@Rival_Lifts";
w.document.querySelector("#comp-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await wait(900);
assert.ok(w.location.hash.includes("u=rival_lifts"), "goes to the new competitor");
await wait(900);
assert.ok(w.document.querySelector("#main").textContent.includes("Their best recent posts"));
assert.ok(w.document.querySelector("#main").textContent.includes("rival_lifts"));
console.log("✓ competitors: add, table, detail");
await visit("#/autoreplies?new=1", "New auto-reply");
{
  const f = w.document.querySelector("#rule-form");
  const el = (n) => f.elements.namedItem(n);
  el("rname").value = "DEMO";
  w.document.querySelector('#rule-form input[name="acc"]').checked = true;
  el("keywords").value = "demo, price";
  el("r0").value = "Hi {username}! Details on liftline.in";
  f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(700);
  assert.ok(w.document.querySelector("#main").textContent.includes("Details on liftline.in"), "rule saved and listed");
  assert.ok(w.document.querySelector("#main").textContent.includes("Off"), "new rule stays off unless switched on");
  const tf = w.document.querySelector("#try-form");
  tf.elements.namedItem("text").value = "PRICE please";
  tf.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await wait(400);
  assert.ok(w.document.querySelector("#try-out").textContent.includes("would answer"));
  console.log("✓ auto-replies: create rule, try-it box");
}
await visit("#/inbox", "2 comments");
assert.ok(w.document.querySelector("#cm-list").textContent.includes("1 not replied"));
await visit("#/inbox?show=todo", "1 comment");
w.document.querySelector('#cm-list [data-act="reply"]').click();
const ta = w.document.querySelector("#cm-list .cm-form textarea");
assert.equal(ta.value, "@buyer_c1 ");
ta.value += "It is ₹1.2 lakh";
w.document.querySelector("#cm-list .cm-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
await wait(500);
assert.deepEqual(sent[0], ["c1", "@buyer_c1 It is ₹1.2 lakh"]);
console.log("✓ comments inbox: filter, reply");
await visit("#/account?id=youtube-UC1", "No posts on this account yet");
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
