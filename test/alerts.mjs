// Failure alerts, automatic retry and the daily login check.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/alerts.mjs

import assert from "node:assert/strict";
import { upsertConnected, getAccount, listAccounts } from "../netlify/lib/accounts.mjs";
import { createPost, getPost, duePosts, claim } from "../netlify/lib/posts.mjs";
import { publishPost } from "../netlify/lib/jobs.mjs";
import { updateSettings } from "../netlify/lib/settings.mjs";
import { explain, alertLog } from "../netlify/lib/alerts.mjs";
import { checkLogins } from "../netlify/lib/logincheck.mjs";
import { PlatformError } from "../netlify/lib/platforms/common.mjs";

const BASE = "https://hq.test";

// Outgoing alert calls are captured instead of sent.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.callmebot.com/") || u.startsWith("https://ntfy.sh/") || u.startsWith("https://api.resend.com/")) {
    sent.push({ url: u, body: init.body ? String(init.body) : "", headers: init.headers || {} });
    return new Response(u.includes("resend") ? '{"id":"1"}' : "Message queued", { status: 200 });
  }
  return realFetch(url, init);
};

// 1. Plain-language reasons
assert.equal(explain(new PlatformError("Error validating access token: Session has expired", { data: { error: { code: 190 } } }), "instagram").kind, "login");
assert.equal(explain(new PlatformError("The aspect ratio is not supported.", { data: { error: { code: 36003, type: "OAuthException" } }, authProblem: true }), "instagram").kind, "shape", "a file problem must not be read as a login problem");
assert.equal(explain(new PlatformError("Could not reach the platform: fetch failed"), "facebook").retry, true);
assert.equal(explain(new PlatformError("The video duration is longer than allowed"), "instagram").kind, "length");
assert.equal(explain(new PlatformError("quotaExceeded: The request cannot be completed because you have exceeded your quota."), "youtube").kind, "limit");
console.log("✓ errors explained in plain words; file problems aren't mistaken for logins");

await updateSettings({ alerts: { whatsappPhone: "+91 88008 35120", callmebotKey: "cmb-key", ntfyTopic: "socialhq-test" } });

