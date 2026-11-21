// Competitor tracking against a fake Business Discovery.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/competitors.mjs

import assert from "node:assert/strict";
import { upsertConnected } from "../netlify/lib/accounts.mjs";
import { addCompetitor, competitorTable, competitorDetail, removeCompetitor, summarise } from "../netlify/lib/competitors.mjs";

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
const media = (n) => Array.from({ length: n }, (_, i) => ({ id: "m" + i, caption: "post " + i, like_count: 10 * (i + 1), comments_count: i, timestamp: iso(i * 3), permalink: "https://ig/p/" + i, media_type: i % 2 ? "IMAGE" : "VIDEO", media_product_type: i % 2 ? "FEED" : "REELS", thumbnail_url: "https://cdn/t.jpg" }));
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const f = u.searchParams.get("fields") || "";
  const m = /business_discovery\.username\(([^)]+)\)/.exec(f);
  const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (!m) return j({ error: { message: "unexpected" } }, 400);
  if (m[1] === "personalguy") return j({ error: { message: "Invalid user id", code: 110 } }, 400);
  const followers = { info_liftline: 105, rival_lifts: 2000 }[m[1].replace(".", "_")] ?? 50;
  return j({ business_discovery: { id: "1", username: m[1], name: m[1].toUpperCase(), followers_count: followers, follows_count: 3, media_count: 40, media: { data: media(14) } } });
};

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "1784", name: "LIFTLINE", handle: "@info.liftline", token: "T", meta: { username: "info.liftline" } });

const s = summarise({ username: "x", followers_count: 1000, media: { data: media(14) } });
assert.equal(s.avgLikes, 65, "average of the last 12 posts' likes");
assert.equal(s.postsPerWeek, 2.5, "10 posts in the last 28 days");
assert.equal(s.types.Reel, 6);
assert.ok(Math.abs(s.engagement - (65 + 5.5) / 1000) < 1e-9);

await assert.rejects(() => addCompetitor("personalguy"), /business or creator/);
const row = await addCompetitor("https://www.instagram.com/Rival_Lifts/");
assert.equal(row.username, "rival_lifts");
await assert.rejects(() => addCompetitor("@rival_lifts"), /already/);
const t = await competitorTable();
assert.deepEqual(t.rows.map((r) => [r.username, r.you]), [["info.liftline", true], ["rival_lifts", false]]);
assert.equal(t.rows[1].followers, 2000);
assert.equal(t.rows[1].best.likes, 140);
const d = await competitorDetail("rival_lifts");
assert.equal(d.media.length, 14);
assert.equal(d.hist.length, 1);
await removeCompetitor("rival_lifts");
assert.equal((await competitorTable()).tracked, 0);
console.log("✓ Competitors: add by name or link, refuse personal accounts, table with you + them, detail, remove");
