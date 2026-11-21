// Local end-to-end test with an in-memory store and fake platforms.
// Run: npm test

import assert from "node:assert/strict";
import { handle } from "../netlify/functions/api.mjs";
import { upsertConnected, listAccounts } from "../netlify/lib/accounts.mjs";
import { duePosts, claim, getPost } from "../netlify/lib/posts.mjs";
import { publishPost, collectInsights } from "../netlify/lib/jobs.mjs";
import { littleText } from "../netlify/lib/platforms/linkedin.mjs";

const BASE = "https://hq.test";
let cookie = "";
const triggered = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(BASE + "/internal/")) {
    triggered.push(String(url));
    return new Response(null, { status: 202 });
  }
  return realFetch(url, init);
};

async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { cookie, ...headers } };
  if (body !== undefined) {
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await handle(new Request(BASE + path, init), { site: { url: BASE } });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const fakeCalls = [];
const fake = {
  ensureToken: async ({ account }) => ({ account, changed: false }),
  publish: async ({ account, post, ctx }) => {
    const sizes = [];
    for (const m of post.media) sizes.push((await ctx.bytes(m.id)).length);
    fakeCalls.push({ account: account.id, type: post.type, sizes, url: post.media[0] ? ctx.publicUrl(post.media[0].id) : null });
    if (account.name === "Broken") throw Object.assign(new Error("Token expired"), { authProblem: true });
    return { remoteId: "r1", url: "https://example.com/p/1" };
  },
  insights: async () => ({
    followers: 1240,
    followersLabel: "Followers",
    reach7: 9800,
    reach28: 31200,
    views28: 58400,
    interactions28: 1500,
    engagementRate: 0.048,
    kpis: [{ label: "Accounts reached", value: 31200, period: "28 days" }],
    posts: [
      { id: "a", title: "Mini Pro", type: "Reel", at: "2026-11-18T14:00:00Z", interactions: 300, views: 12000, reach: 9000 },
      { id: "b", title: "OneTon", type: "Reel", at: "2026-11-16T14:30:00Z", interactions: 200, views: 9000, reach: 7000 },
      { id: "c", title: "Lunch post", type: "Post", at: "2026-11-15T07:00:00Z", interactions: 50, views: 1000, reach: 900 },
    ],
  }),
};
const fakePlatforms = { instagram: fake, facebook: fake, linkedin: fake, youtube: fake, pinterest: fake };

// 1. First visit
let r = await api("GET", "/api/auth/state");
assert.deepEqual(r.data, { setupDone: false, loggedIn: false });
r = await api("GET", "/api/overview");
assert.equal(r.status, 401);
r = await api("POST", "/api/auth/setup", { code: "000000", password: "longpassword" });
assert.equal(r.status, 403);
r = await api("POST", "/api/auth/setup", { code: "123456", password: "longpassword" });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await api("GET", "/api/auth/state");
assert.equal(r.data.loggedIn, true);
console.log("✓ setup + login");

// 2. Wrong password, logout, login
const saved = cookie;
cookie = "";
r = await api("POST", "/api/auth/login", { password: "nope" });
assert.equal(r.status, 403);
r = await api("POST", "/api/auth/login", { password: "longpassword" });
assert.equal(r.status, 200);
assert.ok(cookie && cookie !== saved);
console.log("✓ password login");

// 3. Settings
r = await api("PUT", "/api/settings", { instagram: { appId: "123", appSecret: "shh" }, pinterest: { sandbox: true } });
assert.equal(r.data.instagram.appId, "123");
assert.equal(r.data.instagram.appSecretSet, true);
assert.equal(r.data.instagram.appSecret, undefined);
assert.ok(r.data.redirects.instagram.endsWith("/api/oauth/instagram/callback"));
r = await api("GET", "/api/oauth/instagram/start", undefined, { raw: true });
assert.equal(r.status, 302);
assert.ok(r.headers.get("location").startsWith("https://www.instagram.com/oauth/authorize?"));
r = await api("GET", "/api/oauth/youtube/start", undefined, { raw: true });
assert.ok(r.headers.get("location").includes("#/settings?missing=youtube"));
r = await api("GET", "/api/oauth/instagram/callback?code=x&state=bad", undefined, { raw: true });
assert.ok(r.headers.get("location").includes("error="));
console.log("✓ settings + oauth start/guard");

// 4. Accounts
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "1784", name: "LIFTLINE", handle: "@info.liftline", token: "SECRETTOKENXYZ", tokenExpiresAt: new Date(Date.now() + 50 * 86400000).toISOString() });
await upsertConnected({ platform: "facebook", kind: "fb_page", remoteId: "999", name: "Broken", handle: "Page", token: "SECRETTOKENXYZ" });
r = await api("POST", "/api/accounts/reminder", { name: "Pratham Bansal (profile)", brand: "Personal" });
assert.equal(r.data.platform, "manual");
const manualId = r.data.id;
r = await api("GET", "/api/accounts");
assert.equal(r.data.accounts.length, 3);
assert.equal(r.data.accounts.find((a) => a.platform === "instagram").brand, "LIFTLINE");
assert.equal(JSON.stringify(r.data).includes("SECRETTOKENXYZ"), false, "tokens must never reach the browser");
r = await api("PATCH", "/api/accounts/instagram-1784", { cadence: 4 });
assert.equal(r.data.cadence, 4);
console.log("✓ accounts");

// 5. Media upload in pieces
const img = Buffer.alloc(5000, 7);
r = await api("POST", "/api/media", { name: "photo.jpg", size: img.length, mime: "image/jpeg" });
const mediaId = r.data.id;
assert.equal(r.data.chunks, 1);
r = await api("PUT", `/api/media/${mediaId}/part/0`, img, { headers: { "content-type": "application/octet-stream" } });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await api("POST", `/api/media/${mediaId}/complete`);
assert.equal(r.data.kind, "image");
const pub = await api("GET", `/m/${mediaId}.jpg`, undefined, { raw: true });
assert.equal(pub.status, 200);
assert.equal(Buffer.from(await pub.arrayBuffer()).length, 5000);
console.log("✓ media upload + public photo link");

