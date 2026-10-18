import { h, icon, clear, fmtTime, fmtRelDay, dt, nowZ, emptyState, toastError, debounce, openModal, field, input, select, demoBadge, DateTime } from '../ui.js';
import { get, post } from '../api.js';
import { state, onState } from '../state.js';
import { eventDialog, saveEvent, KINDS } from './shared.js';

const HOUR_PX = 48;

let view = 'week';
let cursor = null;
let kindFilter = '';

export async function render(el) {
  cursor ||= nowZ().startOf('day');
  const weekStartsSunday = state.settings.weekStart === 0;
  const title = h('h2', { 'aria-live': 'polite' });
  const body = h('div');
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search events…', 'aria-label': 'Search events', style: { width: '220px' } });
  const viewBtns = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Calendar view' }, ['day', 'week', 'month'].map((v) => h('button', { class: 'btn', 'aria-pressed': String(v === view), onclick: () => { view = v; draw(); } }, v[0].toUpperCase() + v.slice(1))));
  const kindSel = select('kind', [['', 'All types'], ...KINDS], kindFilter);
  kindSel.setAttribute('aria-label', 'Filter by event type');
  kindSel.style.width = '150px';
  kindSel.addEventListener('change', () => { kindFilter = kindSel.value; draw(); });

  const step = (dir) => {
    cursor = view === 'month' ? cursor.plus({ months: dir }) : view === 'week' ? cursor.plus({ weeks: dir }) : cursor.plus({ days: dir });
    draw();
  };
  clear(el,
    h('div', { class: 'cal-toolbar' },
      h('button', { class: 'btn', onclick: () => { cursor = nowZ().startOf('day'); draw(); } }, 'Today'),
      h('button', { class: 'btn icon', 'aria-label': 'Previous', onclick: () => step(-1) }, icon('chevronLeft')),
      h('button', { class: 'btn icon', 'aria-label': 'Next', onclick: () => step(1) }, icon('chevronRight')),
      title, h('div', { class: 'grow' }), searchInput, kindSel, viewBtns,
      h('button', { class: 'btn', onclick: freeTimeDialog }, icon('search'), 'Find free time'),
      h('button', { class: 'btn primary', onclick: () => eventDialog({}, { onSaved: draw }) }, icon('plus'), 'New event')),
    body);

  const weekStart = (d) => (weekStartsSunday ? (d.weekday === 7 ? d.startOf('day') : d.startOf('week').minus({ days: 1 })) : d.startOf('week'));

  async function draw() {
    for (const b of viewBtns.children) b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === view));
    let from;
    let to;
    if (view === 'month') {
      from = weekStart(cursor.startOf('month'));
      to = weekStart(cursor.endOf('month')).plus({ days: 7 });
      title.textContent = cursor.toFormat('LLLL yyyy');
    } else if (view === 'week') {
      from = weekStart(cursor);
      to = from.plus({ days: 7 });
      title.textContent = `${from.toFormat('d LLL')} – ${to.minus({ days: 1 }).toFormat('d LLL yyyy')}`;
    } else {
      from = cursor.startOf('day');
      to = from.plus({ days: 1 });
      title.textContent = cursor.toFormat('cccc, d LLLL yyyy');
    }
    try {
      const qs = new URLSearchParams({ from: from.toISO({ includeOffset: false }), to: to.toISO({ includeOffset: false }) });
      if (kindFilter) qs.set('kind', kindFilter);
      const events = markConflicts(await get(`/events?${qs}`));
      if (view === 'month') clear(body, monthView(from, to, events));
      else clear(body, timeGrid(from, view === 'week' ? 7 : 1, events, draw));
    } catch (e) {
      clear(body, emptyState(e.message));
    }
  }

  const doSearch = debounce(async () => {
    const q = searchInput.value.trim();
    if (!q) return draw();
    try {
      const results = await get(`/events?search=${encodeURIComponent(q)}`);
      title.textContent = `Search: “${q}”`;
      clear(body, h('div', { class: 'card' }, results.length ? h('div', { class: 'list' }, results.map((e) => h('div', { class: 'list-item clickable', onclick: () => eventDialog(e, { onSaved: doSearch }) },
        h('span', { class: `kind-bar kind-${e.kind}` }), h('span', { class: 'time-col' }, fmtRelDay(e.start)), h('span', { class: 'time-col' }, e.all_day ? 'All day' : fmtTime(e.start)), h('span', { class: 'grow title' }, e.title), e.recurrence ? h('span', { class: 'badge' }, 'Repeats') : null, demoBadge(e)))) : emptyState('No events match.')));
    } catch (e) {
      toastError(e);
    }
  }, 300);
  searchInput.addEventListener('input', doSearch);

  await draw();
  const off = onState((w) => w === 'data' && draw());
  return () => off();
}

