// Owner login. First visit: enter the one-time SETUP_CODE and pick a password.
// After that: password (plus a 6-digit authenticator code once 2-step login is on),
// session cookie valid 30 days. "Log out everywhere" and password changes end every session.

import crypto from "node:crypto";
import QRCode from "qrcode";
import { getJSON, setJSON } from "./store.mjs";
import { sign, verify, hashPassword, checkPassword, safeEqual, encrypt, decrypt } from "./crypto.mjs";
import { env, HttpError, parseCookies, cookie } from "./util.mjs";
import { newSecret, check as checkTotp, otpauthUri } from "./totp.mjs";

const SESSION_COOKIE = "hq_session";
const SESSION_DAYS = 30;
const MAX_FAILS = 10;
const LOCK_MIN = 15;

async function authRecord() {
  return (await getJSON("auth/owner")) || null;
}
async function saveRecord(rec) {
  await setJSON("auth/owner", rec);
  return rec;
}

export async function authState(req) {
  const rec = await authRecord();
  const session = rec ? await readSession(req, rec) : null;
  return { setupDone: !!rec, loggedIn: !!session };
}

async function readSession(req, rec) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const payload = verify(token, "session");
  if (!payload) return null;
  if (!rec || payload.v !== rec.version) return null;
  return payload;
}

export async function requireAuth(req) {
  const rec = await authRecord();
  if (!rec) throw new HttpError(401, "Set up your password first.", { code: "setup" });
  const s = await readSession(req, rec);
  if (!s) throw new HttpError(401, "Please log in.", { code: "login" });
  return s;
}

function sessionCookie(rec) {
  const token = sign({ u: "owner", v: rec.version, exp: Date.now() + SESSION_DAYS * 86400000 }, "session");
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 });
}

