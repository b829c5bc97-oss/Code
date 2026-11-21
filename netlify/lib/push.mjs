// Phone notifications through the Social HQ app itself (Web Push).
// Works on Android (Chrome) and on iPhone once Social HQ is added to the Home Screen (iOS 16.4+).
// Each phone/computer that says "yes" to notifications is stored as a subscription.

import webpush from "web-push";
import { createHash } from "node:crypto";
import { getJSON, setJSON, del, listKeys } from "./store.mjs";
import { clean } from "./util.mjs";

let sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
export function _setPushSender(fn) { sender = fn; } // tests

export async function vapidKeys() {
  let k = await getJSON("secret/VAPID");
  if (!k?.publicKey) {
    k = webpush.generateVAPIDKeys();
    await setJSON("secret/VAPID", k);
  }
  return k;
}

const idOf = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

export async function addSubscription(sub, device = "") {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error("That phone didn't send a proper notification address.");
  const u = new URL(sub.endpoint);
  if (u.protocol !== "https:") throw new Error("Notification address must be https.");
  const rec = { endpoint: sub.endpoint, keys: { p256dh: clean(sub.keys.p256dh, 200), auth: clean(sub.keys.auth, 100) }, device: clean(device, 80) || u.hostname, at: new Date().toISOString() };
  await setJSON(`push/sub/${idOf(sub.endpoint)}`, rec);
  return { id: idOf(sub.endpoint), device: rec.device };
}

export async function removeSubscription(endpointOrId) {
  const id = /^[a-f0-9]{24}$/.test(endpointOrId) ? endpointOrId : idOf(endpointOrId);
  await del(`push/sub/${id}`);
}

export async function listSubscriptions() {
  const out = [];
  for (const k of await listKeys("push/sub/")) {
    const s = await getJSON(k);
    if (s) out.push({ id: k.split("/").pop(), ...s });
  }
  return out;
}

// Send to every device. Devices that have switched notifications off are removed.
export async function pushAll({ title, body, url = "/", tag = "" }) {
  const subs = await listSubscriptions();
  if (!subs.length) return { sent: 0, devices: 0 };
  const k = await vapidKeys();
  const contact = "mailto:alerts@socialhq.app";
  const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), url, tag });
  let sent = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: s.keys }, payload, { vapidDetails: { subject: contact, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 3600, urgency: "high" });
      sent++;
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await removeSubscription(s.id);
      else errors.push(`${s.device}: ${e?.body || e?.message || e}`);
    }
  }
  if (!sent && errors.length) throw new Error(errors.join("; "));
  return { sent, devices: subs.length };
}
