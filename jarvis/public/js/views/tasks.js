import { h, icon, clear, tabs, fmtRelDay, dt, nowZ, emptyState, toast, toastError, debounce, demoBadge, progressBar, durationLabel, formModal, field, input, select, textarea, confirmDialog, openModal, DateTime } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { onState, emit } from '../state.js';
import { taskDialog } from './shared.js';

let tab = 'list';
const filters = { q: '', status: 'open', priority: '', category: '', project_id: '', sort: 'due', archived: false };

export async function render(el, { query }) {
  if (query.get('tab')) tab = query.get('tab');
  const head = h('div', { class: 'page-head' },
    h('div', h('h1', 'Tasks & Projects'), h('p', 'Plan work, school, freelance or personal projects — your way.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => planWithJarvis() }, icon('sparkle'), 'Break down a goal'),
      h('button', { class: 'btn', onclick: () => projectDialog() }, icon('plus'), 'New project'),
      h('button', { class: 'btn primary', onclick: () => taskDialog({}, { onSaved: draw }) }, icon('plus'), 'New task')));
  const tabBar = h('div');
  const body = h('div');
  clear(el, head, tabBar, body);

  async function draw() {
    clear(tabBar, tabs([['list', 'List'], ['board', 'Board'], ['calendar', 'Calendar'], ['projects', 'Projects']], tab, (t) => { tab = t; draw(); }));
    try {
      if (tab === 'list') await listView(body, draw);
      else if (tab === 'board') await boardView(body, draw);
      else if (tab === 'calendar') await calendarView(body, draw);
      else await projectsView(body, draw);
    } catch (e) {
      clear(body, emptyState(e.message));
    }
  }
  await draw();
  if (query.get('task')) get(`/tasks/${query.get('task')}`).then((t) => taskDialog(t, { onSaved: draw })).catch(toastError);
  if (query.get('project')) projectDetail(query.get('project'), draw);
  const off = onState((w) => w === 'data' && draw());
  return () => off();
}

function qs() {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.status && filters.status !== 'all') p.set('status', filters.status);
  if (filters.priority) p.set('priority', filters.priority);
  if (filters.category) p.set('category', filters.category);
  if (filters.project_id) p.set('project_id', filters.project_id);
  if (filters.archived) p.set('archived', '1');
  p.set('sort', filters.sort);
  return p.toString();
}

