// Dialogs shared across views: event editor and task editor.
import { h, icon, field, input, select, textarea, checkbox, formModal, confirmDialog, openModal, toast, toastError, toLocalInput, fromLocalInput, fmtTime, fmtRelDay, dt, zone, dueDateInput, DateTime } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { emit } from '../state.js';

export const KINDS = [['meeting', 'Meeting'], ['work', 'Work block'], ['focus', 'Focus period'], ['study', 'Study session'], ['personal', 'Personal'], ['task_block', 'Task time block'], ['other', 'Other']];
const DOW = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

function recurrenceFields(rec) {
  const freq = select('rec_freq', [['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']], rec?.freq || '');
  const interval = input('rec_interval', { type: 'number', value: rec?.interval || 1, min: 1, max: 365 });
  const until = input('rec_until', { type: 'date', value: rec?.until || '' });
  const days = h('div', { class: 'row tight', role: 'group', 'aria-label': 'Repeat on days' }, DOW.map(([d, l]) => checkbox(`rec_day_${d}`, l, rec?.byDay?.includes(d))));
  const daysField = field('Repeat on', days, { full: true });
  const extra = h('div', { class: 'form-grid full' }, field('Every (interval)', interval), field('Until (optional)', until), daysField);
  const sync = () => {
    extra.hidden = !freq.value;
    daysField.hidden = freq.value !== 'weekly';
  };
  freq.addEventListener('change', sync);
  sync();
  return [field('Repeat', freq, { full: true }), extra];
}

export function readRecurrence(fd) {
  const freq = fd.get('rec_freq');
  if (!freq) return null;
  const r = { freq, interval: Number(fd.get('rec_interval')) || 1 };
  if (fd.get('rec_until')) r.until = fd.get('rec_until');
  if (freq === 'weekly') {
    const days = DOW.map(([d]) => d).filter((d) => fd.get(`rec_day_${d}`));
    if (days.length) r.byDay = days;
  }
  return r;
}

/** Create or edit an event. `ev` may be a partial with start/end for new events. */
export function eventDialog(ev = {}, { onSaved } = {}) {
  const isNew = !ev.id;
  const start = ev.start || DateTime.now().setZone(zone()).plus({ hours: 1 }).startOf('hour').toUTC().toISO();
  const end = ev.end || DateTime.fromISO(start).plus({ hours: 1 }).toUTC().toISO();
  const startIn = input('start', { type: 'datetime-local', value: toLocalInput(start), required: true });
  const endIn = input('end', { type: 'datetime-local', value: toLocalInput(end), required: true });
  const conflictBox = h('div', { class: 'full small', 'aria-live': 'polite' });
  const checkConflicts = async () => {
    const s = fromLocalInput(startIn.value);
    const e = fromLocalInput(endIn.value);
    if (!s || !e || e <= s) return clear();
    try {
      const c = await post('/calendar/conflicts', { start: s, end: e, exclude_id: ev.id });
      conflictBox.replaceChildren(...(c.length ? [h('div', { class: 'banner warn' }, icon('alert'), `Overlaps: ${c.map((x) => `${x.title} (${fmtTime(x.start)}–${fmtTime(x.end)})`).join(', ')}`)] : []));
    } catch { /* non-blocking */ }
    function clear() { conflictBox.replaceChildren(); }
  };
  let prevStart = start;
  startIn.addEventListener('change', () => {
    // Keep the duration when the start moves.
    const next = fromLocalInput(startIn.value);
    if (!next) return;
    const dur = Date.parse(fromLocalInput(endIn.value)) - Date.parse(prevStart);
    if (dur > 0) endIn.value = toLocalInput(new Date(Date.parse(next) + dur).toISOString());
    prevStart = next;
    checkConflicts();
  });
  endIn.addEventListener('change', checkConflicts);

  const recurringOccurrence = ev.recurrence && ev.occurrence_of;
  const fields = [
    field('Title', input('title', { value: ev.title || '', required: true, maxlength: 200, placeholder: 'e.g. Design review' }), { full: true }),
    field('Type', select('kind', KINDS, ev.kind || 'meeting')),
    field('Reminder', select('reminder_minutes', [['', 'Default (from settings)'], ['0', 'At start'], ['5', '5 min before'], ['10', '10 min before'], ['15', '15 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']], ev.reminder_minutes ?? '')),
    field('Starts', startIn), field('Ends', endIn),
    h('div', { class: 'full' }, checkbox('all_day', 'All-day event', ev.all_day)),
    conflictBox,
    field('Location', input('location', { value: ev.location || '', maxlength: 300 })),
    field('Participants', input('participants', { value: (ev.participants || []).join(', '), placeholder: 'Comma-separated names or emails' })),
    field('Description / agenda', textarea('description', ev.description || '', { rows: 3 }), { full: true }),
    ...recurrenceFields(ev.recurrence),
    recurringOccurrence ? h('p', { class: 'full help' }, 'This is a recurring event. Edits apply to the whole series.') : null,
    ev.source && ev.source !== 'local' ? h('p', { class: 'full help' }, `Imported from ${ev.source}. Local edits will be overwritten on the next sync.`) : null,
  ].filter(Boolean);

  const extraActions = isNew ? [] : [{
    label: 'Delete', danger: true, left: true, onClick: async () => {
      let occurrence;
      if (ev.recurrence) {
        const choice = await new Promise((resolve) => {
          let pick = null;
          openModal({ title: 'Delete recurring event', body: h('p', 'Delete only this occurrence, or the whole series?'), actions: [{ label: 'Cancel', ghost: true }, { label: 'This occurrence', onClick: () => { pick = 'one'; } }, { label: 'Entire series', danger: true, onClick: () => { pick = 'all'; } }], onClose: () => resolve(pick) });
        });
        if (!choice) return false;
        if (choice === 'one') occurrence = ev.start;
      } else if (!(await confirmDialog(`Delete "${ev.title}"?`, { danger: true, confirmLabel: 'Delete' }))) return false;
      await del(`/events/${ev.id}${occurrence ? `?occurrence=${encodeURIComponent(occurrence)}` : ''}`);
      toast('Event deleted', { type: 'success' });
      emit('data');
      onSaved?.();
    },
  }];

  formModal({
    title: isNew ? 'New event' : 'Edit event', fields, extraActions, wide: true, submitLabel: isNew ? 'Create event' : 'Save changes',
    onSubmit: async (fd) => {
      const allDay = !!fd.get('all_day');
      const body = {
        title: fd.get('title'), kind: fd.get('kind'), location: fd.get('location'), description: fd.get('description'),
        participants: String(fd.get('participants') || '').split(',').map((s) => s.trim()).filter(Boolean),
        start: fromLocalInput(fd.get('start')), end: allDay ? undefined : fromLocalInput(fd.get('end')), all_day: allDay,
        reminder_minutes: fd.get('reminder_minutes') === '' ? null : Number(fd.get('reminder_minutes')),
        recurrence: readRecurrence(fd),
      };
      if (allDay) body.duration_minutes = Math.max(1440, Math.round((Date.parse(fromLocalInput(fd.get('end'))) - Date.parse(body.start)) / 60000 / 1440) * 1440 || 1440);
      if (!isNew && ev.recurrence && ev.series_start && ev.start !== ev.series_start) {
        // Editing an occurrence: shift the series by the same delta instead of moving its first instance here.
        const delta = Date.parse(body.start) - Date.parse(ev.start);
        const dur = Date.parse(body.end || body.start) - Date.parse(body.start);
        body.start = new Date(Date.parse(ev.series_start) + delta).toISOString();
        if (body.end) body.end = new Date(Date.parse(body.start) + dur).toISOString();
      }
      await saveEvent(ev.id, body);
      onSaved?.();
    },
  });
  checkConflicts();
}

