import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { parseBody, ah, HttpError } from '../http.js';
import { PROVIDERS, isConfigured, redirectUri, startAuth, finishAuth, disconnect } from '../integrations/oauth.js';
import { syncCalendar } from '../integrations/calendarSync.js';
import * as email from '../integrations/email.js';
import { searchStatus, webSearch } from '../integrations/search.js';
import { providerStatus } from '../ai/agent.js';

export const integrations = express.Router();
const uid = (req) => req.user.id;

integrations.get('/', (req, res) => {
  const rows = db.prepare('SELECT provider, status, account_email, scopes, last_sync_at, last_error, created_at FROM integrations WHERE user_id = ?').all(uid(req));
  res.json({
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({
      key, label: p.label, configured: isConfigured(key), redirect_uri: redirectUri(key), setup: p.setup, scopes: p.scopes,
      connection: rows.find((r) => r.provider === key) || null,
      tested: false, // honest status: these flows follow the official docs but have not been verified against live accounts in this build
    })),
    ai: providerStatus(),
    search: searchStatus(),
    banking: { configured: false, note: 'No bank-data provider is integrated. Use manual entry or CSV import. JARVIS never asks for online-banking passwords.' },
  });
});

integrations.get('/:provider/connect', (req, res) => {
  if (!PROVIDERS[req.params.provider]) throw new HttpError(404, 'Unknown provider.');
  res.redirect(startAuth(uid(req), req.params.provider));
});

integrations.post('/:provider/disconnect', (req, res) => {
  if (!PROVIDERS[req.params.provider]) throw new HttpError(404, 'Unknown provider.');
  disconnect(uid(req), req.params.provider);
  db.prepare('DELETE FROM events WHERE user_id = ? AND source = ?').run(uid(req), req.params.provider);
  res.json({ ok: true });
});

integrations.post('/:provider/sync', ah(async (req, res) => {
  if (!PROVIDERS[req.params.provider]) throw new HttpError(404, 'Unknown provider.');
  res.json(await syncCalendar(uid(req), req.params.provider, 30));
}));

// ---------- email ----------
integrations.get('/email/messages', ah(async (req, res) => {
  res.json(await email.listMessages(uid(req), { unread_only: req.query.unread !== '0', query: req.query.q ? String(req.query.q) : '', max: Math.min(Number(req.query.max) || 15, 25) }));
}));
integrations.get('/email/threads/:id', ah(async (req, res) => {
  const t = await email.getThread(uid(req), req.params.id);
  res.json({ ...t, extracted: email.extractActionsFromText(t.messages.map((m) => m.body).join('\n')) });
}));
integrations.get('/email/drafts', (req, res) => res.json(email.listDrafts(uid(req))));
integrations.post('/email/drafts', ah(async (req, res) => {
  const b = parseBody(z.object({ to: z.string().email().max(300), subject: z.string().max(300), body: z.string().max(20000), thread_id: z.string().optional() }), req.body);
  res.status(201).json(await email.saveDraft(uid(req), b));
}));
integrations.patch('/email/drafts/:id', (req, res) => {
  const b = parseBody(z.object({ to: z.string().email().max(300).optional(), subject: z.string().max(300).optional(), body: z.string().max(20000).optional() }), req.body);
  email.updateDraft(uid(req), req.params.id, b);
  res.json({ ok: true });
});
integrations.delete('/email/drafts/:id', (req, res) => {
  email.deleteDraft(uid(req), req.params.id);
  res.json({ ok: true });
});
/** Explicit user send: the client must echo back the exact recipient and subject the user confirmed. */
integrations.post('/email/drafts/:id/send', ah(async (req, res) => {
  const b = parseBody(z.object({ confirm_to: z.string(), confirm_subject: z.string() }), req.body);
  res.json(await email.sendDraft(uid(req), req.params.id, b));
}));

// ---------- web search (direct, for the Notes & Research screen) ----------
integrations.post('/search', ah(async (req, res) => {
  const b = parseBody(z.object({ query: z.string().trim().min(2).max(300) }), req.body);
  if (!searchStatus().configured) throw new HttpError(400, 'Web search is not configured on this server.');
  res.json(await webSearch(b.query, 8));
}));

/** OAuth redirect target. Not behind requireAuth: the state parameter identifies the user. */
export const oauthCallback = express.Router();
oauthCallback.get('/:provider/callback', ah(async (req, res) => {
  const provider = req.params.provider;
  if (!PROVIDERS[provider]) return res.status(404).send('Unknown provider');
  try {
    const userId = await finishAuth(provider, { code: String(req.query.code || ''), state: String(req.query.state || ''), error: req.query.error ? String(req.query.error) : null });
    if (req.user && req.user.id !== userId) throw new HttpError(400, 'Signed in as a different user than the one who started the connection.');
    res.redirect(`/#/integrations?connected=${provider}`);
  } catch (e) {
    res.redirect(`/#/integrations?error=${encodeURIComponent(e.message)}`);
  }
}));