async function listView(body, redraw) {
  const [tasks, projects, workload] = await Promise.all([get(`/tasks?${qs()}`), get('/projects'), get('/tasks/workload')]);
  const projName = Object.fromEntries(projects.map((p) => [p.id, p]));
  const categories = [...new Set(tasks.map((t) => t.category).filter(Boolean))].sort();
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search tasks…', value: filters.q, 'aria-label': 'Search tasks' });
  search.addEventListener('input', debounce(() => { filters.q = search.value; redraw(); }, 300));
  const sel = (name, opts) => {
    const s = select(name, opts, filters[name]);
    s.setAttribute('aria-label', name);
    s.addEventListener('change', () => { filters[name] = s.value; redraw(); });
    return s;
  };
  const quick = h('input', { class: 'input', placeholder: 'Quick add: type a task and press Enter', 'aria-label': 'Quick add task', maxlength: 300 });
  quick.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !quick.value.trim()) return;
    try {
      await post('/tasks', { title: quick.value.trim(), project_id: filters.project_id || null });
      quick.value = '';
      emit('data');
    } catch (err) { toastError(err); }
  });

  // Build a tree: subtasks render under their parent when both are in the result.
  const ids = new Set(tasks.map((t) => t.id));
  const children = {};
  for (const t of tasks) if (t.parent_id && ids.has(t.parent_id)) (children[t.parent_id] ||= []).push(t);
  const top = tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id));
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));

  const row = (t, depth = 0) => {
    const overdue = t.due && t.status !== 'done' && t.due < new Date().toISOString();
    const cl = t.checklist.length ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : null;
    const waiting = t.depends_on.filter((d) => !doneIds.has(d)).length;
    return [h('div', { class: ['list-item', t.status === 'done' && 'done'], style: { 'padding-left': `${4 + depth * 28}px` } },
      checkBtn(t),
      h('span', { class: `prio ${t.priority}`, title: `${t.priority} priority` }),
      h('button', { class: 'grow', style: { background: 'none', border: 0, color: 'inherit', 'text-align': 'left', cursor: 'pointer', padding: 0, font: 'inherit', 'min-width': 0 }, onclick: () => get(`/tasks/${t.id}`).then((full) => taskDialog(full, { onSaved: redraw })) },
        h('div', { class: 'title truncate' }, t.title, t.important ? h('span', { class: 'badge warning', style: { 'margin-left': '6px' } }, 'Important') : null),
        h('div', { class: 'row tight small faint' },
          t.project_id && projName[t.project_id] ? h('span', { class: 'row tight' }, h('span', { class: 'project-dot', style: { background: projName[t.project_id].color } }), projName[t.project_id].name) : null,
          t.category ? h('span', t.category) : null, cl ? h('span', `☑ ${cl}`) : null, t.estimate_minutes ? h('span', durationLabel(t.estimate_minutes)) : null,
          waiting ? h('span', { class: 'warning' }, `Waiting on ${waiting}`) : null, t.recurrence ? h('span', '↻ repeats') : null, t.status === 'blocked' ? h('span', { class: 'neg' }, 'Blocked') : t.status === 'in_progress' ? h('span', { class: 'accent' }, 'In progress') : null)),
      t.due ? h('span', { class: `small nowrap ${overdue ? 'neg' : 'muted'}` }, overdue ? `Overdue · ${fmtRelDay(t.due)}` : fmtRelDay(t.due)) : null,
      demoBadge(t),
      h('button', { class: 'btn ghost sm icon', 'aria-label': `Add subtask to ${t.title}`, title: 'Add subtask', onclick: () => taskDialog({ parent_id: t.id, project_id: t.project_id }, { onSaved: redraw }) }, icon('plus'))),
    ...(children[t.id] || []).flatMap((c) => row(c, depth + 1))];
  };

  let groups;
  if (filters.sort === 'due') {
    const now = nowZ();
    const endToday = now.endOf('day').toUTC().toISO();
    const endWeek = now.plus({ days: 7 }).endOf('day').toUTC().toISO();
    const g = { Overdue: [], Today: [], 'Next 7 days': [], Later: [], 'No due date': [] };
    for (const t of top) {
      if (!t.due) g['No due date'].push(t);
      else if (t.due < new Date().toISOString() && t.status !== 'done') g.Overdue.push(t);
      else if (t.due <= endToday) g.Today.push(t);
      else if (t.due <= endWeek) g['Next 7 days'].push(t);
      else g.Later.push(t);
    }
    groups = Object.entries(g).filter(([, v]) => v.length);
  } else groups = [['', top]];

  clear(body,
    h('div', { class: 'grid grid-4', style: { 'margin-bottom': '16px' } },
      statCard('Open', workload.open), statCard('Overdue', workload.overdue, workload.overdue ? 'neg' : ''), statCard('Due this week', workload.due_this_week), statCard('Done last 7 days', workload.completed_last_7_days, 'pos', `~${durationLabel(workload.estimated_open_minutes)} of estimated work open`)),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: { 'margin-bottom': '12px' } }, h('div', { class: 'grow', style: { 'min-width': '200px' } }, search),
        sel('status', [['open', 'Open'], ['all', 'All'], ['todo', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']]),
        sel('priority', [['', 'Any priority'], ['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]),
        sel('category', [['', 'Any category'], ...categories.map((c) => [c, c])]),
        sel('project_id', [['', 'Any project'], ...projects.map((p) => [p.id, p.name])]),
        sel('sort', [['due', 'Sort: due date'], ['priority', 'Sort: priority'], ['created', 'Sort: newest'], ['title', 'Sort: title']]),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: filters.archived, onchange: (e) => { filters.archived = e.target.checked; redraw(); } }), 'Archived')),
      quick,
      tasks.length ? groups.map(([label, list]) => h('div', { style: { 'margin-top': '14px' } }, label ? h('div', { class: `small ${label === 'Overdue' ? 'neg' : 'muted'}`, style: { 'font-weight': 600, 'margin-bottom': '4px' } }, `${label} · ${list.length}`) : null, h('div', { class: 'list' }, list.flatMap((t) => row(t))))) : emptyState('No tasks match these filters.')));
}

function statCard(label, value, cls = '', sub) {
  return h('div', { class: 'card stat' }, h('span', { class: 'label' }, label), h('span', { class: `value ${cls}` }, String(value)), sub ? h('span', { class: 'sub' }, sub) : null);
}

function checkBtn(t) {
  const done = t.status === 'done';
  const b = h('button', { class: 'task-check', role: 'checkbox', 'aria-checked': String(done), 'aria-label': `${done ? 'Reopen' : 'Complete'} ${t.title}` }, icon('check'));
  b.addEventListener('click', async () => {
    b.setAttribute('aria-checked', String(!done));
    try {
      const r = await patch(`/tasks/${t.id}`, { status: done ? 'todo' : 'done' });
      if (r.next_recurrence) toast('Next occurrence created.', { title: 'Recurring task' });
      emit('data');
    } catch (e) {
      b.setAttribute('aria-checked', String(done));
      toastError(e);
    }
  });
  return b;
}

