import { h, icon, clear, fmtTime, fmtRelDay, money, nowZ, emptyState, badgeForPriority, demoBadge, progressBar, toastError, durationLabel, loading } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, onState, emit } from '../state.js';
import { composer } from '../composer.js';
import { renderMessage, sendToAssistant, typingIndicator } from '../chat.js';

let conversationId = null;

export async function render(el) {
  const s = state.settings;
  const now = nowZ();
  const greeting = now.hour < 12 ? 'Good morning' : now.hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = (s.profile?.displayName || state.user.name || '').split(' ')[0];
  const replyBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  let abort = null;

  const comp = composer({
    autofocus: false,
    onSubmit: async (text, viaVoice) => {
      abort = new AbortController();
      clear(replyBox, renderMessage({ role: 'user', content: text }), typingIndicator());
      try {
        const r = await sendToAssistant(text, conversationId, { viaVoice, signal: abort.signal, onSpeaking: (on) => comp.speakingState(on) });
        conversationId = r.conversation_id;
        clear(replyBox, renderMessage({ role: 'user', content: text }), renderMessage(r.message, { pending: r.message.pending }),
          h('a', { class: 'small', href: `#/assistant/${conversationId}` }, 'Continue this conversation in the Assistant →'));
      } catch (e) {
        if (e.name === 'AbortError') clear(replyBox, h('p', { class: 'small muted' }, 'Request cancelled. (If it had already reached the server, check the Assistant history for the outcome.)'));
        else clear(replyBox, h('p', { class: 'error-text' }, e.message));
      }
    },
    onCancel: () => abort?.abort(),
  });

  const banners = h('div');
  const grid = h('div', { class: 'grid grid-3' }, loading());
  clear(el,
    banners,
    h('section', { class: 'card glow hero', 'aria-label': 'Ask JARVIS' },
      h('h1', `${greeting}${name ? `, ${name}` : ''}.`),
      h('div', { class: 'date' }, now.toFormat('cccc, d LLLL yyyy'), ' · ', s.timezone),
      comp.el, replyBox),
    h('div', { style: { height: '16px' } }),
    grid);

  const load = async () => {
    try {
      const today = now.toISODate();
      const [b, fin, upcoming, tasks, demo] = await Promise.all([
        get(`/overview?date=${today}`),
        get('/finance/summary'),
        get(`/events?from=${now.startOf('day').toISO({ includeOffset: false })}&to=${now.plus({ days: 4 }).endOf('day').toISO({ includeOffset: false })}`),
        get('/tasks?status=open&sort=priority&top=1'),
        get('/demo'),
      ]);
      drawBanners(banners, demo, b);
      const isEmpty = !upcoming.length && !tasks.length && !fin.summary.expense_count && !fin.summary.income_count && !demo.demoMode;
      if (isEmpty) return clear(grid, onboarding());
      clear(grid,
        briefingCard(b),
        agendaCard(b),
        priorityCard(tasks),
        deadlinesCard(tasks),
        financeCard(fin),
        billsCard(fin, b),
        meetingsCard(upcoming),
        remindersCard(b));
    } catch (e) {
      clear(grid, emptyState(`Couldn't load your overview: ${e.message}`, h('button', { class: 'btn', onclick: load }, 'Retry')));
    }
  };
  await load();
  const off = onState((w) => w === 'data' && load());
  return () => off();
}

function drawBanners(el, demo, b) {
  clear(el,
    demo.demoMode ? h('div', { class: 'banner demo', role: 'note' }, icon('info'), h('span', { class: 'grow' }, h('strong', 'Demo mode. '), 'The items marked “Demo” are sample data, not your real information.'),
      h('button', { class: 'btn sm', onclick: async () => { await post('/demo/clear'); state.settings.demoMode = false; emit('data'); location.reload(); } }, 'Remove demo data')) : null,
    state.ai && !state.ai.configured ? h('div', { class: 'banner warn', role: 'note' }, icon('alert'), h('span', { class: 'grow' }, h('strong', 'No AI model connected. '), 'A limited rule-based demo assistant is answering. Add an API key on the server to enable full natural-language understanding.'), h('a', { class: 'btn sm', href: '#/integrations' }, 'Setup guide')) : null,
    b.conflicts.length ? h('div', { class: 'banner warn', role: 'note' }, icon('alert'), h('span', { class: 'grow' }, `${b.conflicts.length} scheduling conflict${b.conflicts.length > 1 ? 's' : ''} today: "${b.conflicts[0][0]}" overlaps "${b.conflicts[0][1]}".`), h('a', { class: 'btn sm', href: '#/calendar' }, 'Review')) : null,
  );
}

