import { db, id, nowIso, audit } from '../db.js';
import { apiFetch, getIntegration } from './oauth.js';
import { HttpError } from '../http.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';

/** Which connected mailbox to use (Gmail preferred if both are connected). */
export function mailProvider(userId) {
  for (const p of ['google', 'microsoft']) {
    const row = getIntegration(userId, p);
    if (row && row.status === 'connected') return p;
  }
  return null;
}

function requireMailbox(userId) {
  const p = mailProvider(userId);
  if (!p) throw new HttpError(400, 'No mailbox is connected. Connect Gmail or Outlook on the Integrations page first.');
  return p;
}

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function decodeBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload.parts || []) {
    const t = decodeBody(part);
    if (t) return t;
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) return stripHtml(Buffer.from(payload.body.data, 'base64url').toString('utf8'));
  return '';
}

const stripHtml = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export async function listMessages(userId, { unread_only = true, query = '', max = 10 } = {}) {
  const provider = requireMailbox(userId);
  if (provider === 'google') {
    const q = [unread_only ? 'is:unread' : '', 'in:inbox', query].filter(Boolean).join(' ');
    const list = await apiFetch(userId, 'google', `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
    const msgs = await Promise.all((list.messages || []).map((m) => apiFetch(userId, 'google', `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    return {
      provider: 'gmail', source: 'connected mailbox',
      messages: msgs.map((m) => ({ id: m.id, thread_id: m.threadId, from: header(m.payload?.headers, 'From'), subject: header(m.payload?.headers, 'Subject'), date: header(m.payload?.headers, 'Date'), snippet: m.snippet, unread: (m.labelIds || []).includes('UNREAD'), important: (m.labelIds || []).includes('IMPORTANT') })),
    };
  }
  const params = new URLSearchParams({ $top: String(max), $select: 'id,conversationId,from,subject,receivedDateTime,bodyPreview,isRead,importance', $orderby: 'receivedDateTime desc' });
  if (unread_only) params.set('$filter', 'isRead eq false');
  if (query) { params.delete('$orderby'); params.delete('$filter'); params.set('$search', `"${query.replace(/"/g, '')}"`); }
  const list = await apiFetch(userId, 'microsoft', `${GRAPH}/mailFolders/inbox/messages?${params}`);
  return {
    provider: 'outlook', source: 'connected mailbox',
    messages: (list.value || []).map((m) => ({ id: m.id, thread_id: m.conversationId, from: m.from?.emailAddress ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>` : '', subject: m.subject, date: m.receivedDateTime, snippet: m.bodyPreview, unread: !m.isRead, important: m.importance === 'high' })),
  };
}

export async function getThread(userId, threadId) {
  const provider = requireMailbox(userId);
  if (provider === 'google') {
    const t = await apiFetch(userId, 'google', `${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`);
    return {
      provider: 'gmail', thread_id: t.id,
      messages: (t.messages || []).map((m) => ({ id: m.id, from: header(m.payload?.headers, 'From'), to: header(m.payload?.headers, 'To'), subject: header(m.payload?.headers, 'Subject'), date: header(m.payload?.headers, 'Date'), message_id: header(m.payload?.headers, 'Message-ID'), body: decodeBody(m.payload).slice(0, 20000) })),
    };
  }
  const list = await apiFetch(userId, 'microsoft', `${GRAPH}/messages?${new URLSearchParams({ $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`, $select: 'id,from,toRecipients,subject,receivedDateTime,body', $top: '25' })}`);
  return {
    provider: 'outlook', thread_id: threadId,
    messages: (list.value || []).map((m) => ({ id: m.id, from: m.from?.emailAddress?.address, to: (m.toRecipients || []).map((r) => r.emailAddress.address).join(', '), subject: m.subject, date: m.receivedDateTime, body: (m.body?.contentType === 'html' ? stripHtml(m.body.content) : m.body?.content || '').slice(0, 20000) })),
  };
}

/** Store a draft locally for review. Nothing leaves JARVIS until the user presses Send and confirms. */
export async function saveDraft(userId, { to, subject, body, thread_id }) {
  const provider = mailProvider(userId) || 'none';
  const did = id();
  db.prepare('INSERT INTO email_drafts (id, user_id, provider, to_addr, subject, body, thread_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run(did, userId, provider, to, subject, body, thread_id ?? null, nowIso());
  audit(userId, 'assistant', 'create', 'email_draft', did, `to ${to}`);
  return { draft_id: did, status: 'draft', sent: false, note: provider === 'none' ? 'Saved as a local draft. No mailbox is connected, so it cannot be sent from JARVIS.' : 'Saved as a draft for the user to review and send from the Email screen.' };
}

export const listDrafts = (userId) => db.prepare('SELECT * FROM email_drafts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);

function rfc2822({ to, subject, body, inReplyTo }) {
  const enc = (s) => (/[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=` : s);
  const lines = [`To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body}`).toString('base64url');
}

/**
 * Send a draft. Only reachable from a direct user request that repeats the exact
 * recipient and subject shown in the confirmation dialog — never from the model.
 */
export async function sendDraft(userId, draftId, { confirm_to, confirm_subject }) {
  const d = db.prepare('SELECT * FROM email_drafts WHERE id = ? AND user_id = ?').get(draftId, userId);
  if (!d) throw new HttpError(404, 'Draft not found.');
  if (d.status === 'sent') throw new HttpError(409, 'This draft was already sent.');
  if (confirm_to !== d.to_addr || confirm_subject !== d.subject) throw new HttpError(400, 'Confirmation does not match the draft recipient and subject.');
  const provider = requireMailbox(userId);
  try {
    let externalId;
    if (provider === 'google') {
      const thread = d.thread_id ? await getThread(userId, d.thread_id).catch(() => null) : null;
      const inReplyTo = thread?.messages?.at(-1)?.message_id;
      const r = await apiFetch(userId, 'google', `${GMAIL}/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: rfc2822({ to: d.to_addr, subject: d.subject, body: d.body, inReplyTo }), threadId: d.thread_id || undefined }) });
      externalId = r.id;
    } else {
      await apiFetch(userId, 'microsoft', `${GRAPH}/sendMail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { subject: d.subject, body: { contentType: 'Text', content: d.body }, toRecipients: [{ emailAddress: { address: d.to_addr } }] }, saveToSentItems: true }) });
    }
    db.prepare("UPDATE email_drafts SET status = 'sent', provider = ?, external_id = ?, sent_at = ?, error = NULL WHERE id = ?").run(provider, externalId ?? null, nowIso(), draftId);
    audit(userId, 'user', 'send', 'email_draft', draftId, `to ${d.to_addr}`);
    return { sent: true };
  } catch (e) {
    db.prepare("UPDATE email_drafts SET status = 'failed', error = ? WHERE id = ?").run(e.message, draftId);
    throw e;
  }
}

export function updateDraft(userId, draftId, { to, subject, body }) {
  const d = db.prepare("SELECT * FROM email_drafts WHERE id = ? AND user_id = ? AND status != 'sent'").get(draftId, userId);
  if (!d) throw new HttpError(404, 'Draft not found.');
  db.prepare('UPDATE email_drafts SET to_addr = ?, subject = ?, body = ? WHERE id = ?').run(to ?? d.to_addr, subject ?? d.subject, body ?? d.body, draftId);
}

export function deleteDraft(userId, draftId) {
  db.prepare('DELETE FROM email_drafts WHERE id = ? AND user_id = ?').run(draftId, userId);
}

/** Pull dates and action-like sentences out of an email body (deterministic helper used by the UI). */
export function extractActionsFromText(text) {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const action = sentences.filter((s) => /\b(please|could you|can you|need to|action|deadline|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|today|eod|end of)|due|asap|follow up|let me know)\b/i.test(s)).slice(0, 8);
  const dates = [...text.matchAll(/\b(\d{1,2}(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(st|nd|rd|th)?|\d{4}-\d{2}-\d{2}|(mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|next week)\b/gi)].map((m) => m[0]);
  return { action_items: action, dates: [...new Set(dates)].slice(0, 10) };
}