function markConflicts(events) {
  const timed = events.filter((e) => !e.all_day);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].start < timed[i].end && timed[i].start < timed[j].end) timed[i].conflict = timed[j].conflict = true;
    }
  }
  return events;
}

function monthView(from, to, events) {
  const today = nowZ().toISODate();
  const month = from.plus({ days: 10 }).month;
  const grid = h('div', { class: 'month-grid', role: 'grid' });
  const dows = [];
  for (let i = 0; i < 7; i++) dows.push(from.plus({ days: i }).toFormat('ccc'));
  grid.append(...dows.map((d) => h('div', { class: 'dow', role: 'columnheader' }, d)));
  for (let d = from; d < to; d = d.plus({ days: 1 })) {
    const iso = d.toISODate();
    const dayEvents = events.filter((e) => dt(e.start).toISODate() === iso || (e.all_day && dt(e.start).toISODate() <= iso && dt(e.end).minus({ seconds: 1 }).toISODate() >= iso));
    const cell = h('div', { class: ['month-cell', d.month !== month && 'other', iso === today && 'today'], role: 'gridcell', tabindex: 0, 'aria-label': `${d.toFormat('cccc d LLLL')}, ${dayEvents.length} events`,
      onclick: (e) => { if (e.target === cell || e.target.classList.contains('day-num')) eventDialog({ start: d.set({ hour: 9 }).toUTC().toISO(), end: d.set({ hour: 10 }).toUTC().toISO() }); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === cell) eventDialog({ start: d.set({ hour: 9 }).toUTC().toISO(), end: d.set({ hour: 10 }).toUTC().toISO() }); } },
    h('span', { class: 'day-num' }, d.day));
    for (const e of dayEvents.slice(0, 3)) cell.append(h('button', { class: ['ev-chip', `kind-${e.kind}`, e.conflict && 'conflict'], type: 'button', title: `${e.title}${e.conflict ? ' (overlaps another event)' : ''}`, onclick: () => eventDialog(e) }, e.all_day ? '' : `${fmtTime(e.start)} `, e.title));
    if (dayEvents.length > 3) cell.append(h('span', { class: 'more' }, `+${dayEvents.length - 3} more`));
    grid.append(cell);
  }
  return grid;
}

