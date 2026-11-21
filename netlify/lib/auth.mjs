// Owner login. First visit: enter the one-time SETUP_CODE and pick a password.
// After that: password login, session cookie valid 30 days.

import { getJSON, setJSON } from "./store.mjs";
import { sign, verify, hashPassword, checkPassword, safeEqual } from "./crypto.mjs";
import { env, HttpError, parseCookies, cookie } from "./util.mjs";

const SESSION_COOKIE = "hq_session";
const SESSION_DAYS = 30;

async function authRecord() {
  return (await getJSON("auth/owner")) || null;
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

export async function login({ password }) {
  const rec = await authRecord();
  if (!rec) throw new HttpError(400, "Set up your password first.");
  const fails = (await getJSON("auth/fails")) || { count: 0, until: 0 };
  if (fails.until && Date.now() < fails.until) {
    throw new HttpError(429, "Too many wrong tries. Wait 15 minutes and try again.");
  }
  if (!checkPassword(password || "", rec.hash)) {
    const count = (fails.count || 0) + 1;
    await setJSON("auth/fails", { count: count >= 10 ? 0 : count, until: count >= 10 ? Date.now() + 15 * 60000 : 0 });
    throw new HttpError(403, "Wrong password.");
  }
  if (fails.count) await setJSON("auth/fails", { count: 0, until: 0 });
  return sessionCookie(rec);
}

export function logoutCookie() {
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

export async function changePassword({ current, next }) {
  const rec = await authRecord();
  if (!rec || !checkPassword(current || "", rec.hash)) throw new HttpError(403, "Your current password is not right.");
  checkStrength(next);
  const updated = { ...rec, hash: hashPassword(next), version: (rec.version || 1) + 1, changedAt: new Date().toISOString() };
  await setJSON("auth/owner", updated);
  return sessionCookie(updated);
}