// 6. Validation
r = await api("POST", "/api/posts", { accountIds: ["instagram-1784"], type: "post", caption: "no photo", scheduledAt: new Date(Date.now() + 3600000).toISOString() });
assert.equal(r.status, 400);
assert.match(r.data.error, /Instagram needs a photo/);
console.log("✓ validation");

// 7. Create a post due now for 3 accounts
const media = [{ id: mediaId, kind: "image", name: "photo.jpg", size: 5000, mime: "image/jpeg" }];
r = await api("POST", "/api/posts", { accountIds: ["instagram-1784", "facebook-999", manualId], type: "post", caption: "Hello #liftline", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
assert.equal(r.status, 200, JSON.stringify(r.data));
const postId = r.data.id;
assert.equal(r.data.status, "scheduled");
let due = await duePosts();
assert.equal(due.length, 1);
assert.equal(await claim(postId), true);
assert.equal(await claim(postId), false, "a post can only be claimed once");
let post = await publishPost(postId, BASE, { platformsOverride: fakePlatforms });
assert.equal(post.targets["instagram-1784"].status, "posted");
assert.equal(post.targets["facebook-999"].status, "failed");
assert.equal(post.targets[manualId].status, "reminder");
assert.equal(post.status, "partial");
assert.equal(fakeCalls[0].sizes[0], 5000);
assert.equal(fakeCalls[0].url, `${BASE}/m/${mediaId}.jpg`);
due = await duePosts();
assert.equal(due.length, 0);
r = await api("GET", "/api/accounts");
assert.equal(r.data.accounts.find((a) => a.name === "Broken").status, "error");
console.log("✓ publish: posted / failed / reminder");

// 8. Reminder done + overview
r = await api("POST", `/api/posts/${postId}/done/${manualId}`);
assert.equal(r.data.targets[manualId].status, "posted");
r = await api("GET", "/api/overview");
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.kpis.accounts, 3);
assert.ok(r.data.attention.some((a) => a.kind === "failed"));
assert.ok(r.data.attention.some((a) => a.kind === "login"));
console.log("✓ overview");

// 9. Needs approval
const later = new Date(Date.now() + 2 * 86400000).toISOString();
r = await api("POST", "/api/posts", { accountIds: ["instagram-1784"], type: "post", caption: "approve me", media, scheduledAt: later, needsApproval: true });
assert.equal(r.data.status, "needs_ok");
const okId = r.data.id;
r = await api("POST", `/api/posts/${okId}/approve`);
assert.equal(r.data.status, "scheduled");
r = await api("PUT", `/api/posts/${okId}`, { scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString() });
assert.equal(r.status, 200, JSON.stringify(r.data));
r = await api("GET", `/api/posts/${okId}`);
assert.equal(r.data.caption, "approve me");
console.log("✓ approval + reschedule (moves storage key)");

// 10. Draft
r = await api("POST", "/api/posts", { accountIds: ["instagram-1784"], type: "post", caption: "draft" });
assert.equal(r.data.status, "draft");
console.log("✓ drafts");

// 11. Insights + best time + plan + suggestions
await collectInsights({ platformsOverride: fakePlatforms });
r = await api("GET", "/api/insights");
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.accounts.find((a) => a.id === "instagram-1784").followers, 1240);
r = await api("GET", "/api/insights/instagram-1784");
assert.equal(r.data.model.scores.length, 7);
assert.equal(r.data.model.scores[0].length, 18);
assert.equal(r.data.top.length, 3);
r = await api("GET", "/api/plan?from=" + new Date().toISOString().slice(0, 10));
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.days.length, 7);
r = await api("POST", "/api/suggest", { accountIds: ["instagram-1784"] });
assert.equal(r.data.length, 3);
for (const s of r.data) assert.ok(new Date(s.at) > new Date());
console.log("✓ insights, perfect-time model, plan, suggestions");

// 12. LinkedIn text format
assert.equal(littleText("Hi (team) #liftline @you"), "Hi \\(team\\) {hashtag|\\#|liftline} \\@you");
console.log("✓ LinkedIn text escaping");

// 13. Retry after fixing the broken account
r = await api("POST", `/api/posts/${postId}/retry`);
assert.equal(r.status, 200, JSON.stringify(r.data));
post = await getPost(postId);
assert.equal(post.targets["facebook-999"].status, "pending");
assert.ok(triggered.some((u) => u.endsWith("/internal/publish")));
console.log("✓ retry (publisher started)");

// 13b. Scheduler skips a claimed post; stale "publishing" posts are recovered
const { runScheduler } = await import("../netlify/lib/jobs.mjs");
let fired = await runScheduler(BASE);
assert.equal(fired.length, 0, "already claimed by retry");
post = await getPost(postId);
post.status = "publishing";
post.publishStartedAt = new Date(Date.now() - 30 * 60000).toISOString();
const { savePost } = await import("../netlify/lib/posts.mjs");
await savePost(post);
await runScheduler(BASE);
post = await getPost(postId);
assert.equal(post.targets["facebook-999"].status, "failed");
assert.match(post.targets["facebook-999"].error, /Timed out/);
console.log("✓ scheduler claim + stale recovery");

// 14. Logout
r = await api("POST", "/api/auth/logout");
r = await api("GET", "/api/accounts");
assert.equal(r.status, 401);
console.log("✓ logout");

console.log("\nAll local tests passed. Accounts:", (await listAccounts()).length);
