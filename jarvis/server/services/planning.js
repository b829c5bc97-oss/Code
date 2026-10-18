import { z } from 'zod';
import { db, tx, audit } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime, toUtcIso, atTime, dayBounds } from './time.js';
import { listOccurrences, createEvent, findConflicts } from './events.js';
import { listTasks, scoreTask, prioritize, getTaskRow, updateTask, workloadSummary } from './tasks.js';
import { listReminders } from './reminders.js';
import { upcomingBills, budgetStatus } from './finance.js';
import { listNotes } from './notes.js';
import { HttpError } from '../http.js';

const toMin = (ms) => Math.round(ms / 60000);

function subtract(windows, busy) {
  let out = windows;
  for (const b of busy) {
    const next = [];
    for (const w of out) {
      if (b.end <= w.start || b.start >= w.end) { next.push(w); continue; }
      if (b.start > w.start) next.push({ start: w.start, end: b.start });
      if (b.end < w.end) next.push({ start: b.end, end: w.end });
    }
    out = next;
  }
  return out;
}

/** Open windows for one local day according to preferences, before removing busy time. */
function dayWindows(day, s, workingHoursOnly) {
  const isWorkday = s.workingHours.days.includes(day.weekday);
  if (workingHoursOnly && !isWorkday) return [];
  const startT = workingHoursOnly ? s.workingHours.start : s.dailySchedule.wake;
  const endT = workingHoursOnly ? s.workingHours.end : s.dailySchedule.sleep;
  const start = atTime(day, startT);
  const end = atTime(day, endT);
  return end > start ? [{ start, end }] : [];
}

/**
 * Free slots between from/to (UTC ISO) of at least `duration` minutes, honouring
 * working hours (or waking hours), lunch, a buffer around events, and "not in the past".
 */
export function freeSlots(userId, fromIso, toIso, { duration = 30, workingHoursOnly = true, respectLunch = true, buffer } = {}) {
  const s = getSettings(userId);
  const zone = s.timezone;
  const from = DateTime.fromISO(fromIso, { zone: 'utc' }).setZone(zone);
  const to = DateTime.fromISO(toIso, { zone: 'utc' }).setZone(zone);
  if (!(to > from)) throw new HttpError(400, 'Range end must be after the start.');
  if (to.diff(from, 'days').days > 62) throw new HttpError(400, 'Search at most 62 days at a time.');
  const buf = buffer ?? s.dailySchedule.bufferMinutes;
  const events = listOccurrences(userId, toUtcIso(from), toUtcIso(to)).filter((e) => !e.all_day);
  const busy = events.map((e) => ({
    start: DateTime.fromISO(e.start, { zone: 'utc' }).setZone(zone).minus({ minutes: buf }),
    end: DateTime.fromISO(e.end, { zone: 'utc' }).setZone(zone).plus({ minutes: buf }),
  }));
  const now = DateTime.now().setZone(zone);
  const slots = [];
  for (let day = from.startOf('day'); day < to; day = day.plus({ days: 1 })) {
    let windows = dayWindows(day, s, workingHoursOnly);
    if (respectLunch) windows = subtract(windows, [{ start: atTime(day, s.dailySchedule.lunchStart), end: atTime(day, s.dailySchedule.lunchEnd) }]);
    windows = subtract(windows, busy);
    for (const w of windows) {
      // Round starts up to the next 5 minutes so suggestions look sensible.
      let st = w.start < from ? from : w.start;
      if (st < now) st = now;
      const rem = st.minute % 5;
      if (rem || st.second) st = st.plus({ minutes: 5 - rem }).set({ second: 0, millisecond: 0 });
      const en = w.end > to ? to : w.end;
      if (toMin(en - st) >= duration) slots.push({ start: toUtcIso(st), end: toUtcIso(en), minutes: toMin(en - st) });
    }
  }
  return slots;
}

function inFocus(slotStart, slotEnd, s) {
  return s.focusPeriods.some((f) => slotStart < atTime(slotStart.startOf('day'), f.end) && slotEnd > atTime(slotStart.startOf('day'), f.start));
}

/**
 * Propose time blocks for open tasks on a given day. Nothing is saved:
 * the user (or assistant, with approval) applies the plan via applyPlan().
 */
