// Phone notifications through the Social HQ app (Web Push).
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/push.mjs
import assert from "node:assert/strict";
import { vapidKeys, addSubscription, listSubscriptions, pushAll, _setPushSender } from "../netlify/lib/push.mjs";
import { sendAlert } from "../netlify/lib/alerts.mjs";

const k = await vapidKeys();
assert.equal(k.publicKey, (await vapidKeys()).publicKey, "keys are made once and kept");
const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/abc${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
await addSubscription(sub(1), "iPhone (app)");
await addSubscription(sub(2), "Mac (Chrome)");
await addSubscription(sub(1), "iPhone (app)"); // same phone again: no duplicate
assert.equal((await listSubscriptions()).length, 2);
await assert.rejects(() => addSubscription({ endpoint: "http://x" }), /proper/);

const sent = [];
_setPushSender(async (s, payload, opts) => {
  if (s.endpoint.endsWith("abc2")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
  sent.push({ s, payload: JSON.parse(payload), opts });
});
const r = await pushAll({ title: "LIFTLINE post failed", body: "Login expired", url: "/#/accounts" });
assert.equal(r.sent, 1);
assert.equal(sent[0].payload.title, "LIFTLINE post failed");
assert.equal(sent[0].opts.vapidDetails.publicKey, k.publicKey);
assert.equal((await listSubscriptions()).length, 1, "a phone that turned notifications off is removed");
console.log("✓ notifications reach each device; switched-off devices are dropped");

sent.length = 0;
const a = await sendAlert({}, { title: "DeskCrew post failed", text: "Why: video too long", link: "https://hq.test/#/create?id=1" });
assert.ok(a.sent.includes("Phone app"));
assert.equal(sent[0].payload.url, "/#/create?id=1");
assert.match(sent[0].payload.title, /DeskCrew post failed/);
console.log("✓ every failure alert also goes to the Social HQ app on the phone, and opens the right post");
console.log("\nPush test passed.");
