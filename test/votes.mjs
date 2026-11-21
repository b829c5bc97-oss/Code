// Vote counter for Mystery Choices style posts.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/votes.mjs

import assert from "node:assert/strict";
import { readVote, tally, countVotes, savedVotes } from "../netlify/lib/votes.mjs";
import { upsertConnected } from "../netlify/lib/accounts.mjs";

const yes = { "A": "A", "a!!": "A", "Door B": "B", "option a 🔥": "A", "I pick B": "B", "B wala": "B", "🅰️": "A", "b.": "B", "2": "B", "Door A for sure": "A", "A for sure bro": "A", "darwaza B": "B" };
for (const [t, want] of Object.entries(yes)) assert.equal(readVote(t), want, t);
for (const t of ["Amazing video", "What a twist", "A or B?", "both", "Abhi dekha", "took 2 min", "nice"]) assert.equal(readVote(t), null, t);
console.log("✓ reads votes like 'Door B', 'a!!', '🅰️', 'B wala' — and ignores 'What a twist', 'A or B?'");

const t = tally([
  { username: "x", text: "A", timestamp: "2026-11-21T10:00:00Z" },
  { username: "x", text: "no wait B", timestamp: "2026-11-21T10:05:00Z" },
  { username: "y", text: "door a", timestamp: "2026-11-21T10:06:00Z" },
  { username: "z", text: "B!!", timestamp: "2026-11-21T10:07:00Z" },
  { username: "w", text: "fire video", timestamp: "2026-11-21T10:08:00Z" },
  { username: "me", text: "B", timestamp: "2026-11-21T10:09:00Z" },
], { own: "me" });
assert.deepEqual(t.counts, { A: 1, B: 2 });
assert.equal(t.winner, "B");
assert.equal(t.voters, 3);
assert.equal(t.ignored, 1);
console.log("✓ one vote per person (latest counts), own comments skipped, winner picked");

// All pages of comments are read
await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "900", name: "Mystery Choices", handle: "@mysterychoices", token: "T", meta: { username: "mysterychoices" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("page2")) return j({ data: Array.from({ length: 30 }, (_, i) => ({ id: `p2${i}`, username: `u2_${i}`, text: i % 3 ? "A" : "B", timestamp: "2026-11-21T11:00:00Z" })) });
  if (u.includes("/comments")) return j({ data: Array.from({ length: 50 }, (_, i) => ({ id: `p1${i}`, username: `u1_${i}`, text: i < 30 ? "Door A" : "B", timestamp: "2026-11-21T10:00:00Z" })), paging: { next: "https://graph.facebook.com/v25.0/m1/comments?page2=1" } });
  return realFetch(url);
};
const r = await countVotes("instagram-900", "m1");
globalThis.fetch = realFetch;
assert.equal(r.comments, 80);
assert.equal(r.voters, 80);
assert.equal(r.counts.A, 30 + 20);
assert.equal(r.counts.B, 20 + 10);
assert.equal(r.winner, "A");
assert.equal((await savedVotes("instagram-900", "m1")).winner, "A");
console.log("✓ reads every page of comments (80 here) and saves the result");

console.log("\nVotes test passed.");