async function boardView(body, redraw) {
  const tasks = await get(`/tasks?${new URLSearchParams({ ...(filters.project_id ? { project_id: filters.project_id } : {}), sort: 'priority' })}`);
  const cols = [['todo', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
  const recentDone = tasks.filter((t) => t.status === 'done').slice(0, 25);
  const move = async (id, status) => {
    try {
      await patch(`/tasks/${id}`, { status });
      emit('data');
    } catch (e) { toastError(e); }
  };
  clear(body, h('div', { class: 'board' }, cols.map(([key, label]) => {
    const list = key === 'done' ? recentDone : tasks.filter((t) => t.status === key);
    const col = h('div', { class: 'column', dataset: { status: key }, 'aria-label': label },
      h('div', { class: 'column-head' }, h('span', label), h('span', { class: 'badge' }, String(list.length))),
      list.map((t) => {
        const card = h('div', { class: 'task-card', draggable: 'true', dataset: { id: t.id } },
          h('div', { class: 'row tight' }, h('span', { class: `prio ${t.priority}` }), h('button', { class: 'grow truncate', style: { background: 'none', border: 0, color: 'inherit', 'text-align': 'left', cursor: 'pointer', padding: 0, font: '560 13.5px var(--font)' }, onclick: () => get(`/tasks/${t.id}`).then((full) => taskDialog(full, { onSaved: redraw })) }, t.title)),
          h('div', { class: 'row tight small faint' }, t.due ? h('span', fmtRelDay(t.due)) : null, t.estimate_minutes ? h('span', durationLabel(t.estimate_minutes)) : null, demoBadge(t)),
          h('select', { class: 'input', style: { height: '28px', 'font-size': '12px' }, 'aria-label': `Move ${t.title} to column`, onchange: (e) => move(t.id, e.target.value) }, cols.map(([k, l]) => h('option', { value: k, selected: k === t.status }, l))));
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', t.id); card.classList.add('dragging'); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        return card;
      }),
      key === 'todo' ? h('button', { class: 'btn ghost sm', onclick: () => taskDialog({ status: 'todo' }, { onSaved: redraw }) }, icon('plus'), 'Add task') : null);
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop'); const id = e.dataTransfer.getData('text/plain'); if (id) move(id, key); });
    return col;
  })), h('p', { class: 'small faint', style: { 'margin-top': '8px' } }, 'Drag cards between columns, or use each card\'s menu. The Done column shows the 25 most recent.'));
}

let calCursor = null;
async function calendarView(body, redraw) {
  calCursor ||= nowZ().startOf('month');
  const from = calCursor.startOf('week');
  const to = calCursor.endOf('month').endOf('week');
  const tasks = (await get('/tasks?status=all&sort=due')).filter((t) => t.due);
  const grid = h('div', { class: 'month-grid' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'dow' }, d)));
  const today = nowZ().toISODate();
  for (let d = from; d <= to; d = d.plus({ days: 1 })) {
    const iso = d.toISODate();
    const items = tasks.filter((t) => dt(t.due).toISODate() === iso);
    grid.append(h('div', { class: ['month-cell', d.month !== calCursor.month && 'other', iso === today && 'today'], onclick: (e) => { if (e.target.classList.contains('month-cell') || e.target.classList.contains('day-num')) taskDialog({ due: d.set({ hour: 23, minute: 59 }).toUTC().toISO() }, { onSaved: redraw }); } },
      h('span', { class: 'day-num' }, d.day),
      items.slice(0, 4).map((t) => h('button', { type: 'button', class: ['ev-chip', t.status === 'done' && 'faint'], style: { '--kind': `var(--${t.priority === 'urgent' ? 'danger' : t.priority === 'high' ? 'warning' : 'accent'})` }, onclick: () => get(`/tasks/${t.id}`).then((full) => taskDialog(full, { onSaved: redraw })) }, t.status === 'done' ? '✓ ' : '', t.title)),
      items.length > 4 ? h('span', { class: 'more' }, `+${items.length - 4} more`) : null));
  }
  clear(body, h('div', { class: 'cal-toolbar' },
    h('button', { class: 'btn icon', 'aria-label': 'Previous month', onclick: () => { calCursor = calCursor.minus({ months: 1 }); redraw(); } }, icon('chevronLeft')),
    h('button', { class: 'btn icon', 'aria-label': 'Next month', onclick: () => { calCursor = calCursor.plus({ months: 1 }); redraw(); } }, icon('chevronRight')),
    h('h2', calCursor.toFormat('LLLL yyyy')), h('span', { class: 'small faint' }, 'Tasks by due date. Click a day to add one.')), grid);
}

