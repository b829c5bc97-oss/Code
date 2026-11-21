// 6-digit codes from an authenticator app (Google Authenticator, Microsoft Authenticator,
// 1Password...). Standard TOTP: SHA-1, 30-second steps, 6 digits (RFC 6238).

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret) {
  const clean = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codeAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, "0");
}

export function currentCounter(now = Date.now()) {
  return Math.floor(now / 30000);
}

// Returns the matching step number (to block re-use of the same code), or null.
// Accepts one step either side for phone clocks that are slightly off.
export function check(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const base = currentCounter(now);
  for (const step of [0, -1, 1]) {
    const counter = base + step;
    if (counter <= lastCounter) continue;
    const want = codeAt(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return counter;
  }
  return null;
}

export function otpauthUri(secret, { issuer = "Social HQ", account = "Pratham" } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
