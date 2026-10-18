import { h, icon, clear, tabs, fmtDateTime, fmtRelDay, fmtTime, nowZ, emptyState, toast, toastError, demoBadge, formModal, field, input, textarea, confirmDialog, toLocalInput, fromLocalInput } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { state, onState, emit } from '../state.js';
import { readRecurrence } from './shared.js';

let tab = 'active';

export async function render(el, { query }) {
  if (query.get('tab')) tab = query.get('tab');
  const tabBar = h('div');
  const body = h('div');
  const statusBox = h('div');
  clear(el,
    h('div', { class: 'page-head' }, h('div', h('h1', 'Reminders'), h('p', 'Reminders are delivered by the JARVIS server as in-app notifications, even when this page is closed.')),
      h('button', { class: 'btn primary', onclick: () => reminderDialog() }, icon('plus'), 'New reminder')),
    statusBox, tabBar, body);
  const draw = async () => {
    clear(tabBar, tabs([['active', 'Active'], ['done', 'Done & dismissed'], ['notifications', 'Notification centre']], tab, (t) => { tab = t; draw(); }));
    try {
      const n = await get('/notifications');
      drawStatus(statusBox, n.scheduler);
      if (tab === 'notifications') return drawNotifications(body, n);
      const list = await get(`/reminders${tab === 'active' ? '?status=active' : ''}`);
      const items = tab === 'active' ? list : list.filter((r) => ['done', 'dismissed'].includes(r.status));
      drawList(body, items);
    } catch (e) {
      clear(body, emptyState(e.message));
    }
  };
  await draw();
  const off = onState((w) => w === 'data' && draw());
  return () => off();
}

function drawStatus(el, scheduler) {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const browserOn = state.settings.notifications.browser;
  clear(el, h('div', { class: `banner ${scheduler.running ? 'info' : 'warn'}` }, icon(scheduler.running ? 'info' : 'alert'),
    h('span', { class: 'grow' }, scheduler.running
      ? `Server scheduler is running${scheduler.last_run_at ? ` (last check ${fmtTime(scheduler.last_run_at)})` : ''}. In-app notifications are on${browserOn && perm === 'granted' ? ', and browser pop-ups appear while a JARVIS tab is open' : ''}. Email/SMS/push delivery is not configured.`
      : 'The reminder scheduler is not running in this server process. Start it (npm run worker) or reminders will not be delivered.'),
    perm === 'default' ? h('button', { class: 'btn sm', onclick: async () => { const p = await Notification.requestPermission(); if (p === 'granted') { state.settings = await patch('/settings', { notifications: { browser: true } }); toast('Browser notifications enabled for open tabs.', { type: 'success' }); } emit('data'); } }, 'Enable browser pop-ups') : null,
    perm === 'denied' ? h('span', { class: 'small faint' }, 'Browser notifications are blocked in your browser settings.') : null));
}