async function projectsView(body, redraw) {
  const projects = await get('/projects');
  clear(body, projects.length ? h('div', { class: 'grid grid-3' }, projects.map((p) => h('div', { class: 'card project-card', role: 'button', tabindex: 0, onclick: () => projectDetail(p.id, redraw), onkeydown: (e) => e.key === 'Enter' && projectDetail(p.id, redraw) },
    h('div', { class: 'row', style: { 'margin-bottom': '8px' } }, h('span', { class: 'project-dot', style: { background: p.color } }), h('h3', { class: 'grow truncate' }, p.name), demoBadge(p), h('span', { class: 'badge' }, p.status.replace('_', ' '))),
    p.description ? h('p', { class: 'small muted', style: { display: '-webkit-box', '-webkit-line-clamp': '2', '-webkit-box-orient': 'vertical', overflow: 'hidden' } }, p.description) : null,
    progressBar(p.progress, p.progress === 100 ? 'success' : ''),
    h('div', { class: 'row between small muted', style: { 'margin-top': '8px' } }, h('span', `${p.done_count}/${p.task_count} tasks · ${p.progress}%`), p.deadline ? h('span', { class: deadlineClass(p) }, `Due ${fmtRelDay(p.deadline)}`) : null),
    p.milestones.length ? h('div', { class: 'small faint', style: { 'margin-top': '6px' } }, `${p.milestones.filter((m) => m.done).length}/${p.milestones.length} milestones`) : null))) : emptyState('No projects yet.', h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('button', { class: 'btn', onclick: () => projectDialog() }, 'Create a project'), h('button', { class: 'btn primary', onclick: () => planWithJarvis() }, icon('sparkle'), 'Plan one with JARVIS'))));
}

const deadlineClass = (p) => (p.status !== 'completed' && p.deadline < nowZ().toISODate() ? 'neg' : '');

