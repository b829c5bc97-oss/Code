// A Trial Reel that Instagram refuses (small account) goes out as a normal Reel at once,
// and Trial Reels switch off for that account so the next post doesn't hit the same wall.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/trial-fallback.mjs

import assert from "node:assert/strict";
import { upsertConnected, updateAccount, getAccount } from "../netlify/lib/accounts.mjs";
import { createPost, getPost } from "../netlify/lib/posts.mjs";
import { publishPost, TRIAL_REFUSED_NOTE } from "../netlify/lib/jobs.mjs";

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "700", name: "Coinwise", handle: "@coinwise", token: "T" });
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "701", name: "Big", handle: "@big", token: "T" });
await updateAccount("instagram-700", { defaults: { trial: "auto" } });
await updateAccount("instagram-701", { defaults: { trial: "auto" } });

const calls = [];
const fake = {
  ensureToken: async ({ account }) => ({ account, changed: false }),
  publish: async ({ account, post }) => {
    calls.push({ acc: account.id, trial: post.trial });
    if (post.trial && account.id === "instagram-700") throw new Error("The Instagram account does not meet the trial reel follower requirement to create trial reels.");
    return { remoteId: "r1", url: "https://instagram.com/reel/1" };
  },
};
const media = [{ id: "v1", kind: "video", name: "a.mp4", mime: "video/mp4" }];

// 1. Small account: refused as a trial, posted as a normal Reel in the same run.
let p = await createPost({ accountIds: ["instagram-700"], type: "reel", caption: "DEBT", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
await publishPost(p.id, "https://hq.test", { platformsOverride: { instagram: fake } });
p = await getPost(p.id);
assert.equal(p.targets["instagram-700"].status, "posted");
assert.ok(p.targets["instagram-700"].note.includes(TRIAL_REFUSED_NOTE));
assert.deepEqual(calls.map((c) => c.trial), ["auto", ""]);
assert.equal((await getAccount("instagram-700")).defaults.trial, "", "trials switched off for the small account");
console.log("✓ refused Trial Reel goes out as a normal Reel straight away; trials off for that account");

// 2. Next post on that account: no trial attempt at all.
calls.length = 0;
p = await createPost({ accountIds: ["instagram-700"], type: "reel", caption: "SAVE", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
await publishPost(p.id, "https://hq.test", { platformsOverride: { instagram: fake } });
assert.deepEqual(calls.map((c) => c.trial), [""]);
console.log("✓ the next Reel on that account is a normal Reel first time");

// 3. A big account keeps its Trial Reels.
calls.length = 0;
p = await createPost({ accountIds: ["instagram-701"], type: "reel", caption: "Big", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
await publishPost(p.id, "https://hq.test", { platformsOverride: { instagram: fake } });
p = await getPost(p.id);
assert.equal(p.targets["instagram-701"].status, "posted");
assert.deepEqual(calls.map((c) => c.trial), ["auto"]);
assert.equal((await getAccount("instagram-701")).defaults.trial, "auto");
console.log("✓ accounts that can make Trial Reels keep them");

// 4. Other errors are not swallowed by the fallback.
const broken = { ...fake, publish: async () => { throw new Error("Invalid OAuth access token"); } };
p = await createPost({ accountIds: ["instagram-701"], type: "reel", caption: "x", media, scheduledAt: new Date(Date.now() - 60000).toISOString() });
await publishPost(p.id, "https://hq.test", { platformsOverride: { instagram: broken } });
p = await getPost(p.id);
assert.notEqual(p.targets["instagram-701"].status, "posted");
console.log("✓ other errors still go through the normal failure path");