export function planDay(userId, date, { taskIds, maxBlockMinutes = 120 } = {}) {
  const s = getSettings(userId);
  const zone = s.timezone;
  const { start: dayStart, end: dayEnd } = dayBounds(date, zone);
  const events = listOccurrences(userId, toUtcIso(dayStart), toUtcIso(dayEnd));
  const scheduledTaskIds = new Set(
    db.prepare("SELECT task_id FROM events WHERE user_id = ? AND task_id IS NOT NULL AND end_at > ?").all(userId, toUtcIso(DateTime.utc())).map((r) => r.task_id),
  );
  const doneIds = new Set(db.prepare("SELECT id FROM tasks WHERE user_id = ? AND status = 'done'").all(userId).map((r) => r.id));
  let candidates = listTasks(userId, { status: 'open' }).filter((t) => !t.archived);
  if (taskIds) {
    const want = new Set(taskIds);
    candidates = candidates.filter((t) => want.has(t.id));
  } else {
    const horizon = toUtcIso(dayEnd.plus({ days: 2 }));
    candidates = candidates.filter((t) => !scheduledTaskIds.has(t.id) && ((t.due && t.due <= horizon) || ['urgent', 'high'].includes(t.priority) || t.status === 'in_progress'));
  }
  const now = DateTime.utc();
  candidates.sort((a, b) => scoreTask(b, now) - scoreTask(a, now));

  const busy = events.filter((e) => !e.all_day).map((e) => ({ start: DateTime.fromISO(e.start, { zone: 'utc' }).setZone(zone), end: DateTime.fromISO(e.end, { zone: 'utc' }).setZone(zone) }));
  const isWorkday = s.workingHours.days.includes(dayStart.weekday);
  let windows = freeSlots(userId, toUtcIso(dayStart), toUtcIso(dayEnd), { duration: 15, workingHoursOnly: isWorkday })
    .map((w) => ({ start: DateTime.fromISO(w.start, { zone: 'utc' }).setZone(zone), end: DateTime.fromISO(w.end, { zone: 'utc' }).setZone(zone) }));
  const capacity = windows.reduce((m, w) => m + toMin(w.end - w.start), 0);
  const buf = s.dailySchedule.bufferMinutes;

  const blocks = [];
  const unscheduled = [];
  for (const t of candidates) {
    const waiting = t.depends_on.filter((d) => !doneIds.has(d));
    if (waiting.length) { unscheduled.push({ task_id: t.id, title: t.title, reason: `waiting on ${waiting.length} unfinished dependenc${waiting.length > 1 ? 'ies' : 'y'}` }); continue; }
    if (t.status === 'blocked') { unscheduled.push({ task_id: t.id, title: t.title, reason: 'marked blocked' }); continue; }
    const need = Math.min(t.estimate_minutes || 60, maxBlockMinutes);
    const wantsFocus = ['urgent', 'high'].includes(t.priority) || t.important;
    const fits = windows.map((w, i) => ({ w, i })).filter(({ w }) => toMin(w.end - w.start) >= need);
    if (!fits.length) { unscheduled.push({ task_id: t.id, title: t.title, reason: `no free ${need}-minute slot left` }); continue; }
    const pick = (wantsFocus && fits.find(({ w }) => inFocus(w.start, w.start.plus({ minutes: need }), s))) || fits[0];
    const st = pick.w.start;
    const en = st.plus({ minutes: need });
    blocks.push({
      task_id: t.id, title: t.title, start: toUtcIso(st), end: toUtcIso(en), minutes: need,
      partial: (t.estimate_minutes || 60) > need,
      reason: [t.due && t.due < toUtcIso(now) ? 'overdue' : t.due ? `due ${DateTime.fromISO(t.due).setZone(zone).toFormat('ccc d LLL')}` : null, `${t.priority} priority`, inFocus(st, en, s) ? 'in a focus period' : null].filter(Boolean).join(', '),
    });
    const rest = [];
    if (en.plus({ minutes: buf }) < pick.w.end) rest.push({ start: en.plus({ minutes: buf }), end: pick.w.end });
    windows.splice(pick.i, 1, ...rest);
  }
  const meetingMinutes = busy.reduce((m, b) => m + toMin(b.end - b.start), 0);
  const planned = blocks.reduce((m, b) => m + b.minutes, 0);
  const warnings = [];
  if (unscheduled.some((u) => u.reason.startsWith('no free'))) warnings.push('Not all priority tasks fit into your free time on this day.');
  if (meetingMinutes > 6 * 60) warnings.push(`You have ${Math.round(meetingMinutes / 60)}h of events on this day — consider moving something.`);
  if (!isWorkday) warnings.push('This is not one of your working days, so blocks were planned within your waking hours instead.');
  blocks.sort((a, b) => a.start.localeCompare(b.start));
  return {
    kind: 'proposal', saved: false, date, timezone: zone,
    events: events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, kind: e.kind, all_day: e.all_day })),
    blocks, unscheduled, free_minutes: capacity, planned_minutes: planned, meeting_minutes: meetingMinutes,
    overloaded: unscheduled.some((u) => u.reason.startsWith('no free')), warnings,
  };
}

