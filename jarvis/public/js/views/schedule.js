import { h, icon, clear, fmtTime, fmtRelDay, nowZ, emptyState, toast, toastError, durationLabel, field, input, select, dt, DateTime } from '../ui.js';
import { get, post, patch } from '../api.js';
import { state, onState, emit } from '../state.js';
import { eventDialog } from './shared.js';

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
let planDate = null;
let timer = null;

export async function render(el) {
  planDate ||= nowZ().toISODate();
  const planCard = h('section', { class: 'card span-2' });
  const prefsCard = h('section', { class: 'card' });
  const weekCard = h('section', { class: 'card span-2' });
  const focusCard = h('section', { class: 'card' });
  const shutdownCard = h('section', { class: 'card span-3' });
  clear(el,
    h('div', { class: 'page-head' }, h('div', h('h1', 'Work Schedule'), h('p', 'Working hours, focus time, time-blocking and daily planning.'))),
    h('div', { class: 'grid grid-3' }, planCard, prefsCard, weekCard, focusCard, shutdownCard));

  drawPrefs(prefsCard);
  drawFocus(focusCard);
  const refresh = () => Promise.all([drawPlan(planCard), drawWeek(weekCard), drawShutdown(shutdownCard)]).catch(toastError);
  await refresh();
  const off = onState((w) => w === 'data' && refresh());
  return () => off();
}

