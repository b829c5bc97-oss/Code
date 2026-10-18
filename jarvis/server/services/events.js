import { z } from 'zod';
import { db, id, nowIso, updateRow, audit } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime, parseInZone, toUtcIso, expandRecurrence, recurrenceSchema, overlaps } from './time.js';
import { HttpError, notFound } from '../http.js';

export const EVENT_KINDS = ['meeting', 'personal', 'work', 'study', 'focus', 'task_block', 'other'];

export const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional().default(''),
  location: z.string().max(300).optional().default(''),
  participants: z.array(z.string().trim().max(200)).max(50).optional().default([]),
  start: z.string().min(10).describe('ISO 8601 date-time; without an offset it is interpreted in the user time zone'),
  end: z.string().min(10).optional().describe('ISO 8601 date-time. Defaults to start + duration_minutes or 60 minutes'),
  duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
  all_day: z.boolean().optional().default(false),
  kind: z.enum(EVENT_KINDS).optional().default('meeting'),
  recurrence: recurrenceSchema.nullable().optional(),
  reminder_minutes: z.number().int().min(0).max(10080).nullable().optional(),
  task_id: z.string().nullable().optional(),
});

export const eventPatch = eventInput.partial().extend({ title: z.string().trim().min(1).max(200).optional() });

const COLUMNS = ['title', 'description', 'location', 'participants', 'start_at', 'end_at', 'all_day', 'kind', 'recurrence', 'reminder_minutes', 'task_id', 'exdates'];

function zoneOf(userId) {
  return getSettings(userId).timezone;
}

function resolveTimes(input, zone, existing) {
  let start = input.start ? parseInZone(input.start, zone) : existing ? DateTime.fromISO(existing.start_at, { zone: 'utc' }).setZone(zone) : null;
  if (!start) throw new HttpError(400, 'start is required.');
  if (input.all_day) start = start.startOf('day');
  let end;
  if (input.end) end = parseInZone(input.end, zone);
  else if (input.duration_minutes) end = start.plus({ minutes: input.duration_minutes });
  else if (existing && input.start) {
    const dur = Date.parse(existing.end_at) - Date.parse(existing.start_at);
    end = start.plus({ milliseconds: dur });
  } else if (existing) end = DateTime.fromISO(existing.end_at, { zone: 'utc' }).setZone(zone);
  else end = input.all_day ? start.plus({ days: 1 }) : start.plus({ minutes: 60 });
  if (end <= start) throw new HttpError(400, 'End time must be after the start time.');
  if (end.diff(start, 'days').days > 31) throw new HttpError(400, 'Events longer than 31 days are not supported.');
  return { start_at: toUtcIso(start), end_at: toUtcIso(end) };
}

export function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    participants: JSON.parse(row.participants || '[]'),
    start: row.start_at,
    end: row.end_at,
    all_day: !!row.all_day,
    kind: row.kind,
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    reminder_minutes: row.reminder_minutes,
    task_id: row.task_id,
    source: row.source,
    is_demo: !!row.is_demo,
  };
}

export function getEvent(userId, eventId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(eventId, userId);
  if (!row) throw notFound('Event');
  return row;
}

/** All occurrences overlapping [from, to). Recurring series are expanded. */
export function listOccurrences(userId, fromIso, toIso, { query, kind } = {}) {
  const zone = zoneOf(userId);
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const to = DateTime.fromISO(toIso, { zone: 'utc' });
  const rows = db.prepare(`SELECT * FROM events WHERE user_id = ? AND (recurrence IS NOT NULL OR (start_at < ? AND end_at > ?))`).all(userId, toUtcIso(to), toUtcIso(from));
  const q = query?.trim().toLowerCase();
  const out = [];
  for (const row of rows) {
    if (kind && row.kind !== kind) continue;
    if (q && !`${row.title} ${row.description} ${row.location} ${row.participants}`.toLowerCase().includes(q)) continue;
    const occs = expandRecurrence({ start: row.start_at, end: row.end_at, recurrence: row.recurrence, exdates: JSON.parse(row.exdates || '[]') }, from, to, zone);
    for (const o of occs) {
      out.push({ ...serializeEvent(row), start: toUtcIso(o.start), end: toUtcIso(o.end), occurrence_of: row.recurrence ? row.id : null, series_start: row.start_at });
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

export function searchEvents(userId, query, limit = 50) {
  const q = `%${query.trim().toLowerCase()}%`;
  return db.prepare(`SELECT * FROM events WHERE user_id = ? AND (lower(title) LIKE ? OR lower(description) LIKE ? OR lower(location) LIKE ? OR lower(participants) LIKE ?) ORDER BY start_at DESC LIMIT ?`)
    .all(userId, q, q, q, q, limit).map(serializeEvent);
}

/** Events (expanded) that overlap the given window. Focus/task blocks count as busy. */
export function findConflicts(userId, startIso, endIso, excludeId) {
  return listOccurrences(userId, startIso, endIso)
    .filter((e) => e.id !== excludeId && !e.all_day)
    .filter((e) => overlaps(e.start, e.end, startIso, endIso))
    .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, kind: e.kind }));
}