export const applyPlanInput = z.object({
  blocks: z.array(z.object({ task_id: z.string(), start: z.string(), end: z.string(), title: z.string().optional() })).min(1).max(40),
  set_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Also move the tasks due date to this day'),
});

/** Persist proposed blocks as task_block events. Re-checks conflicts at save time. */
export function applyPlan(userId, raw, { actor = 'user' } = {}) {
  const { blocks, set_due_date } = applyPlanInput.parse(raw);
  const created = [];
  const skipped = [];
  tx(() => {
    for (const b of blocks) {
      const task = getTaskRow(userId, b.task_id);
      const conflicts = findConflicts(userId, b.start, b.end);
      if (conflicts.length) { skipped.push({ task_id: b.task_id, title: task.title, reason: `conflicts with "${conflicts[0].title}"` }); continue; }
      const r = createEvent(userId, { title: task.title, start: b.start, end: b.end, kind: 'task_block', task_id: task.id, description: 'Time block planned by JARVIS', reminder_minutes: 5 }, { actor });
      created.push(r.event);
      if (set_due_date) updateTask(userId, task.id, { due: set_due_date }, { actor });
    }
  });
  audit(userId, actor, 'apply_plan', 'event', null, `${created.length} blocks`);
  return { created, skipped };
}

/** Propose moving unfinished work (due on/before `fromDate`, or blocked out that day) to `toDate`. */
export function rescheduleUnfinished(userId, fromDate, toDate) {
  const zone = getSettings(userId).timezone;
  const { end: fromEnd, start: fromStart } = dayBounds(fromDate, zone);
  const due = listTasks(userId, { status: 'open', due_before: toUtcIso(fromEnd) });
  const blockTaskIds = db.prepare("SELECT DISTINCT task_id FROM events WHERE user_id = ? AND kind = 'task_block' AND task_id IS NOT NULL AND start_at >= ? AND start_at < ?")
    .all(userId, toUtcIso(fromStart), toUtcIso(fromEnd)).map((r) => r.task_id);
  const ids = new Set([...due.map((t) => t.id), ...blockTaskIds]);
  const open = listTasks(userId, { status: 'open' }).filter((t) => ids.has(t.id));
  if (!open.length) return { kind: 'proposal', saved: false, date: toDate, blocks: [], unscheduled: [], tasks_considered: 0, message: 'No unfinished tasks found for that day.' };
  const plan = planDay(userId, toDate, { taskIds: open.map((t) => t.id) });
  return { ...plan, from_date: fromDate, tasks_considered: open.length, suggest_due_date: toDate };
}

function overlapsWithin(events) {
  const timed = events.filter((e) => !e.all_day).sort((a, b) => a.start.localeCompare(b.start));
  const out = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) out.push([timed[i].title, timed[j].title]);
  }
  return out;
}

