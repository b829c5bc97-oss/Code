// Encryption for stored logins, signed cookies, password hashing.
// Everything is derived from one secret environment variable: MASTER_KEY.

import crypto from "node:crypto";
import { env, HttpError } from "./util.mjs";

function master() {
  const m = env("MASTER_KEY");
  if (!m || m.length < 16) throw new HttpError(500, "MASTER_KEY is not set on the Netlify site.");
  return m;
}

function derive(label) {
  return crypto.createHmac("sha256", master()).update(`social-hq:${label}`).digest();
}

export function encrypt(text) {
  if (text === undefined || text === null || text === "") return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", derive("enc"), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decrypt(value) {
  if (!value) return null;
  if (!String(value).startsWith("v1:")) return null;
  const buf = Buffer.from(String(value).slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", derive("enc"), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

export function sign(payload, label) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", derive(`sign:${label}`)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify(token, label) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", derive(`sign:${label}`)).update(body).digest("base64url");
  const a = Buffer.from(mac || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function checkPassword(pw, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 32);
  const want = Buffer.from(hashHex, "hex");
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}

// Shared secret between the scheduler and the background publisher.
export function internalSecret() {
  return derive("internal").toString("hex");
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
