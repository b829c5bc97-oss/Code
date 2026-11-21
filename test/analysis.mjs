// Analysis engine: hashtags, types, timing, captions, CTA, consistency, tips; IG collector cache.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/analysis.mjs

import assert from "node:assert/strict";
import { analyse, hashtagsOf } from "../netlify/lib/analysis.mjs";
import * as instagram from "../netlify/lib/platforms/instagram.mjs";
import { encrypt } from "../netlify/lib/crypto.mjs";

assert.deepEqual(hashtagsOf("Lift it #Forklift #forklift #liftline_india ok"), ["#forklift", "#liftline_india"]);

const now = Date.parse("2026-11-21T10:00:00Z");
// 12 posts: reels with #forklift do great, photos with #trending do badly. Evening posts better.
const posts = [];
for (let i = 0; i < 12; i++) {
  const reel = i % 2 === 0;
  const at = new Date(now - (i + 3) * 86400000 + (reel ? 4 : -6) * 3600000).toISOString(); // reels 7:30 PM IST, photos 9:30 AM IST
  posts.push({
    id: "p" + i, at, type: reel ? "Reel" : "Photo",
    caption: reel ? `Moving 300 kg in seconds. Comment DEMO for details ${i % 4 === 0 ? "#forklift" : "#liftlife"} #warehouse` : `New photo ${i % 4 === 1 ? "#trending" : "#factory"} #warehouse #a #b #c #d #e #f`,
    reach: reel ? (i % 4 === 0 ? 1500 : 900) : i % 4 === 1 ? 200 : 400, likes: reel ? 40 : 10, comments: reel ? 6 : 1, shares: reel ? 4 : 0, saves: reel ? 5 : 0,
  });
}
const a = analyse(posts, { platform: "instagram", now });
assert.equal(a.metric, "reach");
assert.equal(a.types[0].type, "Reel");
assert.ok(a.hashtags.working.some((t) => t.tag === "#forklift"));
assert.ok(a.hashtags.notWorking.some((t) => t.tag === "#trending"));
assert.ok(a.hashtags.average.some((t) => t.tag === "#warehouse") || a.hashtags.working.some((t) => t.tag === "#warehouse") || a.hashtags.notWorking.some((t) => t.tag === "#warehouse"));
assert.equal(a.cta.with.n, 6);
assert.ok(a.cta.with.comments > a.cta.without.comments);
assert.equal(a.dayparts.find((d) => d.label.startsWith("Night")).n, 6);
assert.equal(a.top[0].type, "Reel");
assert.equal(a.bottom[0].type, "Photo");
assert.equal(a.weeks.length, 8);
const tipText = a.tips.map((t) => t.text).join("\n");
assert.match(tipText, /Reels get about [\d.]+× the accounts reached of photos/);
assert.ok(!a.hashtags.working.some((t) => t.tag === "#liftlife"), "a reels-only tag on weaker reels is not 'working'");
assert.match(tipText, /#forklift/);
assert.match(tipText, /#trending/);
assert.match(tipText, /night \(7 PM–12 AM\) posts do/i);
assert.match(tipText, /more comments/);
console.log("✓ analyse: types, working / not-working hashtags, CTA, timing, best and worst, tips");
console.log(tipText.split("\n").map((t) => "   · " + t).join("\n"));

const yt = analyse([{ id: "v", at: new Date(now - 5 * 86400000).toISOString(), type: "Short", caption: "x", views: 50, likes: 1 }], { platform: "youtube", now });
assert.equal(yt.metric, "views");
assert.equal(yt.enough, false);
console.log("✓ analyse: falls back to views; flags thin data");

// Collector: second run re-reads only recent posts whose numbers are older than 12 hours.
let insightCalls = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.pathname.endsWith("/1784/media")) return j({ data: [
    { id: "new", media_type: "VIDEO", media_product_type: "REELS", caption: "#a", timestamp: new Date(now - 2 * 86400000).toISOString(), like_count: 3, comments_count: 1 },
    { id: "old", media_type: "IMAGE", caption: "#b", timestamp: new Date(now - 60 * 86400000).toISOString(), like_count: 5, comments_count: 0, media_url: "https://x/i.jpg" },
  ] });
  if (u.pathname.endsWith("/insights")) { insightCalls++; return j({ data: [{ name: "reach", values: [{ value: 77 }] }, { name: "saved", values: [{ value: 2 }] }] }); }
  return j({ error: { message: "unexpected" } });
};
const acc = { platform: "instagram", remoteId: "1784", token: encrypt("T") };
const settings = { general: { graphVersion: "v25.0" } };
const first = await instagram.analysisPosts({ settings, account: acc, now });
assert.equal(insightCalls, 2);
assert.equal(first[0].reach, 77);
assert.equal(first[0].saves, 2);
const cache = Object.fromEntries(first.map((p) => [p.id, p]));
await instagram.analysisPosts({ settings, account: acc, cache, now: now + 3600000 });
assert.equal(insightCalls, 2, "nothing re-read within 12 hours");
await instagram.analysisPosts({ settings, account: acc, cache, now: now + 13 * 3600000 });
assert.equal(insightCalls, 3, "only the recent post is refreshed later; old posts stay cached");
console.log("✓ collector: caches per post, refreshes only recent posts");