function onboarding() {
  return h('div', { class: 'card span-3' },
    h('div', { class: 'card-head' }, h('h2', icon('sparkle', 'icon'), 'Let\'s get you set up')),
    h('p', { class: 'muted' }, 'Your workspace is empty. Start by adding real information, connect your calendar, or explore with clearly labelled sample data.'),
    h('div', { class: 'row', style: { 'margin-top': '12px' } },
      h('a', { class: 'btn primary', href: '#/settings' }, 'Set working hours & time zone'),
      h('a', { class: 'btn', href: '#/tasks' }, icon('plus'), 'Add a task'),
      h('a', { class: 'btn', href: '#/calendar' }, icon('calendar'), 'Add an event'),
      h('a', { class: 'btn', href: '#/finance?tab=import' }, icon('upload'), 'Import transactions (CSV)'),
      h('a', { class: 'btn', href: '#/integrations' }, icon('integrations'), 'Connect accounts'),
      h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { await post('/demo/load'); state.settings.demoMode = true; emit('data'); } catch (err) { toastError(err); } } }, 'Load demo data')));
}

function card(title, ic, body, { action, cls = '' } = {}) {
  return h('section', { class: `card ${cls}` }, h('div', { class: 'card-head' }, h('h3', icon(ic, 'icon'), title), action || null), body);
}

function briefingCard(b) {
  const items = b.suggestions.length ? b.suggestions : ['Nothing urgent — a good day to get ahead on important work.'];
  return card('Daily briefing', 'sparkle', h('div', { class: 'stack' },
    h('div', { class: 'grid grid-4' },
      stat('Events', b.events.length), stat('Due today', b.due_today.length), stat('Overdue', b.overdue.length, b.overdue.length ? 'neg' : ''), stat('Free time', durationLabel(b.free_minutes))),
    h('div', { class: 'briefing-list' }, items.map((x) => h('div', { class: 'briefing-item' }, icon('chevronRight'), h('span', x)))),
    h('div', { class: 'tiny faint' }, 'Generated from your stored data by rules. Ask JARVIS above for a fuller briefing.'),
  ), { cls: 'span-2', action: h('a', { class: 'btn sm', href: '#/schedule' }, 'Plan my day') });
}

function stat(label, value, cls = '') {
  return h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('span', { class: `value ${cls}` }, String(value)));
}

function agendaCard(b) {
  return card('Today\'s agenda', 'calendar', b.events.length ? h('div', { class: 'list' }, b.events.map((e) => h('a', { class: 'list-item clickable', href: '#/calendar' },
    h('span', { class: `kind-bar kind-${e.kind}` }), h('span', { class: 'time-col' }, e.all_day ? 'All day' : fmtTime(e.start)), h('span', { class: 'grow' }, h('div', { class: 'title truncate' }, e.title), e.location ? h('div', { class: 'small faint truncate' }, e.location) : null), demoBadge(e)))) : emptyState('No events today.'),
  { action: h('a', { class: 'btn sm ghost', href: '#/calendar' }, 'Calendar') });
}

function priorityCard(tasks) {
  const top = tasks.filter((t) => ['urgent', 'high'].includes(t.priority) || t.important).slice(0, 6);
  return card('High-priority tasks', 'flag', top.length ? h('div', { class: 'list' }, top.map((t) => taskRow(t))) : emptyState('No high-priority tasks.'), { action: h('a', { class: 'btn sm ghost', href: '#/tasks' }, 'All tasks') });
}

function taskRow(t) {
  const check = h('button', { class: 'task-check', role: 'checkbox', 'aria-checked': 'false', 'aria-label': `Complete ${t.title}`, onclick: async () => { check.setAttribute('aria-checked', 'true'); try { await patch(`/tasks/${t.id}`, { status: 'done' }); emit('data'); } catch (e) { check.setAttribute('aria-checked', 'false'); toastError(e); } } }, icon('check'));
  const overdue = t.due && t.due < new Date().toISOString();
  return h('div', { class: 'list-item' }, check, h('span', { class: `prio ${t.priority}` }), h('a', { class: 'grow truncate title', href: `#/tasks?task=${t.id}` }, t.title), t.due ? h('span', { class: `small nowrap ${overdue ? 'neg' : 'muted'}` }, overdue ? `Overdue · ${fmtRelDay(t.due)}` : fmtRelDay(t.due)) : null, demoBadge(t));
}