function drawList(body, items) {
  const now = new Date().toISOString();
  const groups = { Overdue: [], Today: [], Upcoming: [], Done: [] };
  const endToday = nowZ().endOf('day').toUTC().toISO();
  for (const r of items) {
    if (['done', 'dismissed'].includes(r.status)) groups.Done.push(r);
    else if (r.status === 'fired' || r.remind_at < now) groups.Overdue.push(r);
    else if (r.remind_at <= endToday) groups.Today.push(r);
    else groups.Upcoming.push(r);
  }
  const row = (r) => h('div', { class: ['list-item', ['done', 'dismissed'].includes(r.status) && 'done'] },
    h('button', { class: 'task-check', role: 'checkbox', 'aria-checked': String(r.status === 'done'), 'aria-label': `Mark ${r.title} done`, onclick: async () => { await patch(`/reminders/${r.id}`, { status: r.status === 'done' ? 'pending' : 'done' }); emit('data'); } }, icon('check')),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, r.title), h('div', { class: 'small faint row tight' }, h('span', fmtDateTime(r.remind_at)), r.recurrence ? h('span', `↻ ${r.recurrence.freq}`) : null, r.status === 'fired' ? h('span', { class: 'badge accent' }, 'Delivered') : null, r.entity_type ? h('span', `Linked ${r.entity_type}`) : null), r.notes ? h('div', { class: 'small muted' }, r.notes) : null),
    demoBadge(r),
    !['done', 'dismissed'].includes(r.status) ? h('button', { class: 'btn ghost sm', onclick: async () => { await post(`/reminders/${r.id}/snooze`, { minutes: 60 }); toast('Snoozed for 1 hour'); emit('data'); } }, 'Snooze 1h') : null,
    h('button', { class: 'btn ghost sm icon', 'aria-label': 'Edit reminder', onclick: () => reminderDialog(r) }, icon('edit')),
    h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete reminder', onclick: async () => { if (await confirmDialog(`Delete reminder "${r.title}"?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/reminders/${r.id}`); emit('data'); } } }, icon('trash')));
  const entries = Object.entries(groups).filter(([, v]) => v.length);
  clear(body, h('div', { class: 'card' }, entries.length ? entries.map(([label, list]) => h('div', { style: { 'margin-bottom': '12px' } }, h('div', { class: `small ${label === 'Overdue' ? 'neg' : 'muted'}`, style: { 'font-weight': 600 } }, `${label} · ${list.length}`), h('div', { class: 'list' }, list.map(row)))) : emptyState('No reminders here.', h('button', { class: 'btn', onclick: () => reminderDialog() }, 'Create one'))));
}

function drawNotifications(body, n) {
  clear(body, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', `Notifications (${n.unread} unread)`), h('div', { class: 'row tight' },
      h('button', { class: 'btn sm', onclick: async () => { await post('/notifications/read', { ids: 'all' }); emit('data'); emit('notifications'); } }, 'Mark all read'),
      h('button', { class: 'btn sm ghost', onclick: async () => { await del('/notifications'); emit('data'); } }, 'Clear read'))),
    n.notifications.length ? h('div', n.notifications.map((x) => h('div', { class: ['notif', !x.read_at && 'unread'] }, icon(x.kind === 'bill' ? 'wallet' : x.kind === 'event' ? 'calendar' : 'bell'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, x.title), x.body ? h('div', { class: 'small muted' }, x.body) : null, h('div', { class: 'meta' }, `${fmtRelDay(x.created_at)} ${fmtTime(x.created_at)} · ${x.kind}`)),
      x.link ? h('a', { class: 'btn ghost sm', href: x.link }, 'Open') : null)))
      : emptyState('No notifications yet. Event reminders, bill alerts, overdue digests and daily briefings appear here.')));
}

export function reminderDialog(r = {}) {
  const at = r.remind_at || nowZ().plus({ hours: 1 }).startOf('hour').toUTC().toISO();
  const rec = r.recurrence;
  const freq = h('select', { class: 'input', name: 'rec_freq' }, [['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([v, l]) => h('option', { value: v, selected: (rec?.freq || '') === v }, l)));
  formModal({
    title: r.id ? 'Edit reminder' : 'New reminder', submitLabel: r.id ? 'Save' : 'Create',
    fields: [
      field('Remind me to…', input('title', { value: r.title || '', required: true, maxlength: 300 }), { full: true }),
      field('When', input('remind_at', { type: 'datetime-local', value: toLocalInput(at), required: true })),
      field('Repeat', freq),
      h('input', { type: 'hidden', name: 'rec_interval', value: rec?.interval || 1 }),
      field('Notes', textarea('notes', r.notes || '', { rows: 2 }), { full: true }),
    ],
    onSubmit: async (fd) => {
      const body = { title: fd.get('title'), remind_at: fromLocalInput(fd.get('remind_at')), notes: fd.get('notes'), recurrence: readRecurrence(fd) };
      if (!r.id && Date.parse(body.remind_at) < Date.now()) throw new Error('Pick a time in the future.');
      if (r.id) await patch(`/reminders/${r.id}`, body);
      else await post('/reminders', body);
      toast('Reminder saved', { type: 'success' });
      emit('data');
    },
  });
}

export { toastError };
