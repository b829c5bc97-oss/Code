import { DateTime, Interval } from 'luxon';
import { z } from 'zod';

export { DateTime };

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  byDay: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});

/** Accepts an ISO string with offset/Z (absolute) or a naive local "YYYY-MM-DDTHH:mm" interpreted in `zone`. */
export function parseInZone(value, zone) {
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  const s = String(value).trim();
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const dt = hasOffset ? DateTime.fromISO(s, { setZone: true }).setZone(zone) : DateTime.fromISO(s, { zone });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${s}`);
  return dt;
}

export const toUtcIso = (dt) => dt.toUTC().toISO({ suppressMilliseconds: true });

export function dayBounds(dateStr, zone) {
  const start = DateTime.fromISO(dateStr, { zone }).startOf('day');
  if (!start.isValid) throw new Error(`Invalid date: ${dateStr}`);
  return { start, end: start.plus({ days: 1 }) };
}

export const todayIn = (zone) => DateTime.now().setZone(zone).toISODate();

export function atTime(dateDt, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return dateDt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/**
 * Expand a recurring series into occurrences overlapping [rangeStart, rangeEnd).
 * Expansion runs in the user's zone so "9:00 every Monday" stays at 9:00 across DST.
 */
export function expandRecurrence({ start, end, recurrence, exdates = [] }, rangeStart, rangeEnd, zone) {
  const s0 = DateTime.fromISO(start, { zone: 'utc' }).setZone(zone);
  const e0 = DateTime.fromISO(end, { zone: 'utc' }).setZone(zone);
  const durationMs = e0.toMillis() - s0.toMillis();
  if (!recurrence) {
    return e0 > rangeStart && s0 < rangeEnd ? [{ start: s0, end: e0 }] : [];
  }
  const rule = typeof recurrence === 'string' ? JSON.parse(recurrence) : recurrence;
  const interval = rule.interval || 1;
  const until = rule.until ? DateTime.fromISO(rule.until, { zone }).endOf('day') : null;
  const ex = new Set(exdates);
  const out = [];
  let produced = 0;
  const maxIter = 5000;

  const push = (occStart) => {
    produced += 1;
    if (rule.count && produced > rule.count) return false;
    if (until && occStart > until) return false;
    const occEnd = occStart.plus({ milliseconds: durationMs });
    if (occStart >= rangeEnd) return false;
    if (occEnd > rangeStart && !ex.has(toUtcIso(occStart))) out.push({ start: occStart, end: occEnd });
    return true;
  };

  if (rule.freq === 'weekly' && rule.byDay?.length) {
    const days = [...rule.byDay].sort();
    let weekStart = s0.startOf('week'); // Monday
    for (let i = 0; i < maxIter; i++) {
      for (const d of days) {
        const occ = weekStart.plus({ days: d - 1 }).set({ hour: s0.hour, minute: s0.minute, second: 0, millisecond: 0 });
        if (occ < s0) continue;
        if (!push(occ)) return out;
      }
      weekStart = weekStart.plus({ weeks: interval });
    }
    return out;
  }

  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[rule.freq];
  for (let i = 0; i < maxIter; i++) {
    const occ = s0.plus({ [unit]: i * interval });
    // Fast-forward cheaply for long-running daily series far before the range.
    if (occ.plus({ milliseconds: durationMs }) <= rangeStart && !rule.count) {
      if (until && occ > until) break;
      continue;
    }
    if (!push(occ)) break;
  }
  return out;
}

/** Next occurrence strictly after `after` for a simple recurrence (used by reminders, tasks, bills). */
export function nextOccurrence(fromIso, recurrence, zone, after = DateTime.now()) {
  const rule = typeof recurrence === 'string' ? JSON.parse(recurrence) : recurrence;
  if (!rule) return null;
  const occs = expandRecurrence({ start: fromIso, end: fromIso, recurrence: { ...rule, count: undefined } }, after, after.plus({ years: 2 }), zone);
  const next = occs.find((o) => o.start > after);
  if (!next) return null;
  if (rule.until && next.start > DateTime.fromISO(rule.until, { zone }).endOf('day')) return null;
  return next.start;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export { Interval };