/** POST/PATCH an event; on a 409 conflict, ask the user whether to save anyway. */
export async function saveEvent(id, body) {
  try {
    if (id) await patch(`/events/${id}`, body);
    else await post('/events', body);
  } catch (e) {
    if (e.status !== 409) throw e;
    const list = e.body.conflicts.map((c) => `• ${c.title} (${fmtRelDay(c.start)} ${fmtTime(c.start)}–${fmtTime(c.end)})`).join('\n');
    const ok = await confirmDialog(h('div', h('p', 'This time overlaps:'), h('pre', { class: 'small', style: { 'white-space': 'pre-wrap' } }, list), h('p', 'Save anyway?')), { title: 'Scheduling conflict', confirmLabel: 'Save anyway' });
    if (!ok) throw new Error('Not saved — choose another time.');
    if (id) await patch(`/events/${id}`, { ...body, allow_conflict: true });
    else await post('/events', { ...body, allow_conflict: true });
  }
  toast(id ? 'Event updated' : 'Event created', { type: 'success' });
  emit('data');
}

/** Create or edit a task. */
export async function taskDialog(task = {}, { onSaved, projects, defaults = {} } = {}) {
  const isNew = !task.id;
  const [projList, allTasks] = await Promise.all([projects ? Promise.resolve(projects) : get('/projects'), get('/tasks?status=open')]);
  const t = { ...defaults, ...task };
  const checklist = (t.checklist || []).map((c) => ({ ...c }));
  const clBox = h('div', { class: 'stack tight' });
  const drawChecklist = () => {
    clBox.replaceChildren(...checklist.map((c, i) => h('div', { class: 'checklist-row' },
      h('input', { type: 'checkbox', checked: c.done, 'aria-label': `Done: ${c.text}`, onchange: (e) => { c.done = e.target.checked; } }),
      h('input', { class: 'input', value: c.text, 'aria-label': 'Checklist item', oninput: (e) => { c.text = e.target.value; } }),
      h('button', { type: 'button', class: 'btn ghost sm icon', 'aria-label': 'Remove item', onclick: () => { checklist.splice(i, 1); drawChecklist(); } }, icon('x')))),
    h('button', { type: 'button', class: 'btn sm', onclick: () => { checklist.push({ text: '', done: false }); drawChecklist(); clBox.querySelectorAll('input.input')[checklist.length - 1]?.focus(); } }, icon('plus'), 'Add checklist item'));
  };
  drawChecklist();
  const project = projList.find((p) => p.id === t.project_id);
  const milestoneSel = select('milestone_id', [['', 'None'], ...(project?.milestones || []).map((m) => [m.id, m.title])], t.milestone_id || '');
  const projectSel = select('project_id', [['', 'No project'], ...projList.map((p) => [p.id, p.name])], t.project_id || '');
  projectSel.addEventListener('change', () => {
    const p = projList.find((x) => x.id === projectSel.value);
    milestoneSel.replaceChildren(...[['', 'None'], ...(p?.milestones || []).map((m) => [m.id, m.title])].map(([v, l]) => h('option', { value: v }, l)));
  });
  const depOptions = allTasks.filter((x) => x.id !== t.id);
  const depSel = h('select', { class: 'input', name: 'depends_on', multiple: true, size: Math.min(5, Math.max(2, depOptions.length)) }, depOptions.map((x) => h('option', { value: x.id, selected: (t.depends_on || []).includes(x.id) }, x.title)));
  const due = t.due ? dt(t.due) : null;
  const dueHasTime = due && !(due.hour === 23 && due.minute === 59);

  const extraActions = isNew ? [] : [
    { label: 'Delete', danger: true, left: true, onClick: async () => { if (!(await confirmDialog(`Delete "${t.title}" permanently?`, { danger: true, confirmLabel: 'Delete' }))) return false; await del(`/tasks/${t.id}`); toast('Task deleted', { type: 'success' }); emit('data'); onSaved?.(); } },
    { label: t.archived ? 'Unarchive' : 'Archive', ghost: true, onClick: async () => { await patch(`/tasks/${t.id}`, { archived: !t.archived }); emit('data'); onSaved?.(); } },
  ];

  formModal({
    title: isNew ? 'New task' : 'Edit task', wide: true, submitLabel: isNew ? 'Create task' : 'Save', extraActions,
    fields: [
      field('Title', input('title', { value: t.title || '', required: true, maxlength: 300 }), { full: true }),
      field('Status', select('status', [['todo', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']], t.status || 'todo')),
      field('Priority', select('priority', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']], t.priority || 'medium')),
      field('Due date', input('due_date', { type: 'date', value: due ? due.toISODate() : '' })),
      field('Due time (optional)', input('due_time', { type: 'time', value: dueHasTime ? due.toFormat('HH:mm') : '' })),
      field('Estimate (minutes)', input('estimate_minutes', { type: 'number', min: 5, max: 2400, step: 5, value: t.estimate_minutes ?? '' })),
      field('Category', input('category', { value: t.category || '', maxlength: 60, placeholder: 'Work, Personal, Study…' })),
      field('Project', projectSel), field('Milestone', milestoneSel),
      h('div', { class: 'full' }, checkbox('important', 'Important (affects prioritisation)', t.important)),
      field('Description', textarea('description', t.description || '', { rows: 3 }), { full: true }),
      field('Checklist', clBox, { full: true }),
      depOptions.length ? field('Depends on (must finish first)', depSel, { full: true, help: 'Ctrl/Cmd-click to select several.' }) : null,
      ...recurrenceFields(t.recurrence),
    ].filter(Boolean),
    onSubmit: async (fd) => {
      const d = fd.get('due_date');
      const tm = fd.get('due_time');
      const body = {
        title: fd.get('title'), status: fd.get('status'), priority: fd.get('priority'), category: fd.get('category'), description: fd.get('description'),
        important: !!fd.get('important'), estimate_minutes: fd.get('estimate_minutes') ? Number(fd.get('estimate_minutes')) : null,
        due: d ? (tm ? `${d}T${tm}` : d) : null, project_id: fd.get('project_id') || null, milestone_id: fd.get('milestone_id') || null,
        checklist: checklist.filter((c) => c.text.trim()).map((c) => ({ id: c.id, text: c.text.trim(), done: c.done })),
        depends_on: depOptions.length ? [...depSel.selectedOptions].map((o) => o.value) : undefined,
        recurrence: readRecurrence(fd),
      };
      if (t.parent_id) body.parent_id = t.parent_id;
      const saved = isNew ? await post('/tasks', body) : await patch(`/tasks/${t.id}`, body);
      toast(isNew ? 'Task created' : 'Task saved', { type: 'success' });
      if (saved.next_recurrence) toast('Next occurrence created.', { title: 'Recurring task' });
      emit('data');
      onSaved?.(saved);
    },
  });
}

export { dueDateInput, toastError };
