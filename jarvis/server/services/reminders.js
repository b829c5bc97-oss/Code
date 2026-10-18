import { z } from 'zod';
import { db, id, nowIso, updateRow, audit } from '../db.js';
import { getSettings } from '../settings.js';
import { parseInZone, toUtcIso, recurrenceSchema, nextOccurrence, DateTime } from './time.js';
import { notFound } from '../http.js';
import { publish } from './bus.js';

export const reminderInput = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(4000).optional().default(''),
  remind_at: z.string().min(10).describe('ISO 8601 date-time; without offset interpreted in the user time zone'),
  recurrence: recurrenceSchema.nullable().optional(),
  entity_type: z.enum(['task', 'event', 'bill', 'note']).nullable().optional(),
  entity_id: z.string().nullable().optional(),
});

function serialize(r) {
  return {
    id: r.id, title: r.title, notes: r.notes, remind_at: r.remind_at, recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
    status: r.status, entity_type: r.entity_type, entity_id: r.entity_id, last_fired_at: r.last_fired_at, is_demo: !!r.is_demo,
  };
}

const ENTITY_TABLE = { task: 'tasks', event: 'events', bill: 'bills', note: 'notes' };

export function listReminders(userId, { status, from, to } = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (status === 'active') where.push("status IN ('pending','fired')");
  else if (status) { where.push('status = ?'); args.push(status); }
  if (from) { where.push('remind_at >= ?'); args.push(from); }
  if (to) { where.push('remind_at <= ?'); args.push(to); }
  return db.prepare(`SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY remind_at`).all(...args).map(serialize);
}

export function getReminder(userId, rid) {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').get(rid, userId);
  if (!r) throw notFound('Reminder');
  return serialize(r);
}

export function createReminder(userId, raw, { actor = 'user', isDemo = false } = {}) {
  const r = reminderInput.parse(raw);
  const zone = getSettings(userId).timezone;
  if (r.entity_type && r.entity_id && !db.prepare(`SELECT 1 FROM ${ENTITY_TABLE[r.entity_type]} WHERE id = ? AND user_id = ?`).get(r.entity_id, userId)) throw notFound(`Linked ${r.entity_type}`);
  const rid = id();
  db.prepare('INSERT INTO reminders (id, user_id, title, notes, remind_at, recurrence, entity_type, entity_id, is_demo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(rid, userId, r.title, r.notes, toUtcIso(parseInZone(r.remind_at, zone)), r.recurrence ? JSON.stringify(r.recurrence) : null, r.entity_type ?? null, r.entity_id ?? null, isDemo ? 1 : 0, nowIso());
  audit(userId, actor, 'create', 'reminder', rid, r.title);
  return getReminder(userId, rid);
}

export function updateReminder(userId, rid, raw, { actor = 'user' } = {}) {
  getReminder(userId, rid);
  const r = reminderInput.partial().extend({ status: z.enum(['pending', 'fired', 'done', 'dismissed']).optional() }).parse(raw);
  const zone = getSettings(userId).timezone;
  const patch = { ...r };
  if (r.remind_at) {
    patch.remind_at = toUtcIso(parseInZone(r.remind_at, zone));
    if (!r.status) patch.status = 'pending';
  }
  if ('recurrence' in r) patch.recurrence = r.recurrence ? JSON.stringify(r.recurrence) : null;
  updateRow('reminders', userId, rid, patch, ['title', 'notes', 'remind_at', 'recurrence', 'status', 'entity_type', 'entity_id']);
  audit(userId, actor, 'update', 'reminder', rid, Object.keys(r).join(','));
  return getReminder(userId, rid);
}

/** Snooze sets a new time and re-arms the reminder. */
export function snoozeReminder(userId, rid, minutes = 10) {
  getReminder(userId, rid);
  db.prepare("UPDATE reminders SET remind_at = ?, status = 'pending' WHERE id = ? AND user_id = ?").run(toUtcIso(DateTime.utc().plus({ minutes })), rid, userId);
  return getReminder(userId, rid);
}

export function deleteReminder(userId, rid, { actor = 'user' } = {}) {
  const r = getReminder(userId, rid);
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(rid, userId);
  audit(userId, actor, 'delete', 'reminder', rid, r.title);
  return { deleted: true, title: r.title };
}

/** Called by the scheduler: fire a due reminder and roll recurring ones forward. */
export function fireReminder(row, now = DateTime.utc()) {
  const zone = getSettings(row.user_id).timezone;
  notify(row.user_id, { kind: 'reminder', title: row.title, body: row.notes, link: '#/reminders', dedupe_key: `reminder:${row.id}:${row.remind_at}` });
  if (row.recurrence) {
    const firedAt = DateTime.fromISO(row.remind_at, { zone: 'utc' });
    const next = nextOccurrence(row.remind_at, row.recurrence, zone, DateTime.max(now, firedAt));
    if (next) {
      db.prepare("UPDATE reminders SET remind_at = ?, status = 'pending', last_fired_at = ? WHERE id = ?").run(toUtcIso(next), nowIso(), row.id);
      return;
    }
  }
  db.prepare("UPDATE reminders SET status = 'fired', last_fired_at = ? WHERE id = ?").run(nowIso(), row.id);
}

// ---------- notifications ----------
/** Insert an in-app notification (idempotent per dedupe_key) and push it to open tabs. */
export function notify(userId, { kind, title, body = '', link = null, dedupe_key = null }) {
  const settings = getSettings(userId);
  if (!settings.notifications.inApp && kind !== 'system') return null;
  const nid = id();
  const res = db.prepare('INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, link, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(nid, userId, kind, title, body, link, dedupe_key, nowIso());
  if (!res.changes) return null;
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(nid);
  publish(userId, { type: 'notification', notification: n });
  return n;
}

export function listNotifications(userId, { unread, limit = 50 } = {}) {
  const sql = `SELECT * FROM notifications WHERE user_id = ? ${unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(userId, Math.min(limit, 200));
}

export function markNotificationsRead(userId, ids) {
  if (ids === 'all') return db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), userId).changes;
  let n = 0;
  for (const nid of ids) n += db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(nowIso(), nid, userId).changes;
  return n;
}