async function drawPlan(card) {
  const dateIn = h('input', { class: 'input', type: 'date', value: planDate, 'aria-label': 'Plan date', style: { width: '170px' } });
  dateIn.addEventListener('change', () => { planDate = dateIn.value; drawPlan(card); });
  clear(card, h('div', { class: 'card-head' }, h('h2', icon('sparkle', 'icon'), 'Suggested daily schedule'), h('div', { class: 'row tight' }, dateIn)), h('div', { class: 'spinner' }));
  const plan = await get(`/plan/day?date=${planDate}`);
  const selected = new Set(plan.blocks.map((b) => b.task_id));
  const timeline = [...plan.events.map((e) => ({ ...e, type: 'event' })), ...plan.blocks.map((b) => ({ ...b, type: 'block' }))].sort((a, b) => a.start.localeCompare(b.start));
  const apply = h('button', { class: 'btn primary', disabled: !plan.blocks.length }, icon('check'), 'Add selected blocks to calendar');
  apply.addEventListener('click', async () => {
    const blocks = plan.blocks.filter((b) => selected.has(b.task_id));
    if (!blocks.length) return toast('Select at least one block.');
    apply.disabled = true;
    try {
      const r = await post('/plan/apply', { blocks: blocks.map(({ task_id, start, end }) => ({ task_id, start, end })) });
      toast(`${r.created.length} time block${r.created.length === 1 ? '' : 's'} added${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.map((s) => s.reason).join('; ')})` : ''}.`, { type: 'success' });
      emit('data');
    } catch (e) { toastError(e); apply.disabled = false; }
  });
  clear(card,
    h('div', { class: 'card-head' }, h('h2', icon('sparkle', 'icon'), 'Suggested daily schedule'), h('div', { class: 'row tight' },
      h('button', { class: 'btn sm', onclick: () => { planDate = nowZ().toISODate(); drawPlan(card); } }, 'Today'),
      h('button', { class: 'btn sm', onclick: () => { planDate = nowZ().plus({ days: 1 }).toISODate(); drawPlan(card); } }, 'Tomorrow'), dateIn)),
    h('div', { class: 'row small muted', style: { 'margin-bottom': '10px' } }, h('span', `Free: ${durationLabel(plan.free_minutes)}`), h('span', `Meetings: ${durationLabel(plan.meeting_minutes)}`), h('span', `Planned: ${durationLabel(plan.planned_minutes)}`), plan.overloaded ? h('span', { class: 'badge danger' }, 'Overloaded') : null),
    plan.warnings.map((w) => h('div', { class: 'banner warn' }, icon('alert'), w)),
    timeline.length ? h('div', { class: 'list' }, timeline.map((x) => x.type === 'event'
      ? h('div', { class: 'list-item' }, h('span', { class: `kind-bar kind-${x.kind}` }), h('span', { class: 'time-col' }, x.all_day ? 'All day' : `${fmtTime(x.start)}`), h('span', { class: 'grow' }, h('div', { class: 'title' }, x.title), h('div', { class: 'small faint' }, 'Existing event')))
      : h('label', { class: 'list-item clickable' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? selected.add(x.task_id) : selected.delete(x.task_id)), 'aria-label': `Include ${x.title}` }), h('span', { class: 'time-col' }, `${fmtTime(x.start)}`), h('span', { class: 'grow' }, h('div', { class: 'title' }, x.title, x.partial ? h('span', { class: 'badge', style: { 'margin-left': '6px' } }, 'partial') : null), h('div', { class: 'small faint' }, `${durationLabel(x.minutes)} · ${x.reason}`)), h('span', { class: 'badge accent' }, 'Proposed')))) : emptyState('Nothing scheduled and no priority tasks to plan for this day.'),
    plan.unscheduled.length ? h('div', { class: 'stack tight', style: { 'margin-top': '10px' } }, h('div', { class: 'small muted' }, 'Could not fit:'), plan.unscheduled.map((u) => h('div', { class: 'small' }, `• ${u.title} — ${u.reason}`))) : null,
    h('div', { class: 'row', style: { 'margin-top': '14px' } }, apply, h('span', { class: 'small faint' }, 'Proposed blocks are not saved until you add them.')));
}

function drawPrefs(card) {
  const s = state.settings;
  const start = input('start', { type: 'time', value: s.workingHours.start });
  const end = input('end', { type: 'time', value: s.workingHours.end });
  const days = h('div', { class: 'row tight' }, DAYS.map(([d, l]) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', name: 'day', value: d, checked: s.workingHours.days.includes(d) }), l)));
  const focus = s.focusPeriods.map((f) => ({ ...f }));
  const focusBox = h('div', { class: 'stack tight' });
  const drawFocus = () => focusBox.replaceChildren(...focus.map((f, i) => h('div', { class: 'row tight' },
    h('input', { class: 'input', type: 'time', value: f.start, 'aria-label': 'Focus start', style: { width: '120px' }, onchange: (e) => { f.start = e.target.value; } }), '–',
    h('input', { class: 'input', type: 'time', value: f.end, 'aria-label': 'Focus end', style: { width: '120px' }, onchange: (e) => { f.end = e.target.value; } }),
    h('button', { class: 'btn ghost sm icon', 'aria-label': 'Remove focus period', onclick: () => { focus.splice(i, 1); drawFocus(); } }, icon('x')))),
  h('button', { class: 'btn sm', onclick: () => { focus.push({ start: '15:00', end: '16:30' }); drawFocus(); } }, icon('plus'), 'Add focus period'));
  drawFocus();
  const lunchS = input('lunchStart', { type: 'time', value: s.dailySchedule.lunchStart });
  const lunchE = input('lunchEnd', { type: 'time', value: s.dailySchedule.lunchEnd });
  const buffer = select('buffer', [['0', 'No buffer'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['30', '30 min']], String(s.dailySchedule.bufferMinutes));
  clear(card,
    h('div', { class: 'card-head' }, h('h2', icon('clock', 'icon'), 'Availability')),
    h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Work starts', start), field('Work ends', end)),
      field('Working days', days),
      field('Preferred focus periods', focusBox, { help: 'High-priority work is placed here first.' }),
      h('div', { class: 'form-grid' }, field('Lunch from', lunchS), field('Lunch to', lunchE)),
      field('Buffer around meetings', buffer),
      h('div', { class: 'small faint' }, `Time zone: ${s.timezone} (change in Settings)`),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          state.settings = await patch('/settings', {
            workingHours: { start: start.value, end: end.value, days: [...days.querySelectorAll('input:checked')].map((x) => Number(x.value)) },
            focusPeriods: focus.filter((f) => f.start && f.end && f.start < f.end),
            dailySchedule: { lunchStart: lunchS.value, lunchEnd: lunchE.value, bufferMinutes: Number(buffer.value) },
          });
          toast('Availability saved', { type: 'success' });
          emit('data');
        } catch (e) { toastError(e); }
      } }, 'Save availability')));
}

async function drawWeek(card) {
  const n = nowZ();
  const from = n.startOf('week');
  const events = await get(`/events?from=${from.toISO({ includeOffset: false })}&to=${from.plus({ days: 7 }).toISO({ includeOffset: false })}`);
  const s = state.settings;
  const [wsH, wsM] = s.workingHours.start.split(':').map(Number);
  const [weH, weM] = s.workingHours.end.split(':').map(Number);
  const capacityPerDay = (weH * 60 + weM) - (wsH * 60 + wsM);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = from.plus({ days: i });
    const dayEvents = events.filter((e) => !e.all_day && dt(e.start).toISODate() === d.toISODate());
    const mins = (k) => dayEvents.filter((e) => k(e.kind)).reduce((m, e) => m + (Date.parse(e.end) - Date.parse(e.start)) / 60000, 0);
    const meet = mins((k) => k === 'meeting');
    const focusM = mins((k) => k === 'focus' || k === 'task_block' || k === 'work' || k === 'study');
    const isWork = s.workingHours.days.includes(d.weekday);
    const cap = isWork ? capacityPerDay : 0;
    const pct = (m) => (cap ? Math.min(100, (m / cap) * 100) : 0);
    rows.push(h('div', { class: 'hbar', style: { 'grid-template-columns': '90px 1fr 120px' } },
      h('span', { class: d.hasSame(n, 'day') ? 'accent' : '' }, d.toFormat('ccc d')),
      h('div', { class: 'track', style: { display: 'flex' } }, h('div', { class: 'fill', style: { width: `${pct(meet)}%`, background: 'var(--accent)', 'border-radius': '0' } }), h('div', { class: 'fill', style: { width: `${pct(focusM)}%`, background: 'var(--violet)', 'border-radius': '0' } })),
      h('span', { class: 'small muted nowrap' }, isWork ? `${durationLabel(Math.round(meet))} mtg · ${durationLabel(Math.round(focusM))} blocks` : 'Day off')));
  }
  const blocks = events.filter((e) => ['focus', 'task_block', 'work', 'study'].includes(e.kind) && e.end > new Date().toISOString()).slice(0, 8);
  clear(card,
    h('div', { class: 'card-head' }, h('h2', icon('calendar', 'icon'), 'This week\'s load'), h('div', { class: 'legend' }, h('span', h('span', { class: 'swatch', style: { background: 'var(--accent)' } }), 'Meetings'), h('span', h('span', { class: 'swatch', style: { background: 'var(--violet)' } }), 'Focus & task blocks'))),
    h('div', rows),
    h('h3', { style: { margin: '16px 0 6px' } }, 'Upcoming time blocks'),
    blocks.length ? h('div', { class: 'list' }, blocks.map((e) => h('div', { class: 'list-item clickable', onclick: () => eventDialog(e) }, h('span', { class: `kind-bar kind-${e.kind}` }), h('span', { class: 'time-col' }, fmtRelDay(e.start)), h('span', { class: 'time-col' }, fmtTime(e.start)), h('span', { class: 'grow truncate' }, e.title)))) : emptyState('No focus or task blocks scheduled.'),
    h('button', { class: 'btn', style: { 'margin-top': '10px' }, onclick: () => eventDialog({ kind: 'focus', title: 'Focus time' }) }, icon('plus'), 'Block focus time'));
}

/** Simple focus timer. When a session ends it is recorded as a focus event on the calendar. */
async function drawFocus(card) {
  const tasks = await get('/tasks?status=open&sort=priority').catch(() => []);
  const taskSel = select('task', [['', 'No specific task'], ...tasks.slice(0, 50).map((t) => [t.id, t.title])], '');
  const lenSel = select('len', [['25', '25 min'], ['45', '45 min'], ['50', '50 min'], ['90', '90 min']], '25');
  const display = h('div', { class: 'timer', 'aria-live': 'off' }, '25:00');
  const btn = h('button', { class: 'btn primary' }, icon('play'), 'Start focus');
  const stopBtn = h('button', { class: 'btn', hidden: true }, icon('stop'), 'Finish early');
  let endAt = null;
  let startedAt = null;
  const fmt = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  const finish = async (completed) => {
    clearInterval(timer);
    timer = null;
    const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    btn.hidden = false;
    stopBtn.hidden = true;
    display.textContent = fmt(Number(lenSel.value) * 60000);
    const taskTitle = taskSel.selectedOptions[0]?.textContent;
    try {
      await post('/events', { title: `Focus: ${taskSel.value ? taskTitle : 'session'}`, kind: 'focus', start: new Date(startedAt).toISOString(), duration_minutes: Math.max(5, mins), task_id: taskSel.value || null, description: completed ? 'Completed focus session' : 'Focus session (ended early)', allow_conflict: true });
      toast(`${mins}-minute focus session logged to your calendar.`, { type: 'success', title: completed ? 'Session complete' : 'Session ended' });
      emit('data');
    } catch (e) { toastError(e); }
  };
  btn.addEventListener('click', () => {
    startedAt = Date.now();
    endAt = startedAt + Number(lenSel.value) * 60000;
    btn.hidden = true;
    stopBtn.hidden = false;
    clearInterval(timer);
    timer = setInterval(() => {
      const left = endAt - Date.now();
      if (left <= 0) {
        finish(true);
        if (state.settings.notifications.browser && 'Notification' in window && Notification.permission === 'granted') new Notification('Focus session complete');
        return;
      }
      display.textContent = fmt(left);
    }, 500);
  });
  stopBtn.addEventListener('click', () => finish(false));
  lenSel.addEventListener('change', () => { if (!timer) display.textContent = fmt(Number(lenSel.value) * 60000); });
  clear(card,
    h('div', { class: 'card-head' }, h('h2', icon('target', 'icon'), 'Focus session')),
    h('div', { class: 'stack' }, display, field('Working on', taskSel), field('Length', lenSel), h('div', { class: 'row' }, btn, stopBtn),
      h('p', { class: 'small faint' }, 'The timer runs in this tab. Finished sessions are saved as focus events.')));
}

async function drawShutdown(card) {
  const r = await get('/plan/shutdown');
  const tomorrow = r.tomorrow;
  clear(card,
    h('div', { class: 'card-head' }, h('h2', icon('moon', 'icon'), 'Daily shutdown'), h('a', { class: 'btn sm', href: `#/assistant?q=${encodeURIComponent('Give me a summary of my day and prepare a plan for tomorrow')}` }, icon('sparkle'), 'Ask JARVIS')),
    h('div', { class: 'grid grid-3' },
      h('div', h('h3', `Completed today (${r.completed.length})`), r.completed.length ? h('ul', { class: 'small' }, r.completed.map((c) => h('li', c.title))) : h('p', { class: 'small faint' }, 'Nothing marked done yet.')),
      h('div', h('h3', `Still open (${r.unfinished.length})`), r.unfinished.length ? h('ul', { class: 'small' }, r.unfinished.slice(0, 10).map((u) => h('li', u.title))) : h('p', { class: 'small faint' }, 'All clear.')),
      h('div', h('h3', `Tomorrow · ${DateTime.fromISO(tomorrow.date).toFormat('ccc d LLL')}`),
        h('p', { class: 'small muted' }, `${tomorrow.briefing.events.length} events, ${tomorrow.briefing.due_today.length} tasks due, ~${durationLabel(tomorrow.briefing.free_minutes)} free.`),
        tomorrow.plan.blocks?.length ? [h('ul', { class: 'small' }, tomorrow.plan.blocks.map((b) => h('li', `${fmtTime(b.start)} ${b.title}`))),
          h('button', { class: 'btn sm primary', onclick: async (e) => { e.target.disabled = true; try { const x = await post('/plan/apply', { blocks: tomorrow.plan.blocks.map(({ task_id, start, end }) => ({ task_id, start, end })), set_due_date: tomorrow.date }); toast(`Moved ${x.created.length} unfinished task${x.created.length === 1 ? '' : 's'} to tomorrow.`, { type: 'success' }); emit('data'); } catch (err) { toastError(err); e.target.disabled = false; } } }, 'Move unfinished work to tomorrow')]
          : h('p', { class: 'small faint' }, tomorrow.plan.message || 'No unfinished work to move.'))));
}
