// Keyword auto-replies: matching, once per comment, skips own/answered/old comments, DM failure is logged.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/autoreply.mjs

import assert from "node:assert/strict";
import { upsertConnected } from "../netlify/lib/accounts.mjs";
import { createRule, updateRule, runAutoReplies, matchRule, testComment, getLog, listRules } from "../netlify/lib/autoreply.mjs";

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "1784", name: "LIFTLINE", handle: "@info.liftline", token: "T", meta: { username: "info.liftline" } });
const acc = "instagram-1784";
const rules = [{ id: "a", accountIds: [acc], keywords: ["demo", "price"], everyComment: false, replies: ["x"] }, { id: "b", accountIds: [acc], everyComment: true, keywords: [], replies: ["y"] }];
assert.equal(matchRule(rules, acc, "DEMO please!").rule.id, "a");
assert.equal(matchRule(rules, acc, "what's the price?").keyword, "price");
assert.equal(matchRule(rules, acc, "demonstration video").rule.id, "b", "'demo' must be a whole word; falls to every-comment rule");
assert.equal(matchRule(rules.slice(0, 1), acc, "nice"), null);
assert.equal(matchRule(rules.slice(0, 1), "other", "demo"), null);
console.log("✓ matching: whole words, any keyword, every-comment, per account");

const t0 = Date.now();
const iso = (minAgo) => new Date(t0 - minAgo * 60000).toISOString();
let counts = { m1: 3 };
let comments = [
  { id: "c1", text: "DEMO", username: "buyer1", at: iso(1), mine: false, replied: false },
  { id: "c2", text: "price?", username: "buyer2", at: iso(2), mine: false, replied: true },
  { id: "c3", text: "demo pls", username: "info.liftline", at: iso(1), mine: true, replied: false },
];
const sent = [], dms = [];
const fake = {
  instagram: {
    ensureToken: async ({ account }) => ({ account, changed: false }),
    recentMediaCounts: async () => Object.entries(counts).map(([id, n]) => ({ id, comments: n, at: iso(60) })),
    comments: async () => comments,
    replyComment: async ({ commentId, message }) => { sent.push([commentId, message]); return { id: "r" }; },
    privateReply: async () => { throw new Error("(#10) App needs advanced access"); },
  },
};

assert.equal((await runAutoReplies({ platformsOverride: fake })).replied, 0, "no rules on → nothing happens");
await assert.rejects(() => createRule({ accountIds: [acc], keywords: "", replies: ["hi"] }), /keyword/);
const r = await createRule({ name: "DEMO", accountIds: [acc], keywords: "demo, price", replies: ["Hi {username}! Details sent in DM"], dm: "Here you go", on: false });
assert.equal(r.on, false);
assert.equal((await runAutoReplies({ platformsOverride: fake })).replied, 0, "switched off → nothing sent");
// Switch on: only comments from now on count. c1 is 1 minute old, so it is skipped...
await updateRule(r.id, { on: true });
assert.equal((await runAutoReplies({ platformsOverride: fake })).replied, 0, "comments from before switching on are not answered");
// ...a new comment after switching on gets answered, once.
comments = [...comments, { id: "c4", text: "Price kya hai? demo", username: "buyer4", at: new Date(Date.now() + 1000).toISOString(), mine: false, replied: false }];
counts = { m1: 4 };
let res = await runAutoReplies({ platformsOverride: fake, now: Date.now() + 2000 });
assert.equal(res.replied, 1);
assert.deepEqual(sent[0], ["c4", "Hi @buyer4! Details sent in DM"]);
counts = { m1: 5 }; // our own reply raised the count
res = await runAutoReplies({ platformsOverride: fake, now: Date.now() + 3000 });
assert.equal(res.replied, 0, "never answers the same comment twice");
const log = await getLog();
assert.match(log[0].error, /DM not sent/);
assert.equal(log[0].reply, "Hi @buyer4! Details sent in DM");
assert.equal((await listRules())[0].stats.replies, 1);
console.log("✓ engine: off does nothing, only new comments, once per comment, skips own/answered, DM error logged");

// Look back 24h when switching on.
await updateRule(r.id, { on: false });
await updateRule(r.id, { on: true, lookBack24h: true });
counts = { m1: 6 };
res = await runAutoReplies({ platformsOverride: fake, now: Date.now() + 4000 });
assert.equal(res.replied, 1, "c1 (from before) answered when looking back 24h");
assert.equal(sent[1][0], "c1");
const tc = await testComment({ text: "DEMO chahiye" });
assert.equal(tc.match, true);
assert.equal(tc.keyword, "demo");
assert.equal((await testComment({ text: "nice video" })).match, false);
console.log("✓ look back 24h, try-it box");
