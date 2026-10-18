/**
 * Rule-based DEMO assistant used only when no AI provider is configured.
 * It understands a fixed set of phrasings and calls the same validated,
 * permission-checked tools as the real model. Every reply says it is the demo.
 */
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime, toUtcIso, atTime } from '../services/time.js';
import { formatMoney, listCategories } from '../services/finance.js';
import { executeToolCall } from './tools.js';
import { parseWhen, parseDuration, parseMonth, stripPhrases } from './nlp.js';

const DEMO_TAG = '_Demo assistant — no AI model is connected, so I only understand a set of common commands._';

export async function handleDemo(userId, conversationId, rawText) {
  const s = getSettings(userId);
  const zone = s.timezone;
  const now = DateTime.now().setZone(zone);
  const text = rawText.trim();
  const t = text.toLowerCase();
  const actions = [];
  const pending = [];
  const fmt = (minor) => formatMoney(minor, s.currency, s.locale);
  const fmtTime = (iso) => DateTime.fromISO(iso).setZone(zone).toFormat(s.timeFormat === '24h' ? 'HH:mm' : 'h:mm a');
  const fmtDay = (iso) => DateTime.fromISO(iso).setZone(zone).toFormat('ccc d LLL');

  const call = async (name, args) => {
    const r = await executeToolCall(userId, conversationId, name, args);
    if (r.status === 'pending') {
      pending.push(r.pending);
      actions.push({ tool: name, status: 'pending', summary: r.pending.summary, pending_id: r.pending.id });
    } else if ((r.status === 'ok' || r.status === 'conflict') && r.summary) actions.push({ tool: name, status: r.status, summary: r.summary });
    else if (r.status !== 'ok') actions.push({ tool: name, status: r.status, summary: r.error });
    else actions.push({ tool: name, status: 'read', summary: `Looked up ${name.replace(/_/g, ' ')}` });
    return r;
  };
  const reply = (body, data) => ({ text: `${body}\n\n${DEMO_TAG}`, actions, pending, data });
  const fail = (r) => reply(r.status === 'denied' ? r.error : `I couldn't do that: ${r.error}`);
  const when = parseWhen(text, zone, now);
  const dayIso = (when.date || now).toISODate();

  // ---- follow-up: "move that to Friday" ----
  if (/\b(move|reschedule|shift|push) (that|it|this)\b/.test(t) && when.date) {
    const last = lastCreated(userId, conversationId);
    if (!last) return reply('I\'m not sure what "that" refers to. Tell me which event or task to move.');
    if (last.type === 'event') {
      const ev = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(last.id, userId);
      if (!ev) return reply('That event no longer exists.');
      const old = DateTime.fromISO(ev.start_at).setZone(zone);
      const start = when.date.set({ hour: when.time?.hour ?? old.hour, minute: when.time?.minute ?? old.minute });
      const r = await call('update_event', { event_id: ev.id, start: start.toISO({ includeOffset: false }), allow_conflict: false });
      if (r.status === 'conflict') return reply(`${start.toFormat('ccc d LLL, h:mm a')} overlaps ${r.result.conflicts.map((c) => `"${c.title}"`).join(', ')}, so I left it where it is. Pick another time.`);
      if (r.status !== 'ok') return fail(r);
      return reply(`Moved **${ev.title}** to ${fmtDay(r.result.event.start)} at ${fmtTime(r.result.event.start)}.`);
    }
    const r = await call('update_task', { task_id: last.id, due: when.date.toISODate() });
    return r.status === 'ok' ? reply(`Moved the due date of **${r.result.task.title}** to ${when.date.toFormat('cccc d LLL')}.`) : fail(r);
  }

  // ---- help ----
  if (/^(help|what can you do|commands)\s*[?!.]*$/.test(t)) {
    return reply(['Try:', '- "What\'s next on my calendar?"', '- "What do I need to finish today?"', '- "Plan my day" / "Plan tomorrow"', '- "Schedule a meeting with Priya tomorrow at 3pm"', '- "Schedule two hours for my project tomorrow afternoon"', '- "Create a task to renew passport by Friday"', '- "Remind me to pay the electricity bill on 25 Oct at 9am"', '- "How much did I spend on food this month?"', '- "Compare my spending this month with last month"', '- "Am I close to exceeding my transport budget?"', '- "Upcoming bills"', '- "Organise my tasks by urgency and importance"', '- "Move my unfinished tasks to tomorrow"', '- "Give me a summary of my day"', '- "Prepare me for tomorrow\'s meetings"', '- "Find a free slot for a meeting next week"'].join('\n'));
  }

  // ---- email ----
  if (/\b(email|emails|inbox|mail)\b/.test(t)) {
    const r = await call('list_emails', { unread_only: true, max: 10 });
    if (r.status !== 'ok') return reply(`${r.error}\n\nI won't invent an inbox: once Gmail or Outlook is connected I can list unread messages; a connected AI model is needed for real summaries.`);
    const msgs = r.result.messages;
    if (!msgs.length) return reply('No unread messages in your connected inbox.');
    return reply(`Unread messages (${r.result.provider}):\n${msgs.map((m) => `- ${m.important ? '⭐ ' : ''}**${m.subject || '(no subject)'}** — ${m.from}`).join('\n')}\n\nConnect an AI model for summaries and action-item extraction.`);
  }

  // ---- finance ----
  if (/\b(budget|overspend|exceed)/.test(t)) {
    const r = await call('budget_status', {});
    if (r.status !== 'ok') return fail(r);
    let list = r.result.budgets;
    const cat = matchCategory(userId, t);
    if (cat) list = list.filter((b) => b.category === cat.name);
    if (!list.length) return reply(cat ? `You haven't set a budget for ${cat.name}. Add one under Finance → Budgets.` : 'You have no budgets yet. Add one under Finance → Budgets.');
    return reply(list.map((b) => `- **${b.category}**: ${fmt(b.spent_minor)} of ${fmt(b.budget_minor)} (${b.percent_used}%) — ${b.status === 'exceeded' ? 'exceeded' : b.status === 'at_risk' ? 'at risk' : 'on track'}${b.projected_minor != null ? `; forecast for the month ≈ ${fmt(b.projected_minor)} (straight-line estimate)` : ''}`).join('\n'), { budgets: list });
  }
  if (/\bbills?\b|\bsubscriptions?\b|\bdue payments?\b/.test(t) && !/remind/.test(t)) {
    const r = await call('upcoming_bills', { days: 30 });
    if (r.status !== 'ok') return fail(r);
    if (!r.result.bills.length) return reply('No unpaid bills due in the next 30 days.');
    return reply(`Unpaid bills in the next 30 days (scheduled amounts, not recorded spending):\n${r.result.bills.map((b) => `- **${b.name}** ${fmt(b.amount_minor)} — ${b.days_until_due < 0 ? `overdue by ${-b.days_until_due}d` : b.days_until_due === 0 ? 'due today' : `due ${DateTime.fromISO(b.due_date).toFormat('ccc d LLL')}`}`).join('\n')}`);
  }
  if (/\bcompare\b.*\b(spend|spending|expenses)\b|\b(spend|spending)\b.*\bcompare/.test(t)) {
    const a = now.startOf('month');
    const b = a.minus({ months: 1 });
    const r = await call('compare_spending', { a_from: a.toISODate(), a_to: now.toISODate(), b_from: b.toISODate(), b_to: b.plus({ days: now.day - 1 }).toISODate() });
    if (r.status !== 'ok') return fail(r);
    const x = r.result;
    const lines = x.by_category.slice(0, 6).map((c) => `- ${c.name}: ${fmt(c.a)} vs ${fmt(c.b)}${c.change_pct != null ? ` (${c.change_pct > 0 ? '+' : ''}${c.change_pct}%)` : ''}`);
    return reply(`Spending ${a.toFormat('LLLL')} 1–${now.day}: **${fmt(x.period_a.expense_minor)}** vs the same days of ${b.toFormat('LLLL')}: **${fmt(x.period_b.expense_minor)}**${x.expense_change_pct != null ? ` (${x.expense_change_pct > 0 ? '+' : ''}${x.expense_change_pct}%)` : ''}.\n${lines.join('\n')}\n\nBased on recorded transactions only.`);
  }
  if (/\b(spend|spent|spending|expenses?|expense categories|where did my money)\b/.test(t)) {
    const month = parseMonth(t, zone, now) || now.startOf('month');
    const from = month.toISODate();
    const to = month.endOf('month').toISODate();
    const r = await call('finance_summary', { from, to });
    if (r.status !== 'ok') return fail(r);
    const x = r.result;
    const cat = matchCategory(userId, t);
    const label = month.toFormat('LLLL yyyy');
    if (!x.expense_count) return reply(`I have no recorded expenses for ${label}. Add transactions or import a CSV in Finance.`);
    if (cat) {
      const c = x.by_category.find((y) => y.category_id === cat.id);
      return reply(`You spent **${fmt(c?.total || 0)}** on ${cat.name} in ${label}${c ? ` across ${c.n} transaction${c.n > 1 ? 's' : ''} (${c.share}% of spending)` : ''}.\n\nBased on recorded transactions only.`);
    }
    return reply(`In ${label} you spent **${fmt(x.expense_minor)}** and received **${fmt(x.income_minor)}** (net ${fmt(x.net_minor)}).\n\nBiggest categories:\n${x.by_category.slice(0, 5).map((c) => `- ${c.name}: ${fmt(c.total)} (${c.share}%)`).join('\n')}\n\nBased on ${x.expense_count + x.income_count} recorded transactions.`, { summary: x });
  }

  // ---- reminders ----
  if (/^remind me\b/.test(t)) {
    let title = stripPhrases(text.replace(/^remind me (to |about )?/i, ''), when.matched).replace(/\s+(before|by|on|at|ahead of)?\s*(the|its|my)?\s*(due date|deadline)\s*$/i, '').replace(/\s+(on|at|by|before)\s*$/i, '').trim();
    if (!title) return reply('What should I remind you about?');
    let day = when.date;
    let note = '';
    const bill = matchBill(userId, t);
    if (!day && bill) { day = DateTime.fromISO(bill.due_date, { zone }); note = ` — ${bill.name} is due ${day.toFormat('ccc d LLL')}`; }
    if (!day && !when.time) return reply(`When should I remind you to "${title}"? (e.g. "tomorrow at 9am")`);
    day = day || now;
    let at = day.set({ hour: when.time?.hour ?? (when.part === 'afternoon' ? 14 : when.part === 'evening' ? 19 : 9), minute: when.time?.minute ?? 0 });
    if (/\bbefore\b/.test(t) && !when.time) {
      const dayBefore = at.minus({ days: 1 });
      if (dayBefore > now) { at = dayBefore; note += ' (one day before, at 9 AM)'; } else note += ' (on the day, at 9 AM — the day before has passed)';
    }
    if (at < now && !when.time && day.hasSame(now, 'day')) at = now.plus({ hours: 1 }).startOf('hour');
    if (at < now) return reply('That time has already passed. Pick a time in the future.');
    title = title.charAt(0).toUpperCase() + title.slice(1);
    const r = await call('create_reminder', { title, remind_at: at.toISO({ includeOffset: false }) });
    if (r.status === 'pending') return reply(`I've prepared a reminder "${title}" for ${at.toFormat('ccc d LLL, h:mm a')}${note}. Approve it below.`);
    return r.status === 'ok' ? reply(`Reminder set: **${title}** on ${at.toFormat('cccc d LLL, h:mm a')}${note}. The server delivers it as an in-app notification even if this page is closed.`) : fail(r);
  }

  // ---- goal → project plan (template, not AI) ----
  if ((/^help me\b|\bbreak (it|this|.+) (down|into)\b|\binto smaller tasks\b|\bproject plan\b/.test(t)) && !/\b(my day|tomorrow's meetings|budget|spend)\b/.test(t)) {
    const deadline = (when.date && when.date > now ? when.date : now.plus({ days: 14 })).startOf('day');
    let goal = stripPhrases(text, when.matched).replace(/^help me( to)?\s*/i, '').replace(/\b(break (it|this) (down|into)|into smaller tasks|organi[sz]e this project|and show me.*$|by\s*$|in\s*$)\b/gi, '').replace(/[.?!]+$/, '').trim();
    if (!goal || goal.length < 3) return reply('What goal should I break down? For example: "Help me launch a website in two weeks".');
    goal = goal.charAt(0).toUpperCase() + goal.slice(1);
    const span = Math.max(3, Math.round(deadline.diff(now.startOf('day'), 'days').days));
    const at = (f) => now.startOf('day').plus({ days: Math.max(1, Math.round(span * f)) }).toISODate();
    const phases = [
      ['Define scope', 0.1, ['Write down the goal, success criteria and constraints', 'List what is in and out of scope']],
      ['Plan & prepare', 0.3, ['Break the work into concrete deliverables', 'Gather materials, tools and information needed', 'Identify risks and who you depend on']],
      ['Do the work', 0.75, ['Complete the first deliverable', 'Complete the remaining deliverables', 'Mid-point check: compare progress with the deadline']],
      ['Review & refine', 0.9, ['Review everything against the success criteria', 'Fix issues and polish']],
      ['Finish & deliver', 1, ['Final check and delivery', 'Short retrospective: what to repeat or avoid']],
    ];
    let prev = null;
    let k = 0;
    const milestones = phases.map(([title, f, tasks]) => ({
      title, due_date: at(f),
      tasks: tasks.map((tt, i) => {
        k += 1;
        const task = { key: `t${k}`, title: tt, due: at(f), estimate_minutes: 60, priority: f >= 0.9 ? 'high' : 'medium', depends_on: prev ? [prev] : [] };
        if (i === tasks.length - 1) prev = `t${k}`;
        else if (i === 0 && prev) task.depends_on = [prev];
        return task;
      }),
    }));
    const r = await call('create_project_plan', { project: { name: goal.slice(0, 200), description: `Template plan generated by the demo assistant for: ${goal}. Edit tasks to fit your project.`, deadline: deadline.toISODate(), start_date: now.toISODate(), status: 'planning' }, milestones });
    if (r.status !== 'pending' && r.status !== 'ok') return fail(r);
    return reply(`Here's a **generic template** plan for "${goal}" by ${deadline.toFormat('cccc d LLL')} — five stages with ${k} tasks and dependencies. Without an AI model I can't tailor the tasks to your specific goal, so treat it as a starting point and edit the tasks after saving.\n\nReview the plan below and approve to create the project.`);
  }

  // ---- planning ----
  if (/\b(move|reschedule|carry over|push)\b.*\b(unfinished|incomplete|remaining|leftover)\b/.test(t)) {
    const to = when.date && when.date.toISODate() !== now.toISODate() ? when.date : now.plus({ days: 1 });
    const r = await call('reschedule_unfinished', { from_date: now.toISODate(), to_date: to.toISODate() });
    if (r.status !== 'ok') return fail(r);
    return proposePlan(r.result, `Here's where your unfinished tasks could go on ${to.toFormat('cccc d LLL')}:`, to.toISODate());
  }
  if (/\bplan\b.*\b(my day|today|tomorrow|the day|my week)\b|^plan\b|\b(schedule|organi[sz]e) my day\b|\bsuggest(ed)? (a )?schedule\b/.test(t)) {
    const r = await call('plan_day', { date: dayIso });
    if (r.status !== 'ok') return fail(r);
    return proposePlan(r.result, `Suggested plan for ${DateTime.fromISO(dayIso).toFormat('cccc d LLL')}:`);
  }
  if (/\b(prioriti[sz]e|organi[sz]e|sort)\b.*\btasks\b|\burgency and importance\b/.test(t)) {
    const r = await call('prioritize_tasks', {});
    if (r.status !== 'ok') return fail(r);
    const q = r.result;
    const sec = (label, items) => (items.length ? `**${label}**\n${items.slice(0, 6).map((i) => `- ${i.title}${i.overdue ? ' (overdue)' : i.due ? ` (due ${fmtDay(i.due)})` : ''}${i.waiting_on ? ' — waiting on dependencies' : ''}`).join('\n')}` : null);
    const body = [sec('Do now (urgent + important)', q.do_now), sec('Schedule (important, not urgent)', q.schedule), sec('Batch or delegate (urgent, less important)', q.delegate_or_batch), sec('Later', q.drop_or_later)].filter(Boolean).join('\n\n');
    return reply(body || 'You have no open tasks.', { quadrants: q });
  }
  if (/\b(summary of my day|shutdown|end of (the )?day|wrap up|day summary)\b/.test(t)) {
    const r = await call('get_shutdown_summary', {});
    if (r.status !== 'ok') return fail(r);
    const x = r.result;
    const out = [`**Completed today (${x.completed.length})**`, ...(x.completed.length ? x.completed.map((c) => `- ${c.title}`) : ['- Nothing marked done yet.']),
      `\n**Still open (${x.unfinished.length})**`, ...x.unfinished.slice(0, 8).map((u) => `- ${u.title}`)];
    const res = proposePlan(x.tomorrow.plan, `${out.join('\n')}\n\n**Plan for tomorrow**`, x.tomorrow.date);
    return res;
  }
  if (/\b(prepare|prep|ready)\b.*\bmeetings?\b/.test(t)) {
    const r = await call('meeting_prep', { date: (when.date || now.plus({ days: 1 })).toISODate() });
    if (r.status !== 'ok') return fail(r);
    if (!r.result.meetings.length) return reply(`No meetings on ${DateTime.fromISO(r.result.date).toFormat('cccc d LLL')}.`);
    return reply(r.result.meetings.map((m) => [`**${fmtTime(m.start)} ${m.title}**${m.location ? ` · ${m.location}` : ''}`, m.participants.length ? `  With: ${m.participants.join(', ')}` : null, m.description ? `  Agenda: ${m.description}` : null,
      m.related_notes.length ? `  Related notes: ${m.related_notes.map((n) => n.title).join('; ')}` : null, m.related_tasks.length ? `  Open tasks: ${m.related_tasks.map((x) => x.title).join('; ')}` : null].filter(Boolean).join('\n')).join('\n\n'));
  }
  if (/\b(free|available|open)\b.*\b(slot|time|window)\b|\bwhen am i free\b/.test(t)) {
    const duration = parseDuration(t) || (/meeting/.test(t) ? 60 : 30);
    let from = when.date || now;
    let to = from.plus({ days: 1 });
    if (/next week/.test(t)) { from = now.plus({ weeks: 1 }).startOf('week'); to = from.plus({ days: 7 }); }
    else if (/this week/.test(t)) { from = now; to = now.endOf('week'); }
    const r = await call('find_free_slots', { from: from.toISO({ includeOffset: false }), to: to.toISO({ includeOffset: false }), duration_minutes: duration });
    if (r.status !== 'ok') return fail(r);
    if (!r.result.slots.length) return reply(`I couldn't find a free ${duration}-minute slot in your working hours for that period.`);
    return reply(`Free slots of at least ${duration} minutes (within working hours):\n${r.result.slots.slice(0, 6).map((sl) => `- ${fmtDay(sl.start)}, ${fmtTime(sl.start)}–${fmtTime(sl.end)}`).join('\n')}`);
  }

  // ---- calendar ----
  if (/\b(what'?s|what is) next\b|\bnext (meeting|event)\b|\bnext on my calendar\b/.test(t)) {
    const r = await call('list_events', { from: now.toISO({ includeOffset: false }), to: now.plus({ days: 14 }).toISO({ includeOffset: false }) });
    if (r.status !== 'ok') return fail(r);
    const next = r.result.events.find((e) => e.end > toUtcIso(now));
    if (!next) return reply('Nothing on your calendar in the next two weeks.');
    const started = next.start <= toUtcIso(now);
    return reply(`${started ? 'Happening now' : 'Next up'}: **${next.title}** — ${fmtDay(next.start)}, ${fmtTime(next.start)}–${fmtTime(next.end)}${next.location ? ` at ${next.location}` : ''}.`);
  }
  if (/\b(schedule|book|add|create|set up|block)\b/.test(t) && /\b(meeting|event|call|appointment|session|block|hours?|minutes|lunch|dinner|focus|study)\b/.test(t) && !/\btask\b/.test(t)) {
    const duration = parseDuration(t) || 60;
    const kind = /\bfocus|deep work\b/.test(t) ? 'focus' : /\bstudy\b/.test(t) ? 'study' : /\b(hours?|block)\b.*\bproject\b|\bproject\b/.test(t) ? 'work' : /\b(lunch|dinner|gym|doctor|personal)\b/.test(t) ? 'personal' : 'meeting';
    let title = stripPhrases(text, when.matched)
      .replace(/^(please\s+)?(schedule|book|add|create|set up|block)( out)?\s+(a |an |me |some )?/i, '')
      .replace(/\b(for )?(\d+(\.\d+)?|one|two|three|four|half an?|an?)\s*(hours?|hrs?|minutes?|mins?)( for)?\b/i, '')
      .replace(/\b(on|at|for)\s*$/i, '').replace(/\s+/g, ' ').trim();
    title = title.replace(/^(for|on)\s+/i, '').replace(/\s*\banyway\b\s*/i, ' ').trim();
    if (/^(meeting|event|call)$/i.test(title)) title = title.charAt(0).toUpperCase() + title.slice(1);
    if (!title) title = kind === 'work' ? 'Project work' : 'Meeting';
    title = title.charAt(0).toUpperCase() + title.slice(1);
    if (!when.date && !when.time && !when.part) return reply(`When should I schedule "${title}"? (e.g. "tomorrow at 3pm")`);
    const day = when.date || now;
    if (!when.time) {
      // Find the first free slot in the requested part of the day.
      const ranges = { morning: ['08:00', '12:00'], afternoon: ['12:00', '17:00'], evening: ['17:00', '21:00'] };
      const [a, b] = ranges[when.part] || [s.workingHours.start, s.workingHours.end];
      const r = await call('find_free_slots', { from: atTime(day, a).toISO({ includeOffset: false }), to: atTime(day, b).toISO({ includeOffset: false }), duration_minutes: duration, working_hours_only: false });
      if (r.status !== 'ok') return fail(r);
      const slot = r.result.slots[0];
      if (!slot) return reply(`There's no free ${duration}-minute slot ${when.part ? `in the ${when.part}` : ''} on ${day.toFormat('cccc d LLL')}. Want me to look at another day?`);
      const c = await call('create_event', { title, start: slot.start, duration_minutes: duration, kind, reminder_minutes: s.notifications.eventLeadMinutes });
      if (c.status === 'pending') return reply(`The first free ${duration}-minute slot is ${fmtTime(slot.start)}. Approve below to book **${title}**.`);
      if (c.status !== 'ok') return fail(c);
      return reply(`Booked **${title}** on ${fmtDay(c.result.event.start)}, ${fmtTime(c.result.event.start)}–${fmtTime(c.result.event.end)} — the first free slot${when.part ? ` that ${when.part}` : ''}.`);
    }
    const start = day.set({ hour: when.time.hour, minute: when.time.minute });
    if (start < now) return reply('That time has already passed. Pick a time in the future.');
    const c = await call('create_event', { title, start: start.toISO({ includeOffset: false }), duration_minutes: duration, kind, reminder_minutes: s.notifications.eventLeadMinutes, allow_conflict: /\banyway\b/.test(t) });
    if (c.status === 'pending') return reply(`I've prepared **${title}** for ${start.toFormat('ccc d LLL, h:mm a')}. Approve it below.`);
    if (c.status === 'conflict') {
      return reply(`${start.toFormat('ccc d LLL, h:mm a')} overlaps ${c.result.conflicts.map((x) => `**${x.title}** (${fmtTime(x.start)}–${fmtTime(x.end)})`).join(', ')}. I haven't booked it. Add "anyway" to book it regardless, or ask me to find a free slot.`);
    }
    if (c.status !== 'ok') return fail(c);
    return reply(`Booked **${title}** on ${start.toFormat('cccc d LLL')}, ${fmtTime(c.result.event.start)}–${fmtTime(c.result.event.end)}.`);
  }
  if (/\b(calendar|agenda|meetings?|events?|schedule)\b/.test(t) && /\b(today|tomorrow|this week|my)\b/.test(t)) {
    const from = when.date || now.startOf('day');
    const to = /this week/.test(t) ? now.endOf('week') : from.endOf('day');
    const r = await call('list_events', { from: from.toISO({ includeOffset: false }), to: to.toISO({ includeOffset: false }) });
    if (r.status !== 'ok') return fail(r);
    if (!r.result.events.length) return reply('No events in that period.');
    return reply(r.result.events.map((e) => `- ${fmtDay(e.start)} ${e.all_day ? 'all day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`} **${e.title}**`).join('\n'));
  }

  // ---- tasks ----
  if (/\b(create|add|new|make)\b.*\btask\b|^task\b|^todo\b/.test(t)) {
    let title = stripPhrases(text, when.matched).replace(/^(please\s+)?(create|add|make|new)\s+(a\s+)?(new\s+)?task\s*(to|for|:|-)?\s*/i, '').replace(/^(task|todo)\s*[:-]?\s*/i, '').replace(/\s+(by|on|for|due|before)\s*$/i, '').trim();
    if (!title || /^(for|by|on)$/i.test(title)) return reply(`What's the task${when.date ? ` for ${when.date.toFormat('cccc')}` : ''}?`);
    title = title.charAt(0).toUpperCase() + title.slice(1);
    const priority = /\burgent\b/.test(t) ? 'urgent' : /\b(important|high priority)\b/.test(t) ? 'high' : 'medium';
    const r = await call('create_task', { title: title.replace(/\b(urgent|important|high priority)\b/gi, '').trim() || title, due: when.date ? when.date.toISODate() : null, priority });
    if (r.status === 'pending') return reply(`Prepared task "${title}". Approve it below.`);
    return r.status === 'ok' ? reply(`Created task **${r.result.task.title}**${when.date ? ` due ${when.date.toFormat('cccc d LLL')}` : ''} (${priority} priority).`) : fail(r);
  }
  if (/\b(finish|do|due|todo|to-do|tasks?|priorities)\b/.test(t) && /\b(today|now|need|this week|tomorrow|overdue|what)\b/.test(t)) {
    const end = /this week/.test(t) ? now.endOf('week') : (when.date || now).endOf('day');
    const r = await call('list_tasks', { status: 'open', due_before: end.toISO({ includeOffset: false }), sort: 'priority', limit: 30 });
    if (r.status !== 'ok') return fail(r);
    const list = r.result.tasks;
    if (!list.length) return reply('Nothing due — you\'re clear. Ask me to plan your day to get ahead on priority work.');
    const overdue = list.filter((x) => x.due < toUtcIso(now));
    const rest = list.filter((x) => x.due >= toUtcIso(now));
    return reply([overdue.length ? `**Overdue (${overdue.length})**\n${overdue.map((x) => `- ${x.title} (was due ${fmtDay(x.due)})`).join('\n')}` : null, rest.length ? `**Due ${/this week/.test(t) ? 'this week' : 'by end of day'} (${rest.length})**\n${rest.map((x) => `- ${x.title} · ${x.priority}`).join('\n')}` : null].filter(Boolean).join('\n\n'));
  }

  // ---- briefing ----
  if (/\b(brief|briefing|good morning|overview|my day)\b/.test(t)) {
    const r = await call('get_briefing', { date: dayIso });
    if (r.status !== 'ok') return fail(r);
    const b = r.result;
    return reply([`**${b.events.length} event${b.events.length === 1 ? '' : 's'}**, **${b.due_today.length} task${b.due_today.length === 1 ? '' : 's'} due**, ${b.overdue.length} overdue, ~${Math.round(b.free_minutes / 6) / 10}h free.`,
      ...b.events.slice(0, 6).map((e) => `- ${e.all_day ? 'All day' : fmtTime(e.start)} ${e.title}`), b.suggestions.length ? `\n${b.suggestions.map((x) => `→ ${x}`).join('\n')}` : ''].join('\n'));
  }

  return reply('I didn\'t understand that. Type **help** to see what the demo assistant can do, or connect an AI model in the server configuration for full natural-language understanding.');

  function proposePlan(plan, heading, setDue) {
    if (!plan.blocks?.length) {
      return reply(`${heading}\n${plan.message || 'No tasks could be scheduled.'}${plan.warnings?.length ? `\n⚠ ${plan.warnings.join(' ')}` : ''}${plan.unscheduled?.length ? `\n\nCould not place:\n${plan.unscheduled.map((u) => `- ${u.title}: ${u.reason}`).join('\n')}` : ''}`, { plan });
    }
    return (async () => {
      const r = await call('apply_schedule', { blocks: plan.blocks.map((b) => ({ task_id: b.task_id, start: b.start, end: b.end, title: b.title })), ...(setDue ? { set_due_date: setDue } : {}) });
      const lines = plan.blocks.map((b) => `- ${fmtTime(b.start)}–${fmtTime(b.end)} **${b.title}** (${b.reason})`);
      const extra = [plan.unscheduled?.length ? `\nCouldn't fit:\n${plan.unscheduled.map((u) => `- ${u.title}: ${u.reason}`).join('\n')}` : '', plan.warnings?.length ? `\n⚠ ${plan.warnings.join(' ')}` : ''].join('');
      const tail = r.status === 'pending' ? '\n\nNothing is saved yet — approve below to add these time blocks to your calendar.' : r.status === 'ok' ? `\n\nAdded ${r.result.created.length} blocks.` : `\n\n${r.error}`;
      return reply(`${heading}\n${lines.join('\n')}${extra}${tail}`, { plan });
    })();
  }
}

function matchBill(userId, t) {
  const bills = db.prepare("SELECT name, due_date FROM bills WHERE user_id = ? AND status = 'unpaid' ORDER BY due_date").all(userId);
  return bills.find((b) => b.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && new RegExp(`\\b${w}\\b`).test(t))) || null;
}

function matchCategory(userId, t) {
  const cats = listCategories(userId);
  const aliases = { food: 'Food & Dining', eating: 'Food & Dining', restaurants: 'Food & Dining', dining: 'Food & Dining', travel: 'Travel', transport: 'Transport', commute: 'Transport', fuel: 'Transport', uber: 'Transport', rent: 'Rent & Housing', bills: 'Utilities', electricity: 'Utilities', groceries: 'Groceries', shopping: 'Shopping', health: 'Health', medical: 'Health', subscriptions: 'Subscriptions', entertainment: 'Entertainment', education: 'Education' };
  for (const c of cats) if (t.includes(c.name.toLowerCase())) return c;
  for (const [word, name] of Object.entries(aliases)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      const c = cats.find((x) => x.name === name);
      if (c) return c;
    }
  }
  return null;
}

/** Most recent event/task this conversation created, for "move that" follow-ups. */
function lastCreated(userId, conversationId) {
  const rows = db.prepare("SELECT entity_type, entity_id FROM audit_log WHERE user_id = ? AND action = 'create' AND actor = 'assistant' AND entity_type IN ('event','task') AND created_at >= (SELECT created_at FROM conversations WHERE id = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1").all(userId, conversationId);
  return rows[0] ? { type: rows[0].entity_type, id: rows[0].entity_id } : null;
}
