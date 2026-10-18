import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, id, nowIso, audit } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from './security.js';
import { getSettings, updateSettings } from './settings.js';
import { HttpError, parseBody } from './http.js';

const COOKIE = config.isProd ? '__Host-jarvis_sid' : 'jarvis_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    path: '/',
    expires,
  });
}

export function createSession(res, userId, userAgent) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(sha256(token), userId, nowIso(), expires.toISOString(), (userAgent || '').slice(0, 200));
  setSessionCookie(res, token, expires);
}

/** Attaches req.user when a valid session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db.prepare(`SELECT u.id, u.email, u.name, s.expires_at, s.id_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(sha256(token));
    if (row && row.expires_at > nowIso()) {
      req.user = { id: row.id, email: row.email, name: row.name };
      req.sessionHash = row.id_hash;
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in.'));
  next();
}

/**
 * CSRF defence for cookie-authenticated mutations: require a custom header
 * (cannot be sent cross-site without a CORS preflight, which we never allow)
 * and, when the browser sends Origin, that it matches our host.
 */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/integrations/') && req.path.endsWith('/callback')) return next();
  if (req.get('x-jarvis-csrf') !== '1') return next(new HttpError(403, 'Missing CSRF header.'));
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    try {
      if (new URL(origin).host !== host) return next(new HttpError(403, 'Cross-origin request rejected.'));
    } catch {
      return next(new HttpError(403, 'Bad origin.'));
    }
  }
  next();
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, 'Password must be at least 10 characters.').max(200),
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isProd ? 20 : 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });

export const authRouter = express.Router();

authRouter.post('/signup', authLimiter, (req, res) => {
  if (!config.allowSignup) throw new HttpError(403, 'Sign-ups are disabled on this server.');
  const body = parseBody(credentials.extend({ name: z.string().trim().min(1).max(80) }), req.body);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) throw new HttpError(409, 'An account with this email already exists.');
  const userId = id();
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)')
    .run(userId, body.email, body.name, hashPassword(body.password), nowIso());
  const tz = typeof req.body.timezone === 'string' ? req.body.timezone : undefined;
  try {
    updateSettings(userId, { profile: { displayName: body.name }, ...(tz ? { timezone: tz } : {}) });
  } catch {
    updateSettings(userId, { profile: { displayName: body.name } });
  }
  seedDefaultCategories(userId);
  audit(userId, 'user', 'signup', 'user', userId);
  createSession(res, userId, req.get('user-agent'));
  res.status(201).json({ user: { id: userId, email: body.email, name: body.name } });
});

authRouter.post('/login', authLimiter, (req, res) => {
  const body = parseBody(credentials.extend({ password: z.string().min(1).max(200) }), req.body);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email);
  // Verify against a dummy hash when the user doesn't exist to keep timing uniform.
  const ok = verifyPassword(body.password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');
  createSession(res, user.id, req.get('user-agent'));
  audit(user.id, 'user', 'login', 'user', user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

authRouter.post('/logout', (req, res) => {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.sessionHash);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, signupAllowed: config.allowSignup });
  res.json({ user: req.user, settings: getSettings(req.user.id) });
});

authRouter.post('/password', requireAuth, (req, res) => {
  const body = parseBody(z.object({ current: z.string().min(1), next: credentials.shape.password }), req.body);
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(body.current, user.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(req.user.id, req.sessionHash);
  audit(req.user.id, 'user', 'password_change', 'user', req.user.id);
  res.json({ ok: true });
});

authRouter.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

const DUMMY_HASH = hashPassword(randomToken());

export const DEFAULT_CATEGORIES = [
  ['Food & Dining', 'expense', '#f59e0b'], ['Groceries', 'expense', '#84cc16'], ['Transport', 'expense', '#06b6d4'],
  ['Rent & Housing', 'expense', '#8b5cf6'], ['Utilities', 'expense', '#3b82f6'], ['Shopping', 'expense', '#ec4899'],
  ['Health', 'expense', '#ef4444'], ['Entertainment', 'expense', '#a855f7'], ['Subscriptions', 'expense', '#6366f1'],
  ['Education', 'expense', '#14b8a6'], ['Travel', 'expense', '#0ea5e9'], ['Other', 'expense', '#64748b'],
  ['Salary', 'income', '#22c55e'], ['Freelance', 'income', '#10b981'], ['Other Income', 'income', '#4ade80'],
];

export function seedDefaultCategories(userId) {
  const stmt = db.prepare('INSERT OR IGNORE INTO categories (id, user_id, name, kind, color) VALUES (?,?,?,?,?)');
  for (const [name, kind, color] of DEFAULT_CATEGORIES) stmt.run(id(), userId, name, kind, color);
}