function checkStrength(pw) {
  if (!pw || String(pw).length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
}

export async function setup({ code, password }) {
  const expected = env("SETUP_CODE");
  if (!expected) throw new HttpError(500, "SETUP_CODE is not set on the Netlify site.");
  if (await authRecord()) throw new HttpError(400, "Password is already set. Log in instead.");
  if (!safeEqual(String(code || "").trim(), expected)) throw new HttpError(403, "That setup code is not right.");
  checkStrength(password);
  const rec = { hash: hashPassword(password), version: 1, createdAt: new Date().toISOString() };
  await setJSON("auth/owner", rec, { onlyIfNew: true });
  const saved = await authRecord();
  return sessionCookie(saved);
}

// ----- wrong-try lock (shared by login, Claude approval and security changes) -----
async function assertNotLocked() {
  const fails = (await getJSON("auth/fails")) || { count: 0, until: 0 };
  if (fails.until && Date.now() < fails.until) throw new HttpError(429, `Too many wrong tries. Wait ${LOCK_MIN} minutes and try again.`);
}
async function noteFail() {
  const fails = (await getJSON("auth/fails")) || { count: 0, until: 0 };
  const count = (fails.count || 0) + 1;
  await setJSON("auth/fails", { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MIN * 60000 : 0 });
}
async function clearFails() {
  const fails = await getJSON("auth/fails");
  if (fails?.count) await setJSON("auth/fails", { count: 0, until: 0 });
}

function makeRecoveryCodes() {
  return Array.from({ length: 8 }, () => crypto.randomBytes(5).toString("hex").toUpperCase().replace(/^(.{5})/, "$1-"));
}

function recoveryHash(code) {
  return crypto.createHash("sha256").update("hq-recovery:" + String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

// Checks a 6-digit code (or a one-time recovery code). Saves the record when it changes.
async function useSecondFactor(rec, code) {
  const t = rec.totp;
  if (!t?.enabled) return { ok: true };
  const c = String(code || "").trim();
  if (!c) return { ok: false, missing: true };
  const secret = decrypt(t.secret);
  const counter = checkTotp(secret, c, { lastCounter: t.lastCounter ?? -1 });
  if (counter !== null) {
    rec.totp.lastCounter = counter;
    await saveRecord(rec);
    return { ok: true };
  }
  const h = recoveryHash(c);
  const idx = (t.recovery || []).indexOf(h);
  if (idx >= 0) {
    rec.totp.recovery.splice(idx, 1);
    await saveRecord(rec);
    return { ok: true, usedRecovery: true, recoveryLeft: rec.totp.recovery.length };
  }
  return { ok: false };
}

// Password + (if switched on) 6-digit code. Used for login, approving Claude and security changes.
export async function verifyOwner({ password, code }) {
  const rec = await authRecord();
  if (!rec) throw new HttpError(400, "Set up your password first.");
  await assertNotLocked();
  if (!checkPassword(password || "", rec.hash)) {
    await noteFail();
    throw new HttpError(403, "Wrong password.");
  }
  const second = await useSecondFactor(rec, code);
  if (second.missing) throw new HttpError(401, "Enter the 6-digit code from your authenticator app.", { code: "totp" });
  if (!second.ok) {
    await noteFail();
    throw new HttpError(403, "That 6-digit code is not right. Check the time on your phone, or use a recovery code.", { code: "totp" });
  }
  await clearFails();
  return { rec, usedRecovery: !!second.usedRecovery, recoveryLeft: second.recoveryLeft };
}

export async function login({ password, code }) {
  const { rec, usedRecovery, recoveryLeft } = await verifyOwner({ password, code });
  return { cookie: sessionCookie(rec), usedRecovery, recoveryLeft };
}

export function logoutCookie() {
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

export async function changePassword({ current, next, code }) {
  const { rec } = await verifyOwner({ password: current, code });
  checkStrength(next);
  const updated = await saveRecord({ ...rec, hash: hashPassword(next), version: (rec.version || 1) + 1, changedAt: new Date().toISOString() });
  return sessionCookie(updated);
}

// Ends every other session (other browsers, phones). Returns a fresh cookie for this one.
export async function logoutEverywhere() {
  const rec = await authRecord();
  const updated = await saveRecord({ ...rec, version: (rec.version || 1) + 1 });
  return sessionCookie(updated);
}

// ----- 2-step login (authenticator app) -----
export async function securityStatus() {
  const rec = await authRecord();
  return {
    twoStep: !!rec?.totp?.enabled,
    recoveryLeft: rec?.totp?.enabled ? (rec.totp.recovery || []).length : 0,
    enabledAt: rec?.totp?.enabledAt || null,
    passwordChangedAt: rec?.changedAt || rec?.createdAt || null,
  };
}

export async function startTwoStep() {
  const rec = await authRecord();
  if (rec.totp?.enabled) throw new HttpError(400, "2-step login is already on.");
  const secret = newSecret();
  rec.totpPending = { secret: encrypt(secret), at: Date.now() };
  await saveRecord(rec);
  const uri = otpauthUri(secret);
  const qr = await QRCode.toString(uri, { type: "svg", margin: 1, color: { dark: "#11131A", light: "#FFFFFF" } });
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qr };
}

export async function finishTwoStep({ code }) {
  const rec = await authRecord();
  const p = rec.totpPending;
  if (!p || Date.now() - p.at > 30 * 60000) throw new HttpError(400, "Start again: press “Turn on 2-step login”.");
  await assertNotLocked();
  const secret = decrypt(p.secret);
  const counter = checkTotp(secret, code);
  if (counter === null) {
    await noteFail();
    throw new HttpError(403, "That code is not right. Type the 6 digits your app shows now.");
  }
  const recovery = makeRecoveryCodes();
  rec.totp = { enabled: true, secret: p.secret, lastCounter: counter, recovery: recovery.map(recoveryHash), enabledAt: new Date().toISOString() };
  delete rec.totpPending;
  rec.version = (rec.version || 1) + 1; // log out every other session
  await saveRecord(rec);
  return { recovery, cookie: sessionCookie(rec) };
}

export async function stopTwoStep({ password, code }) {
  const { rec } = await verifyOwner({ password, code });
  delete rec.totp;
  delete rec.totpPending;
  await saveRecord(rec);
  return { ok: true };
}

export async function newRecoveryCodes({ password, code }) {
  const { rec } = await verifyOwner({ password, code });
  if (!rec.totp?.enabled) throw new HttpError(400, "Turn on 2-step login first.");
  const recovery = makeRecoveryCodes();
  rec.totp.recovery = recovery.map(recoveryHash);
  await saveRecord(rec);
  return { recovery };
}
