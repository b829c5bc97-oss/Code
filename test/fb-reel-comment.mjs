// A Facebook Reel's first comment waits until Facebook has finished processing the video
// (before that Facebook answers "(#12) singular statuses API is deprecated").
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/fb-reel-comment.mjs

import assert from "node:assert/strict";
import { upsertConnected, getAccount } from "../netlify/lib/accounts.mjs";
import * as facebook from "../netlify/lib/platforms/facebook.mjs";

const settings = { general: { graphVersion: "v25.0" } };
await upsertConnected({ platform: "facebook", kind: "page", remoteId: "500", name: "Business Casebook", token: "T" });
const account = await getAccount("facebook-500");
const post = { type: "reel", caption: "Maggi", firstComment: "Sources in bio", media: [{ id: "v1", kind: "video", name: "a.mp4", mime: "video/mp4" }] };
const ctx = { publicUrl: (id) => `https://hq.test/m/${id}.jpg`, bytes: async () => Buffer.alloc(10) };

let statusChecks = 0;
let commented = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = typeof init.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.endsWith("/500/video_reels") && body.upload_phase === "start") return j({ video_id: "777", upload_url: "https://rupload.facebook.com/video-upload/v25.0/777" });
  if (u.includes("rupload.facebook.com")) return j({ success: true });
  if (u.endsWith("/500/video_reels") && body.upload_phase === "finish") return j({ success: true });
  if (u.includes("/777?") && u.includes("fields=status")) {
    statusChecks++;
    return j({ status: statusChecks < 3 ? { video_status: "processing", publishing_phase: { status: "not_started" } } : { video_status: "ready", publishing_phase: { status: "complete" } } });
  }
  if (u.endsWith("/comments") && init.method === "POST") {
    if (statusChecks < 3) return j({ error: { message: "(#12) singular statuses API is deprecated for versions v2.4 and higher", code: 12 } }, 400);
    commented = u;
    return j({ id: "c1" });
  }
  return j({});
};

// Shorter waits for the test.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a);

const res = await facebook.publish({ settings, account, post, ctx });
assert.equal(res.url, "https://www.facebook.com/reel/777");
assert.ok(statusChecks >= 3, "waited for the video to finish processing");
assert.match(commented, /\/777\/comments$/);
assert.ok(!(res.note || "").includes("First comment failed"), res.note);
console.log("✓ Facebook Reel first comment waits for processing, then posts");

globalThis.setTimeout = realSetTimeout;
