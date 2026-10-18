import { db, nowIso } from './db.js';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { DateTime, toUtcIso, atTime } from './services/time.js';
import { listOccurrences } from './services/events.js';
import { fireReminder, notify } from './services/reminders.js';
import { upcomingBills, formatMoney } from './services/finance.js';
import { briefing } from './services/planning.js';

let timer = null;
let running = false;
export const schedulerState = { enabled: false, lastRunAt: null, lastError: null, runs: 0 };

/**
 * One scheduler pass. Runs on the server (not in the browser), so reminders are
 * delivered as in-app notifications whether or not a JARVIS tab is open.
 * Every notification has a dedupe key, so repeated passes never double-notify.
 */
export function runOnce(now = DateTime.utc()) {
  const nowIsoStr = toUtcIso(now);
  // 1. Explicit reminders that are due.
  const due = db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at LIMIT 500").all(nowIsoStr);
  for (const r of due) fireReminder(r, now);

  // 2. Per-user derived notifications.
  for (const { id: userId } of db.prepare('SELECT id FROM users').all()) {
    const s = getSettings(userId);
    const local = now.setZone(s.timezone);
    const today = local.toISODate();

    for (const e of listOccurrences(userId, nowIsoStr, toUtcIso(now.plus({ hours: 24 })))) {
      if (e.all_day) continue;
      const lead = e.reminder_minutes ?? s.notifications.eventLeadMinutes;
      const start = DateTime.fromISO(e.start, { zone: 'utc' });
      if (now >= start.minus({ minutes: lead }) && now < start) {
        const mins = Math.max(0, Math.round(start.diff(now, 'minutes').minutes));
        notify(userId, { kind: 'event', title: `${e.title} ${mins <= 1 ? 'is starting' : `in ${mins} min`}`, body: `${start.setZone(s.timezone).toFormat('h:mm a')}${e.location ? ` · ${e.location}` : ''}`, link: '#/calendar', dedupe_key: `event:${e.id}:${e.start}` });
      }
    }

    for (const b of upcomingBills(userId, s.notifications.billLeadDays)) {
      const when = b.days_until_due < 0 ? `overdue by ${-b.days_until_due} day${b.days_until_due < -1 ? 's' : ''}` : b.days_until_due === 0 ? 'due today' : `due in ${b.days_until_due} day${b.days_until_due > 1 ? 's' : ''}`;
      notify(userId, { kind: 'bill', title: `${b.name} ${when}`, body: `${formatMoney(b.amount_minor, s.currency, s.locale)}${b.autopay ? ' · autopay' : ''}. JARVIS does not pay bills — mark it paid once you have.`, link: '#/finance', dedupe_key: `bill:${b.id}:${b.due_date}:${today}` });
    }

    const briefingAt = atTime(local.startOf('day'), s.notifications.dailyBriefingTime);
    const inBriefingWindow = local >= briefingAt && local < briefingAt.plus({ hours: 3 });
    if (inBriefingWindow && (s.notifications.dailyBriefing || s.notifications.overdueDigest)) {
      const b = briefing(userId, today);
      if (s.notifications.dailyBriefing) {
        notify(userId, { kind: 'briefing', title: 'Your daily briefing is ready', body: `${b.events.length} events, ${b.due_today.length} tasks due, ${b.overdue.length} overdue. ${b.suggestions[0] || ''}`.trim(), link: '#/overview', dedupe_key: `briefing:${today}` });
      }
      if (s.notifications.overdueDigest && b.overdue.length) {
        notify(userId, { kind: 'overdue', title: `${b.overdue.length} overdue task${b.overdue.length > 1 ? 's' : ''}`, body: b.overdue.slice(0, 3).map((t) => t.title).join(', '), link: '#/tasks', dedupe_key: `overdue:${today}` });
      }
    }
  }

  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return { reminders_fired: due.length };
}

export function startScheduler() {
  if (!config.scheduler.enabled || timer) return;
  schedulerState.enabled = true;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runOnce();
      schedulerState.lastRunAt = nowIso();
      schedulerState.lastError = null;
      schedulerState.runs += 1;
    } catch (e) {
      schedulerState.lastError = e.message;
      console.error('[scheduler]', e);
    } finally {
      running = false;
    }
  };
  tick();
  timer = setInterval(tick, config.scheduler.intervalMs);
  timer.unref?.();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
  schedulerState.enabled = false;
}
