// When Instagram's upload server (rupload) refuses a video, Social HQ asks Instagram to fetch it
// by link instead, and otherwise says what Instagram reported about the file.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/ig-upload-fallback.mjs

import assert from "node:assert/strict";
import { upsertConnected, getAccount } from "../netlify/lib/accounts.mjs";
import * as instagram from "../netlify/lib/platforms/instagram.mjs";

const settings = { general: { graphVersion: "v25.0" } };
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "900", name: "Coinwise", handle: "@coinwise", token: "T" });
const account = await getAccount("instagram-900");
const post = { type: "reel", caption: "DEBT", media: [{ id: "v1", kind: "video", name: "a.mp4", mime: "video/mp4" }] };

let sent;
function mockMeta() {
  sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body && typeof init.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    sent.push({ url: u, method: init.method || "GET", body });
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.includes("rupload.facebook.com")) return j({ debug_info: { retriable: false, type: "ProcessingFailedError", message: "Request processing failed" } }, 400);
    if (u.endsWith("/media") && init.method === "POST") return j(body.video_url ? { id: "c2" } : { id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/c1" });
    if (u.includes("/c1?") && u.includes("fields=status_code")) return j({ status_code: "ERROR", status: "Error: Media upload has failed with error code 2207082" });
    if (u.includes("/c2?") && u.includes("fields=status_code")) return j({ status_code: "FINISHED" });
    if (u.endsWith("/media_publish")) return j({ id: "m1" });
    if (u.includes("fields=permalink")) return j({ permalink: "https://instagram.com/reel/1" });
    return j({});
  };
}

// 1. Upload refused -> fetched by link -> published.
mockMeta();
const ctx = { publicUrl: (id) => `https://hq.test/m/${id}.jpg`, bytes: async () => Buffer.alloc(10), videoUrl: async (id) => `https://files.test/tmp/${id}.mp4?token=x` };
const res = await instagram.publish({ settings, account, post, ctx });
assert.equal(res.url, "https://instagram.com/reel/1");
const byLink = sent.find((s) => s.body.video_url);
assert.ok(byLink, "second container asks Instagram to fetch the video by link");
assert.equal(byLink.body.video_url, "https://files.test/tmp/v1.mp4?token=x");
assert.equal(byLink.body.media_type, "REELS");
assert.ok(!("upload_type" in byLink.body), "the by-link container is not a resumable one");
console.log("✓ refused upload goes through by link instead");

// 2. No link available -> the error says what Instagram reported.
mockMeta();
const noLink = { publicUrl: ctx.publicUrl, bytes: ctx.bytes };
await assert.rejects(instagram.publish({ settings, account, post, ctx: noLink }), (e) => {
  assert.match(e.message, /ProcessingFailedError: Request processing failed/);
  assert.match(e.message, /Instagram says: ERROR/);
  assert.match(e.message, /2207082/);
  return true;
});
console.log("✓ without a link, the failure says what Instagram reported");