export function createEvent(userId, raw, { actor = 'user', allowConflict = true, source = 'local', isDemo = false } = {}) {
  const input = eventInput.parse(raw);
  const zone = zoneOf(userId);
  const times = resolveTimes(input, zone);
  const conflicts = input.all_day ? [] : findConflicts(userId, times.start_at, times.end_at);
  if (conflicts.length && !allowConflict) return { created: false, conflicts };
  if (input.task_id) assertTaskOwned(userId, input.task_id);
  const eventId = id();
  const now = nowIso();
  db.prepare(`INSERT INTO events (id, user_id, title, description, location, participants, start_at, end_at, all_day, kind, recurrence, reminder_minutes, task_id, source, is_demo, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    eventId, userId, input.title, input.description, input.location, JSON.stringify(input.participants), times.start_at, times.end_at,
    input.all_day ? 1 : 0, input.kind, input.recurrence ? JSON.stringify(input.recurrence) : null,
    input.reminder_minutes ?? null, input.task_id ?? null, source, isDemo ? 1 : 0, now, now,
  );
  audit(userId, actor, 'create', 'event', eventId, input.title);
  return { created: true, event: serializeEvent(getEvent(userId, eventId)), conflicts };
}

export function updateEvent(userId, eventId, raw, { actor = 'user', allowConflict = true } = {}) {
  const existing = getEvent(userId, eventId);
  const input = eventPatch.parse(raw);
  const zone = zoneOf(userId);
  const patch = { ...input };
  delete patch.start; delete patch.end; delete patch.duration_minutes;
  if (input.start || input.end || input.duration_minutes) Object.assign(patch, resolveTimes(input, zone, existing));
  const start = patch.start_at || existing.start_at;
  const end = patch.end_at || existing.end_at;
  const conflicts = (patch.start_at || patch.end_at) && !(input.all_day ?? existing.all_day) ? findConflicts(userId, start, end, eventId) : [];
  if (conflicts.length && !allowConflict) return { updated: false, conflicts };
  if ('recurrence' in input) patch.recurrence = input.recurrence ? JSON.stringify(input.recurrence) : null;
  if (input.task_id) assertTaskOwned(userId, input.task_id);
  updateRow('events', userId, eventId, { ...patch, updated_at: nowIso() }, [...COLUMNS, 'updated_at']);
  audit(userId, actor, 'update', 'event', eventId, Object.keys(input).join(','));
  return { updated: true, event: serializeEvent(getEvent(userId, eventId)), conflicts };
}

/** Delete a whole series, or (for recurring events) just one occurrence via an exdate. */
export function deleteEvent(userId, eventId, { occurrenceStart, actor = 'user' } = {}) {
  const existing = getEvent(userId, eventId);
  if (occurrenceStart && existing.recurrence) {
    const ex = new Set(JSON.parse(existing.exdates || '[]'));
    ex.add(toUtcIso(DateTime.fromISO(occurrenceStart, { zone: 'utc' })));
    db.prepare('UPDATE events SET exdates = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(JSON.stringify([...ex]), nowIso(), eventId, userId);
    audit(userId, actor, 'delete_occurrence', 'event', eventId, occurrenceStart);
    return { deleted: 'occurrence', title: existing.title };
  }
  db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(eventId, userId);
  audit(userId, actor, 'delete', 'event', eventId, existing.title);
  return { deleted: 'event', title: existing.title };
}

function assertTaskOwned(userId, taskId) {
  if (!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId)) throw notFound('Linked task');
}