/** Deterministic daily briefing built from stored data. */
export function briefing(userId, date) {
  const s = getSettings(userId);
  const zone = s.timezone;
  const day = date || DateTime.now().setZone(zone).toISODate();
  const { start, end } = dayBounds(day, zone);
  const events = listOccurrences(userId, toUtcIso(start), toUtcIso(end));
  const dueToday = listTasks(userId, { status: 'open', due_after: toUtcIso(start), due_before: toUtcIso(end) });
  const overdue = listTasks(userId, { status: 'open', due_before: toUtcIso(start) });
  const quadrants = prioritize(userId);
  const reminders = listReminders(userId, { status: 'active', from: toUtcIso(start), to: toUtcIso(end) });
  const bills = upcomingBills(userId, 7);
  const budgets = budgetStatus(userId).filter((b) => b.status !== 'ok');
  const free = freeSlots(userId, toUtcIso(start), toUtcIso(end), { duration: 30, workingHoursOnly: s.workingHours.days.includes(start.weekday) });
  const conflicts = overlapsWithin(events);

  // Competing deadlines: 3+ open tasks due on the same day in the next 7 days.
  const week = listTasks(userId, { status: 'open', due_after: toUtcIso(start), due_before: toUtcIso(start.plus({ days: 7 })) });
  const byDay = {};
  for (const t of week) {
    const d = DateTime.fromISO(t.due).setZone(zone).toISODate();
    (byDay[d] ||= []).push(t.title);
  }
  const competing = Object.entries(byDay).filter(([, v]) => v.length >= 3).map(([d, v]) => ({ date: d, count: v.length, tasks: v.slice(0, 5) }));

  const meetingMinutes = events.filter((e) => !e.all_day).reduce((m, e) => m + toMin(Date.parse(e.end) - Date.parse(e.start)), 0);
  const freeMinutes = free.reduce((m, f) => m + f.minutes, 0);
  const dueMinutes = dueToday.reduce((m, t) => m + (t.estimate_minutes || 30), 0);
  const suggestions = [];
  if (overdue.length) suggestions.push(`Deal with ${overdue.length} overdue task${overdue.length > 1 ? 's' : ''} first, or reschedule ${overdue.length > 1 ? 'them' : 'it'}.`);
  if (conflicts.length) suggestions.push(`Resolve ${conflicts.length} overlapping event${conflicts.length > 1 ? 's' : ''} ("${conflicts[0][0]}" and "${conflicts[0][1]}").`);
  if (dueMinutes > freeMinutes && dueToday.length) suggestions.push(`Today's due tasks need ~${Math.round(dueMinutes / 60 * 10) / 10}h but you have ~${Math.round(freeMinutes / 60 * 10) / 10}h free. Consider moving lower-priority work.`);
  if (competing.length) suggestions.push(`${competing[0].count} deadlines land on ${DateTime.fromISO(competing[0].date).toFormat('cccc d LLL')}. Start some of them earlier.`);
  for (const b of bills.filter((x) => x.days_until_due <= 2)) suggestions.push(`${b.name} is ${b.days_until_due < 0 ? 'overdue' : b.days_until_due === 0 ? 'due today' : `due in ${b.days_until_due} day${b.days_until_due > 1 ? 's' : ''}`}.`);
  for (const b of budgets.slice(0, 2)) suggestions.push(`${b.category} budget is ${b.status === 'exceeded' ? 'exceeded' : `at ${b.percent_used}%`}.`);
  if (!suggestions.length && quadrants.do_now[0]) suggestions.push(`Start with "${quadrants.do_now[0].title}".`);
  if (!suggestions.length && free.length) suggestions.push(`You have ${Math.round(freeMinutes / 60 * 10) / 10}h of free time — a good day to get ahead.`);

  return {
    date: day, timezone: zone, generated_by: 'rules (from your stored data)',
    events, due_today: dueToday, overdue, top_priorities: quadrants.do_now.slice(0, 5), reminders, upcoming_bills: bills, budgets_at_risk: budgets,
    free_slots: free, free_minutes: freeMinutes, meeting_minutes: meetingMinutes, conflicts, competing_deadlines: competing,
    workload: workloadSummary(userId), suggestions,
  };
}

export function shutdown(userId, date) {
  const zone = getSettings(userId).timezone;
  const day = date || DateTime.now().setZone(zone).toISODate();
  const { start, end } = dayBounds(day, zone);
  const tomorrow = start.plus({ days: 1 }).toISODate();
  const completed = db.prepare("SELECT id, title, completed_at FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at")
    .all(userId, toUtcIso(start), toUtcIso(end));
  const unfinished = listTasks(userId, { status: 'open', due_before: toUtcIso(end) });
  const eventsToday = listOccurrences(userId, toUtcIso(start), toUtcIso(end));
  return {
    date: day, completed, unfinished, events_today: eventsToday.length,
    tomorrow: { date: tomorrow, plan: rescheduleUnfinished(userId, day, tomorrow), briefing: briefing(userId, tomorrow) },
  };
}

/** Context for upcoming meetings: related notes and tasks found by keyword and participants. */
export function meetingPrep(userId, date) {
  const zone = getSettings(userId).timezone;
  const day = date || DateTime.now().setZone(zone).plus({ days: 1 }).toISODate();
  const { start, end } = dayBounds(day, zone);
  const meetings = listOccurrences(userId, toUtcIso(start), toUtcIso(end)).filter((e) => ['meeting', 'work', 'other'].includes(e.kind));
  const stop = new Set(['the', 'and', 'with', 'for', 'meeting', 'call', 'sync', 'weekly', 'daily', 'review', 'team', 'stand', 'standup', 'catch', 'chat', 'a', 'of', 'to', 'on']);
  return {
    date: day,
    meetings: meetings.map((m) => {
      const words = m.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w)).slice(0, 4);
      const hit = (w, text) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, '')}\\b`, 'i').test(text);
      const uniq = (x, i, a) => a.findIndex((y) => y.id === x.id) === i;
      const notes = words.flatMap((w) => listNotes(userId, { query: w, full: true }).filter((n) => hit(w, `${n.title} ${n.content} ${n.tags.join(' ')}`))).filter(uniq).slice(0, 5);
      const tasks = words.flatMap((w) => listTasks(userId, { status: 'open', query: w }).filter((t) => hit(w, `${t.title} ${t.description}`))).filter(uniq).slice(0, 5);
      return { id: m.id, title: m.title, start: m.start, end: m.end, location: m.location, participants: m.participants, description: m.description, related_notes: notes.map((n) => ({ id: n.id, title: n.title, excerpt: n.excerpt })), related_tasks: tasks.map((t) => ({ id: t.id, title: t.title, due: t.due, status: t.status })) };
    }),
  };
}
