import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { parseBody, ah, HttpError } from '../http.js';
import { chat, providerStatus, getConversation, recordActionOutcome } from '../ai/agent.js';
import { runConfirmedAction, toolMap } from '../ai/tools.js';
import { searchStatus } from '../integrations/search.js';

export const assistant = express.Router();
const uid = (req) => req.user.id;

const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false, message: { error: 'You are sending messages too quickly. Wait a minute and try again.' } });

assistant.get('/status', (req, res) => res.json({ ...providerStatus(), web_search: searchStatus() }));

assistant.get('/conversations', (req, res) => res.json(db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(uid(req))));
assistant.get('/conversations/:id', (req, res) => {
  const c = getConversation(uid(req), req.params.id);
  const messages = db.prepare('SELECT id, role, content, actions, created_at FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at, rowid').all(c.id, uid(req))
    .map((m) => ({ ...m, actions: JSON.parse(m.actions || '[]') }));
  const pending = db.prepare("SELECT id, tool, summary, args, created_at FROM pending_actions WHERE conversation_id = ? AND user_id = ? AND status = 'pending'").all(c.id, uid(req))
    .map((p) => {
      const tool = toolMap.get(p.tool);
      let preview = null;
      try { preview = tool?.preview ? tool.preview(JSON.parse(p.args), uid(req)) : null; } catch { preview = null; }
      return { id: p.id, tool: p.tool, summary: p.summary, created_at: p.created_at, preview };
    });
  res.json({ ...c, messages, pending });
});
assistant.delete('/conversations/:id', (req, res) => {
  getConversation(uid(req), req.params.id);
  db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.id, uid(req));
  res.json({ ok: true });
});

assistant.post('/chat', chatLimiter, ah(async (req, res) => {
  const b = parseBody(z.object({ message: z.string().trim().min(1).max(8000), conversation_id: z.string().nullable().optional() }), req.body);
  const out = await chat(uid(req), { conversationId: b.conversation_id || null, text: b.message });
  res.json(out);
}));

assistant.get('/actions/:id', (req, res) => {
  const p = db.prepare('SELECT id, tool, summary, args, status, result, created_at FROM pending_actions WHERE id = ? AND user_id = ?').get(req.params.id, uid(req));
  if (!p) throw new HttpError(404, 'Action not found.');
  res.json({ ...p, args: JSON.parse(p.args), result: p.result ? JSON.parse(p.result) : null });
});

assistant.post('/actions/:id', ah(async (req, res) => {
  const b = parseBody(z.object({ decision: z.enum(['confirm', 'reject']) }), req.body);
  const outcome = await runConfirmedAction(uid(req), req.params.id, b.decision);
  if (outcome.action) recordActionOutcome(uid(req), outcome.action, outcome);
  if (outcome.status === 'error' && !outcome.action) throw new HttpError(400, outcome.error);
  res.json(outcome);
}));