// 2. One automatic retry, then success
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "11", name: "Flaky", handle: "@flaky", token: "T1" });
let calls = 0;
const flaky = {
  async ensureToken({ account }) { return { account, changed: false }; },
  async publish() {
    calls++;
    if (calls === 1) throw new PlatformError("Could not reach the platform: fetch failed");
    return { remoteId: "m1", url: "https://instagram.com/p/1" };
  },
};
const media = [{ id: "x1", kind: "image", name: "a.jpg", size: 10, mime: "image/jpeg" }];
let p = await createPost({ accountIds: ["instagram-11"], type: "post", caption: "Retry me", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
assert.equal(await claim(p.id), true);
p = await publishPost(p.id, BASE, { platformsOverride: { instagram: flaky } });
assert.equal(p.status, "scheduled", "waits for its retry");
assert.equal(p.targets["instagram-11"].status, "pending");
assert.ok(p.targets["instagram-11"].retryAt);
assert.equal((await duePosts()).filter((x) => x.id === p.id).length, 0, "not due again straight away");
const later = new Date(Date.now() + 11 * 60000);
assert.equal((await duePosts(later)).filter((x) => x.id === p.id).length, 1, "due again 10 minutes later");
assert.equal(await claim(p.id), true, "the lock was released for the retry");
p = await publishPost(p.id, BASE, { platformsOverride: { instagram: flaky } });
assert.equal(p.status, "done");
assert.equal(p.targets["instagram-11"].status, "posted");
assert.equal(sent.length, 0, "a retry that works sends no alert");
console.log("✓ a failed post is retried once, 10 minutes later, and goes out");

// 3. Fails twice -> failed, with reason, fix, and one alert on each channel
const broken = {
  async ensureToken({ account }) { return { account, changed: false }; },
  async publish() { throw new PlatformError("Service temporarily unavailable (HTTP 503)"); },
};
p = await createPost({ accountIds: ["instagram-11"], type: "reel", caption: "OneTon demo", media: [{ ...media[0], kind: "video", name: "a.mp4", mime: "video/mp4" }], scheduledAt: new Date(Date.now() - 60000).toISOString() });
await claim(p.id);
p = await publishPost(p.id, BASE, { platformsOverride: { instagram: broken } });
assert.equal(p.status, "scheduled");
await claim(p.id);
p = await publishPost(p.id, BASE, { platformsOverride: { instagram: broken } });
assert.equal(p.status, "failed");
const t = p.targets["instagram-11"];
assert.match(t.reason, /didn't answer/);
assert.ok(t.fix);
const wa = sent.find((x) => x.url.startsWith("https://api.callmebot.com/"));
assert.ok(wa, "WhatsApp alert sent");
assert.match(decodeURIComponent(wa.url), /Flaky post failed/);
assert.match(decodeURIComponent(wa.url), /phone=\+918800835120/);
assert.ok(sent.find((x) => x.url === "https://ntfy.sh/socialhq-test"), "phone notification sent");
const log = await alertLog();
assert.ok(log.find((a) => /post failed/.test(a.title) && a.sent.includes("WhatsApp")));
console.log("✓ fails again -> marked failed with reason and fix; alert by WhatsApp and phone; kept in the list");

// 4. Not retried when a retry can't help (login ended) -> account flagged
const expired = {
  async ensureToken({ account }) { return { account, changed: false }; },
  async publish() { throw new PlatformError("Error validating access token: Session has expired on Friday", { data: { error: { code: 190 } }, authProblem: true }); },
};
const before = sent.length;
p = await createPost({ accountIds: ["instagram-11"], type: "post", caption: "x", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
await claim(p.id);
p = await publishPost(p.id, BASE, { platformsOverride: { instagram: expired } });
assert.equal(p.status, "failed", "no retry for an expired login");
assert.equal((await getAccount("instagram-11")).status, "error");
assert.ok(sent.length > before);
console.log("✓ expired login: no pointless retry, account flagged, alert sent at once");

// 5. Daily login check: Meta login ending in 3 days, and one that stopped working
await updateSettings({ instagram: { appId: "app", appSecret: "sec" } });
await upsertConnected({ platform: "facebook", kind: "fb_page", remoteId: "77", name: "Liftline Page", handle: "Page", token: "PT" });
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "78", name: "Dead IG", handle: "@dead", token: "DT" });
const inThree = Math.floor((Date.now() + 3 * 86400000) / 1000);
const fetchCall = async (url) => {
  if (url.includes("input_token=PT")) return { data: { data: { is_valid: true, expires_at: 0, data_access_expires_at: inThree } } };
  if (url.includes("input_token=DT")) return { data: { data: { is_valid: false, error: { message: "The session was invalidated because the user changed their password." } } } };
  return { data: { data: { is_valid: true, expires_at: 0, data_access_expires_at: Math.floor((Date.now() + 60 * 86400000) / 1000) } } };
};
const n0 = sent.length;
const r = await checkLogins({ siteUrl: BASE, fetchCall });
const page = r.accounts.find((a) => a.name === "Liftline Page");
assert.equal(page.daysLeft, 3);
const msgs = sent.slice(n0).map((x) => decodeURIComponent(x.url) + x.body);
assert.ok(msgs.some((m) => /Liftline Page: login ends in 3 days/.test(m)), "warned 3 days before");
assert.ok(msgs.some((m) => /Dead IG: login stopped working/.test(m)), "warned the day it broke");
assert.equal((await getAccount("instagram-78")).status, "error");
const pub = (await listAccounts()).find((a) => a.id === "facebook-77");
assert.ok(pub.loginEndsAt);
const n1 = sent.length;
await checkLogins({ siteUrl: BASE, fetchCall });
assert.equal(sent.length, n1, "the same warning is not sent twice");
console.log("✓ login check warns days ahead and when a login breaks, once each");

globalThis.fetch = realFetch;
console.log("\nAlerts test passed.");
