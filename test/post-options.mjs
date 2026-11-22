// AI label, Trial Reels, covers and per-account caption endings reach the platforms correctly.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/post-options.mjs

import assert from "node:assert/strict";
import { upsertConnected, updateAccount, getAccount } from "../netlify/lib/accounts.mjs";
import { forAccount, createPost, problems } from "../netlify/lib/posts.mjs";
import { listAccounts } from "../netlify/lib/accounts.mjs";
import * as instagram from "../netlify/lib/platforms/instagram.mjs";

const settings = { general: { graphVersion: "v25.0" } };
const ctx = { publicUrl: (id) => `https://hq.test/m/${id}.jpg`, bytes: async () => Buffer.alloc(10) };

// Capture what goes to Meta.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes("facebook.com")) return realFetch(url, init);
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  sent.push({ url: u, method: init.method || "GET", body });
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("rupload.facebook.com")) return j({ success: true });
  if (u.endsWith("/media") && init.method === "POST") return j({ id: `c${sent.length}`, uri: "https://rupload.facebook.com/ig-api-upload/v25.0/c1" });
  if (u.endsWith("/media_publish")) return j({ id: "m1" });
  if (u.includes("fields=status_code")) return j({ status_code: "FINISHED" });
  if (u.includes("fields=permalink")) return j({ permalink: "https://instagram.com/reel/1" });
  return j({});
};

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "500", name: "Mystery Choices", handle: "@mysterychoices", token: "T" });
await updateAccount("instagram-500", { defaults: { captionEnding: "Follow @mysterychoices for tomorrow's door 🚪\n#mystery #choices", aiLabel: true, trial: "manual" } });
const account = await getAccount("instagram-500");
assert.equal(account.defaults.trial, "manual");

// 1. Account defaults applied at publish time
const base = { accountIds: ["instagram-500"], type: "reel", caption: "Door A or Door B?", captions: {}, media: [{ id: "v1", kind: "video", name: "a.mp4", mime: "video/mp4" }] };
let p = forAccount(base, account);
assert.match(p.captions.instagram, /Door A or Door B\?\n\nFollow @mysterychoices/);
assert.equal(p.aiGenerated, true);
assert.equal(p.trial, "manual");
const again = forAccount({ ...base, caption: p.captions.instagram }, account);
assert.equal((again.captions.instagram || again.caption).match(/Follow @/g).length, 1, "ending is not added twice");
assert.equal(forAccount({ ...base, trial: "off" }, account).trial, "", "a post can switch the trial off");
assert.equal(forAccount({ ...base, type: "post" }, account).trial, "", "photos are never trials");
assert.equal(forAccount({ ...base, type: "short" }, account).trial, "manual", "a Short goes to Instagram as a Reel, so the default covers it");
assert.equal(forAccount({ ...base, type: "carousel", media: [...base.media, { id: "v2", kind: "video", name: "b.mp4" }] }, account).trial, "", "carousels are never trials");
assert.equal(forAccount(base, { ...account, platform: "facebook" }).trial, "", "only Instagram has Trial Reels");
console.log("✓ caption ending, AI label and Trial Reel defaults applied per account (never twice)");

// 2. What Instagram receives for a Reel
await instagram.publish({ settings, account, post: { ...p, cover: { mediaId: "cov1", atSec: 0 }, alsoStory: true }, ctx });
const reel = sent.find((x) => x.method === "POST" && x.url.endsWith("/media") && x.body.media_type === "REELS");
assert.ok(reel, "reel container created");
assert.equal(reel.body.is_ai_generated, "true");
assert.deepEqual(JSON.parse(reel.body.trial_params), { graduation_strategy: "MANUAL" });
assert.equal(reel.body.cover_url, "https://hq.test/m/cov1.jpg");
assert.match(reel.body.caption, /#mystery #choices/);
assert.ok(!sent.some((x) => x.body.media_type === "STORIES"), "a Trial Reel is not copied to the Story");
console.log("✓ Instagram gets is_ai_generated, trial_params, cover_url and the caption ending");

// 3. Frame cover and automatic trial
sent.length = 0;
await instagram.publish({ settings, account, post: { ...p, trial: "auto", cover: { mediaId: "", atSec: 2.5 } }, ctx });
const reel2 = sent.find((x) => x.body.media_type === "REELS");
assert.equal(reel2.body.thumb_offset, "2500");
assert.deepEqual(JSON.parse(reel2.body.trial_params), { graduation_strategy: "SS_PERFORMANCE" });
console.log("✓ frame-at-seconds cover and 'share automatically if it does well' trial");

// 4. Validation: trial only on a single-video Reel
const byId = Object.fromEntries((await listAccounts()).map((a) => [a.id, a]));
assert.ok(problems({ ...base, type: "post", trial: "manual", captions: {}, boardIds: {}, media: [{ id: "i", kind: "image" }] }, byId).some((x) => /Trial Reel/.test(x)));
const created = await createPost({ ...base, trial: "manual", cover: { atSec: 3 }, aiGenerated: true, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
assert.equal(created.trial, "manual");
assert.equal(created.cover.atSec, 3);
console.log("✓ trial and cover are saved on the post; trial refused on a photo");

globalThis.fetch = realFetch;
console.log("\nPost options test passed.");