function timeGrid(from, days, events, redraw) {
  const s = state.settings;
  const today = nowZ().toISODate();
  const wrap = h('div', { class: 'week-wrap', style: { '--days': String(days) } });
  const head = h('div', { class: 'week-head' }, h('div'));
  const allday = h('div', { class: 'week-allday' }, h('div', 'all-day'));
  const bodyEl = h('div', { class: 'week-body' });
  const hours = h('div', { class: 'hours' });
  for (let i = 0; i < 24; i++) hours.append(h('div', i === 0 ? '' : DateTime.fromObject({ hour: i }).toFormat(s.timeFormat === '24h' ? 'HH:00' : 'h a')));
  bodyEl.append(hours);
  const [wsH, wsM] = s.workingHours.start.split(':').map(Number);
  const [weH, weM] = s.workingHours.end.split(':').map(Number);

  for (let i = 0; i < days; i++) {
    const day = from.plus({ days: i });
    const iso = day.toISODate();
    head.append(h('div', { class: iso === today ? 'today' : '' }, day.toFormat('ccc d')));
    allday.append(h('div', events.filter((e) => e.all_day && dt(e.start).toISODate() <= iso && dt(e.end).minus({ seconds: 1 }).toISODate() >= iso).map((e) => h('button', { class: `ev-chip kind-${e.kind}`, type: 'button', onclick: () => eventDialog(e) }, e.title))));
    const col = h('div', { class: 'day-col', style: { height: `${24 * HOUR_PX}px` }, role: 'group', 'aria-label': day.toFormat('cccc d LLLL') });
    if (s.workingHours.days.includes(day.weekday)) {
      col.append(h('div', { class: 'work-band', style: { top: `${(wsH + wsM / 60) * HOUR_PX}px`, height: `${(weH + weM / 60 - wsH - wsM / 60) * HOUR_PX}px` } }));
    }
    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('work-band')) return;
      const y = e.offsetY;
      const mins = Math.floor((y / HOUR_PX) * 4) * 15;
      const st = day.plus({ minutes: mins });
      eventDialog({ start: st.toUTC().toISO(), end: st.plus({ hours: 1 }).toUTC().toISO() }, { onSaved: redraw });
    });
    if (iso === today) {
      const n = nowZ();
      col.append(h('div', { class: 'now-line', style: { top: `${(n.hour + n.minute / 60) * HOUR_PX}px` } }));
    }
    const dayEvents = layoutColumns(events.filter((e) => !e.all_day && dt(e.start) < day.plus({ days: 1 }) && dt(e.end) > day));
    for (const e of dayEvents) {
      const st = DateTime.max(dt(e.start), day);
      const en = DateTime.min(dt(e.end), day.plus({ days: 1 }));
      const top = (st.diff(day, 'minutes').minutes / 60) * HOUR_PX;
      const height = Math.max(18, (en.diff(st, 'minutes').minutes / 60) * HOUR_PX - 2);
      const block = h('div', {
        class: ['ev-block', `kind-${e.kind}`, e.conflict && 'conflict'], tabindex: 0, role: 'button',
        'aria-label': `${e.title}, ${fmtTime(e.start)} to ${fmtTime(e.end)}${e.conflict ? ', overlaps another event' : ''}. Press Enter to edit.`,
        style: { top: `${top}px`, height: `${height}px`, left: `calc(${(e._col / e._cols) * 100}% + 2px)`, width: `calc(${100 / e._cols}% - 4px)`, right: 'auto' },
      }, h('div', { class: 't' }, e.title), height > 30 ? h('div', { class: 'when' }, `${fmtTime(e.start)}–${fmtTime(e.end)}`) : null);
      block.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') eventDialog(e, { onSaved: redraw }); });
      enableDrag(block, e, col, day, from, days, redraw);
      col.append(block);
    }
    bodyEl.append(col);
  }
  wrap.append(head, allday, bodyEl);
  requestAnimationFrame(() => { bodyEl.scrollTop = Math.max(0, (wsH - 1) * HOUR_PX); });
  return wrap;
}

/** Side-by-side columns for overlapping events within a day. */
function layoutColumns(list) {
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end));
  let cluster = [];
  let clusterEnd = '';
  const flush = () => {
    const cols = [];
    for (const e of cluster) {
      let c = cols.findIndex((end) => end <= e.start);
      if (c === -1) { c = cols.length; cols.push(e.end); } else cols[c] = e.end;
      e._col = c;
    }
    for (const e of cluster) e._cols = cols.length;
    cluster = [];
  };
  for (const e of sorted) {
    if (cluster.length && e.start >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = cluster.length === 1 || e.end > clusterEnd ? e.end : clusterEnd;
  }
  flush();
  return sorted;
}