function projectDialog(p = {}, onSaved) {
  formModal({
    title: p.id ? 'Edit project' : 'New project', submitLabel: p.id ? 'Save' : 'Create project',
    extraActions: p.id ? [{ label: 'Delete', danger: true, left: true, onClick: async () => {
      const withTasks = await confirmDialog(`Delete "${p.name}"? Choose whether to delete its tasks too.`, { title: 'Delete project', confirmLabel: 'Delete project and its tasks', danger: true });
      if (!withTasks && !(await confirmDialog('Delete the project but keep its tasks?', { confirmLabel: 'Delete project only', danger: true }))) return false;
      await del(`/projects/${p.id}?tasks=${withTasks ? 1 : 0}`);
      emit('data');
      onSaved?.();
    } }] : [],
    fields: [
      field('Name', input('name', { value: p.name || '', required: true, maxlength: 200 }), { full: true }),
      field('Status', select('status', [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed'], ['archived', 'Archived']], p.status || 'active')),
      field('Category', input('category', { value: p.category || '', placeholder: 'Work, School, Freelance…' })),
      field('Start date', input('start_date', { type: 'date', value: p.start_date || '' })),
      field('Deadline', input('deadline', { type: 'date', value: p.deadline || '' })),
      field('Colour', input('color', { type: 'color', value: p.color || '#3b82f6' })),
      field('Description', textarea('description', p.description || ''), { full: true }),
    ],
    onSubmit: async (fd) => {
      const body = { name: fd.get('name'), status: fd.get('status'), category: fd.get('category'), start_date: fd.get('start_date') || null, deadline: fd.get('deadline') || null, color: fd.get('color'), description: fd.get('description') };
      if (p.id) await patch(`/projects/${p.id}`, body);
      else await post('/projects', body);
      toast(p.id ? 'Project saved' : 'Project created', { type: 'success' });
      emit('data');
      onSaved?.();
    },
  });
}

async function projectDetail(id, redraw) {
  let m;
  const draw = async () => {
    const p = await get(`/projects/${id}`);
    const byMilestone = {};
    for (const t of p.tasks) (byMilestone[t.milestone_id || ''] ||= []).push(t);
    const msInput = h('input', { class: 'input', placeholder: 'New milestone', 'aria-label': 'New milestone title' });
    const msDate = h('input', { class: 'input', type: 'date', 'aria-label': 'Milestone due date', style: { width: '160px' } });
    const bodyEl = h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('span', { class: 'project-dot', style: { background: p.color } }), h('span', { class: 'badge' }, p.status), p.deadline ? h('span', { class: `small ${deadlineClass(p)}` }, `Deadline ${p.deadline}`) : null, h('span', { class: 'small muted' }, `${p.done_count}/${p.task_count} tasks done`)),
      progressBar(p.progress),
      p.description ? h('p', { class: 'muted' }, p.description) : null,
      h('h3', 'Milestones'),
      h('div', { class: 'list' }, p.milestones.map((ms) => h('div', { class: ['list-item', ms.done && 'done'] },
        h('button', { class: 'task-check', role: 'checkbox', 'aria-checked': String(ms.done), 'aria-label': `Milestone ${ms.title} done`, onclick: async () => { await patch(`/milestones/${ms.id}`, { done: !ms.done }); draw(); } }, icon('check')),
        h('span', { class: 'grow title' }, ms.title), ms.due_date ? h('span', { class: 'small muted' }, ms.due_date) : null,
        h('button', { class: 'btn ghost sm icon', 'aria-label': `Delete milestone ${ms.title}`, onclick: async () => { if (await confirmDialog(`Delete milestone "${ms.title}"? Its tasks stay in the project.`, { danger: true, confirmLabel: 'Delete' })) { await del(`/milestones/${ms.id}`); draw(); } } }, icon('trash'))))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, msInput), msDate, h('button', { class: 'btn', onclick: async () => { if (!msInput.value.trim()) return; await post(`/projects/${id}/milestones`, { title: msInput.value.trim(), due_date: msDate.value || null }); draw(); } }, 'Add')),
      h('h3', 'Tasks'),
      [...p.milestones.map((ms) => [ms.title, byMilestone[ms.id] || []]), ['Unassigned', byMilestone[''] || []]].filter(([, l]) => l.length).map(([label, list]) => h('div',
        h('div', { class: 'small muted', style: { 'font-weight': 600 } }, label),
        h('div', { class: 'list' }, list.map((t) => h('div', { class: ['list-item', t.status === 'done' && 'done'] }, checkBtn(t), h('span', { class: `prio ${t.priority}` }), h('button', { class: 'grow truncate title', style: { background: 'none', border: 0, color: 'inherit', 'text-align': 'left', cursor: 'pointer', padding: 0, font: 'inherit' }, onclick: () => taskDialog(t, { onSaved: draw }) }, t.title), t.depends_on.length ? h('span', { class: 'small faint' }, `${t.depends_on.length} dep.`) : null, t.due ? h('span', { class: 'small muted' }, fmtRelDay(t.due)) : null))))),
      h('button', { class: 'btn', onclick: () => taskDialog({ project_id: id }, { onSaved: draw }) }, icon('plus'), 'Add task to project'));
    if (m) m.dialog.querySelector('.modal-body').replaceChildren(bodyEl);
    else {
      m = openModal({ title: p.name, body: bodyEl, wide: true, actions: [{ label: 'Edit project', onClick: () => { projectDialog(p, () => { m?.close(); redraw(); }); return false; } }, { label: 'Close', primary: true }], onClose: () => { m = null; redraw(); } });
    }
  };
  try { await draw(); } catch (e) { toastError(e); }
}

/** Hand a broad goal to the assistant, which proposes milestones/tasks for approval. */
function planWithJarvis() {
  const n = nowZ();
  formModal({
    title: 'Break down a goal', submitLabel: 'Ask JARVIS for a plan',
    fields: [
      field('What do you want to achieve?', textarea('goal', '', { rows: 3, placeholder: 'e.g. Launch my bakery\'s website', maxlength: 1000 }), { full: true }),
      field('Deadline', input('deadline', { type: 'date', value: n.plus({ weeks: 2 }).toISODate() })),
      field('Context (optional)', input('context', { placeholder: 'Freelance client, school project…' })),
      h('p', { class: 'help full' }, 'JARVIS proposes stages, tasks, dependencies and deadlines. You review the plan before anything is saved.'),
    ],
    onSubmit: (fd) => {
      const goal = String(fd.get('goal') || '').trim();
      if (!goal) throw new Error('Describe the goal first.');
      const deadline = fd.get('deadline');
      const text = `Help me ${goal.replace(/^help me\s+/i, '')}${deadline ? ` by ${DateTime.fromISO(deadline).toFormat('d LLLL yyyy')}` : ''}${fd.get('context') ? ` (${fd.get('context')})` : ''}. Break it into milestones and smaller tasks with dependencies and deadlines, and show me the plan before saving.`;
      location.hash = `#/assistant?q=${encodeURIComponent(text)}`;
    },
  });
}
