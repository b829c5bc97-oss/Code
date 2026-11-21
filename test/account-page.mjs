// Account page connectors: Instagram/Facebook/YouTube profile, feed paging and one post's numbers, against fakes.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/account-page.mjs

import assert from "node:assert/strict";
import * as instagram from "../netlify/lib/platforms/instagram.mjs";
import * as facebook from "../netlify/lib/platforms/facebook.mjs";
import * as youtube from "../netlify/lib/platforms/youtube.mjs";
import { encrypt } from "../netlify/lib/crypto.mjs";

const settings = { general: { graphVersion: "v25.0" }, instagram: {}, facebook: {} };
const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const bad = (msg) => j({ error: { message: msg, code: 100, type: "OAuthException" } }, 400);

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.pathname;
  const metric = u.searchParams.get("metric");
  if (p === "/v25.0/1784" && u.searchParams.get("fields").includes("followers_count")) return j({ id: "1784", username: "info.liftline", name: "LIFTLINE", followers_count: 120, follows_count: 9, media_count: 31, biography: "Lifts" });
  if (p === "/v25.0/1784/media") return j({ data: [{ id: "m1", media_type: "VIDEO", media_product_type: "REELS", caption: "Reel one", permalink: "https://ig/p/1", thumbnail_url: "https://cdn/t1.jpg", media_url: "https://cdn/v1.mp4", timestamp: "2026-11-01T10:00:00+0000", like_count: 10, comments_count: 2 }], paging: u.searchParams.get("after") ? {} : { cursors: { after: "CUR" }, next: "https://next" } });
  if (p === "/v25.0/m1") return j({ id: "m1", media_type: "VIDEO", media_product_type: "REELS", caption: "Reel one", permalink: "https://ig/p/1", thumbnail_url: "https://cdn/t1.jpg", media_url: "https://cdn/v1.mp4", timestamp: "2026-11-01T10:00:00+0000", like_count: 10, comments_count: 2 });
  if (p === "/v25.0/m1/insights") {
    if (metric.includes(",")) return bad("metric ig_reels_video_view_total_time not supported");
    if (metric === "ig_reels_video_view_total_time") return bad("not supported");
    const v = { reach: 500, views: 900, likes: 10, comments: 2, shares: 4, saved: 3, total_interactions: 19, ig_reels_avg_watch_time: 7400 }[metric];
    return j({ data: [{ name: metric, values: [{ value: v }] }] });
  }
  if (p === "/v25.0/55" && u.searchParams.get("fields").includes("fan_count")) return j({ name: "Liftline", username: "liftline", fan_count: 40, followers_count: 44, link: "https://facebook.com/liftline", picture: { data: { url: "https://cdn/p.jpg" } } });
  if (p === "/v25.0/55/published_posts") return j({ data: [{ id: "55_1", message: "Hello", created_time: "2026-11-02T10:00:00+0000", permalink_url: "https://fb/1", full_picture: "https://cdn/f.jpg", attachments: { data: [{ media_type: "photo", media: { image: { src: "https://cdn/f.jpg" } } }] }, reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } }] });
  if (p === "/v25.0/55_1") return j({ id: "55_1", message: "Hello", created_time: "2026-11-02T10:00:00+0000", permalink_url: "https://fb/1", full_picture: "https://cdn/f.jpg", attachments: { data: [{ media_type: "photo", media: { image: { src: "https://cdn/f.jpg" } } }] }, reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } });
  if (p === "/v25.0/55_1/insights") return metric === "post_media_view" ? j({ data: [{ name: metric, values: [{ value: 300 }] }] }) : metric === "post_impressions_unique" ? j({ data: [{ name: metric, values: [{ value: 200 }] }] }) : bad("deprecated");
  if (p === "/youtube/v3/channels") return j({ items: [{ id: "UC1", snippet: { title: "LIFTLINE", customUrl: "@liftlinemachines", thumbnails: { default: { url: "https://yt/a.jpg" } } }, statistics: { videoCount: "5", subscriberCount: "13", viewCount: "999" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
  if (p === "/youtube/v3/playlistItems") return j({ items: [{ contentDetails: { videoId: "v1" } }], nextPageToken: "NP" });
  if (p === "/youtube/v3/videos") return j({ items: [{ id: "v1", snippet: { title: "Lift", description: "Demo", publishedAt: "2026-10-01T00:00:00Z", thumbnails: { medium: { url: "https://yt/mqdefault.jpg" } } }, statistics: { viewCount: "100", likeCount: "9", commentCount: "1" }, contentDetails: { duration: "PT45S" }, status: { privacyStatus: "public" } }] });
  if (u.host === "youtubeanalytics.googleapis.com") return j({ rows: [[30, 21, 46.5, 2, 1]] });
  return j({ error: { message: "unexpected " + u.href } }, 404);
};

const ig = { platform: "instagram", remoteId: "1784", token: encrypt("T"), handle: "@info.liftline" };
const prof = await instagram.profile({ settings, account: ig });
assert.deepEqual(prof.counts.map((c) => c.value), [31, 120, 9]);
let f = await instagram.feed({ settings, account: ig });
assert.equal(f.posts[0].type, "Reel");
assert.equal(f.posts[0].thumb, "https://cdn/t1.jpg");
assert.equal(f.next, "CUR");
f = await instagram.feed({ settings, account: ig, after: "CUR" });
assert.equal(f.next, null);
const d = await instagram.postDetail({ settings, account: ig, postId: "m1" });
const byLabel = Object.fromEntries(d.stats.map((s) => [s.label, s.text || s.value]));
assert.equal(byLabel["Accounts reached"], 500);
assert.equal(byLabel["Saves"], 3);
assert.equal(byLabel["Avg. watch time"], "7s");
assert.ok(!("Total watch time" in byLabel), "unsupported metric is skipped, not fatal");
assert.equal(d.media[0].kind, "video");
assert.ok(Math.abs(d.engagementRate - 19 / 500) < 1e-9);
console.log("✓ Instagram: profile, paging, post numbers survive a refused metric");

const fb = { platform: "facebook", remoteId: "55", token: encrypt("P"), handle: "@liftline" };
assert.equal((await facebook.profile({ settings, account: fb })).counts[0].value, 44);
const ff = await facebook.feed({ settings, account: fb });
assert.equal(ff.posts[0].type, "Photo");
const fd = await facebook.postDetail({ settings, account: fb, postId: "55_1" });
const fl = Object.fromEntries(fd.stats.map((s) => [s.label, s.value]));
assert.equal(fl["People reached"], 200);
assert.equal(fl["Views"], 300);
assert.equal(fl["Reactions"], 7);
assert.equal(fl["Shares"], 2);
console.log("✓ Facebook: profile, posts, post numbers with Meta's current metrics");

const yt = { platform: "youtube", remoteId: "UC1", token: encrypt("Y"), meta: { uploads: "UU1" } };
assert.equal((await youtube.profile({ account: yt })).counts[1].value, 13);
const yf = await youtube.feed({ account: yt });
assert.equal(yf.posts[0].type, "Short");
assert.equal(yf.next, "NP");
const yd = await youtube.postDetail({ account: yt, postId: "v1" });
assert.ok(yd.stats.some((s) => s.label === "Avg. % watched" && s.text === "47%"));
console.log("✓ YouTube: channel, videos, video numbers");
console.log("All account-page checks passed.");