function deadlinesCard(tasks) {
  const soon = tasks.filter((t) => t.due && Date.parse(t.due) < Date.now() + 7 * 864e5).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 7);
  return card('Deadlines this week', 'clock', soon.length ? h('div', { class: 'list' }, soon.map((t) => h('div', { class: 'list-item' }, h('span', { class: 'time-col' }, fmtRelDay(t.due)), h('a', { class: 'grow truncate', href: `#/tasks?task=${t.id}` }, t.title), badgeForPriority(t.priority)))) : emptyState('No deadlines in the next 7 days.'));
}

function financeCard(fin) {
  const x = fin.summary;
  const prev = fin.previous;
  const change = prev.expense_minor ? Math.round(((x.expense_minor - prev.expense_minor) / prev.expense_minor) * 100) : null;
  const max = Math.max(1, ...x.by_category.map((c) => c.total));
  const risky = fin.budgets.filter((b) => b.status !== 'ok');
  return card(`Finances · ${nowZ().toFormat('LLLL')}`, 'finance', h('div', { class: 'stack' },
    h('div', { class: 'grid grid-3' }, stat('Spent', money(x.expense_minor)), stat('Income', money(x.income_minor)), stat('Net', money(x.net_minor), x.net_minor < 0 ? 'neg' : 'pos')),
    change != null ? h('div', { class: 'small muted' }, `Spending is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% vs all of last month (${money(prev.expense_minor)}).`) : null,
    x.by_category.length ? h('div', x.by_category.slice(0, 5).map((c) => h('div', { class: 'hbar' }, h('span', { class: 'truncate' }, c.name), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(c.total / max) * 100}%`, background: c.color || 'var(--accent)' } })), h('span', { class: 'small nowrap' }, money(c.total))))) : emptyState('No expenses recorded this month.'),
    risky.length ? h('div', { class: 'stack tight' }, risky.map((b) => h('div', { class: 'small' }, h('span', { class: `badge ${b.status === 'exceeded' ? 'danger' : 'warning'}` }, b.status === 'exceeded' ? 'Over budget' : 'At risk'), ` ${b.category}: ${money(b.spent_minor)} of ${money(b.budget_minor)}`))) : null,
    h('div', { class: 'tiny faint' }, 'From your recorded transactions only.'),
  ), { cls: 'span-2', action: h('a', { class: 'btn sm ghost', href: '#/finance' }, 'Finance') });
}

function billsCard(fin) {
  const bills = fin.upcoming_bills.slice(0, 6);
  return card('Upcoming bills', 'wallet', bills.length ? h('div', { class: 'list' }, bills.map((b) => h('div', { class: 'list-item' },
    h('span', { class: 'grow' }, h('div', { class: 'title truncate' }, b.name), h('div', { class: `small ${b.days_until_due < 0 ? 'neg' : b.days_until_due <= 2 ? 'warning' : 'faint'}` }, b.days_until_due < 0 ? `Overdue ${-b.days_until_due}d` : b.days_until_due === 0 ? 'Due today' : `Due ${fmtRelDay(b.due_date)}`)),
    h('span', { class: 'nowrap' }, money(b.amount_minor)), demoBadge(b)))) : emptyState('No unpaid bills due in 30 days.'),
  { action: h('a', { class: 'btn sm ghost', href: '#/finance?tab=bills' }, 'Bills') });
}

function meetingsCard(events) {
  const now = new Date().toISOString();
  const meetings = events.filter((e) => e.kind === 'meeting' && e.end > now).slice(0, 6);
  return card('Upcoming meetings', 'calendar', meetings.length ? h('div', { class: 'list' }, meetings.map((e) => h('div', { class: 'list-item' },
    h('span', { class: 'time-col' }, h('div', fmtRelDay(e.start)), h('div', { class: 'faint' }, fmtTime(e.start))), h('span', { class: 'grow' }, h('div', { class: 'title truncate' }, e.title), e.participants.length ? h('div', { class: 'small faint truncate' }, e.participants.join(', ')) : null), demoBadge(e)))) : emptyState('No meetings in the next few days.'),
  { action: h('a', { class: 'btn sm ghost', href: '#/assistant?q=' + encodeURIComponent('Prepare me for tomorrow\'s meetings') }, 'Prepare') });
}

function remindersCard(b) {
  return card('Reminders today', 'reminders', b.reminders.length ? h('div', { class: 'list' }, b.reminders.map((r) => h('div', { class: 'list-item' }, h('span', { class: 'time-col' }, fmtTime(r.remind_at)), h('span', { class: 'grow truncate' }, r.title), r.status === 'fired' ? h('span', { class: 'badge accent' }, 'Sent') : null))) : emptyState('No reminders today.'),
  { action: h('a', { class: 'btn sm ghost', href: '#/reminders' }, 'Reminders') });
}