/** Pointer-based drag to reschedule (15-minute snapping). A click without movement opens the editor. */
function enableDrag(block, e, col, day, from, days, redraw) {
  let startY = 0;
  let startX = 0;
  let origTop = 0;
  let moved = false;
  let pointerId = null;
  block.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    pointerId = ev.pointerId;
    startY = ev.clientY;
    startX = ev.clientX;
    origTop = parseFloat(block.style.top);
    moved = false;
    block.setPointerCapture(pointerId);
  });
  block.addEventListener('pointermove', (ev) => {
    if (pointerId !== ev.pointerId) return;
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dy) < 5 && Math.abs(ev.clientX - startX) < 5) return;
    moved = true;
    block.classList.add('dragging');
    const snapped = Math.round(((origTop + dy) / HOUR_PX) * 4) / 4;
    block.style.top = `${Math.max(0, snapped * HOUR_PX)}px`;
    const colW = col.getBoundingClientRect().width;
    block.style.transform = `translateX(${Math.round((ev.clientX - startX) / colW) * colW}px)`;
  });
  block.addEventListener('pointerup', async (ev) => {
    if (pointerId !== ev.pointerId) return;
    block.releasePointerCapture(pointerId);
    pointerId = null;
    block.classList.remove('dragging');
    if (!moved) return eventDialog(e, { onSaved: redraw });
    const colW = col.getBoundingClientRect().width;
    const dayShift = Math.max(-col.parentElement.children.length, Math.round((ev.clientX - startX) / colW));
    const minutesFromDayStart = Math.round((parseFloat(block.style.top) / HOUR_PX) * 60);
    const newStart = day.plus({ days: dayShift, minutes: minutesFromDayStart });
    const delta = newStart.toMillis() - dt(e.start).toMillis();
    if (!delta) { block.style.transform = ''; return; }
    if (e.source && e.source !== 'local') {
      toastError(new Error(`This event is imported from ${e.source}; change it there and re-sync.`));
      return redraw();
    }
    const base = e.recurrence ? Date.parse(e.series_start) : Date.parse(e.start);
    if (e.recurrence && !window.confirm('This is a recurring event. Moving it shifts the whole series. Continue?')) return redraw();
    try {
      await saveEvent(e.id, { start: new Date(base + delta).toISOString(), duration_minutes: Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000) });
    } catch (err) {
      toastError(err);
    }
    redraw();
  });
}

function freeTimeDialog() {
  const n = nowZ();
  const results = h('div', { class: 'stack tight full' });
  const fromIn = input('from', { type: 'date', value: n.toISODate() });
  const toIn = input('to', { type: 'date', value: n.plus({ days: 7 }).toISODate() });
  const durSel = select('duration', [['30', '30 minutes'], ['60', '1 hour'], ['90', '1.5 hours'], ['120', '2 hours'], ['180', '3 hours']], '60');
  const whOnly = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true }), 'Within working hours only');
  const search = async () => {
    results.replaceChildren(h('span', { class: 'spinner' }));
    try {
      const slots = await post('/calendar/free-slots', { from: `${fromIn.value}T00:00`, to: `${DateTime.fromISO(toIn.value).plus({ days: 1 }).toISODate()}T00:00`, duration: Number(durSel.value), working_hours_only: whOnly.querySelector('input').checked });
      results.replaceChildren(...(slots.length ? slots.slice(0, 20).map((sl) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, `${fmtRelDay(sl.start)}, ${fmtTime(sl.start)} – ${fmtTime(sl.end)}`), h('span', { class: 'small faint' }, `${Math.floor(sl.minutes / 60)}h ${sl.minutes % 60}m free`),
        h('button', { class: 'btn sm', onclick: () => { m.close(); eventDialog({ start: sl.start, end: new Date(Date.parse(sl.start) + Number(durSel.value) * 60000).toISOString() }); } }, 'Book'))) : [emptyState('No free slots of that length in this range.')]));
    } catch (e) {
      results.replaceChildren(h('p', { class: 'error-text' }, e.message));
    }
  };
  const m = openModal({
    title: 'Find free time', wide: true,
    body: h('div', { class: 'form-grid' }, field('From', fromIn), field('To', toIn), field('Duration', durSel), h('div', { class: 'field' }, h('span', ' '), whOnly), h('div', { class: 'full' }, h('button', { class: 'btn primary', type: 'button', onclick: search }, icon('search'), 'Search')), results),
  });
}
