import { z } from 'zod';
import { db, id, nowIso, updateRow, audit, tx } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime, parseInZone, toUtcIso, recurrenceSchema, nextOccurrence } from './time.js';
import { HttpError, notFound } from '../http.js';

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const checklistItem = z.object({ id: z.string().max(40).optional(), text: z.string().trim().min(1).max(300), done: z.boolean().default(false) });

export const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).optional().default(''),
  status: z.enum(STATUSES).optional().default('todo'),
  priority: z.enum(PRIORITIES).optional().default('medium'),
  important: z.boolean().optional().default(false),
  category: z.string().trim().max(60).optional().default(''),
  due: z.string().nullable().optional().describe('Due date (YYYY-MM-DD) or ISO date-time; interpreted in the user time zone'),
  estimate_minutes: z.number().int().min(5).max(60 * 40).nullable().optional(),
  project_id: z.string().nullable().optional(),
  milestone_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  checklist: z.array(checklistItem).max(100).optional().default([]),
  recurrence: recurrenceSchema.nullable().optional(),
  depends_on: z.array(z.string()).max(50).optional(),
});

export const taskPatch = taskInput.partial().extend({ archived: z.boolean().optional() });

const COLUMNS = ['title', 'description', 'status', 'priority', 'important', 'category', 'due_at', 'estimate_minutes', 'project_id', 'milestone_id', 'parent_id', 'checklist', 'recurrence', 'completed_at', 'archived', 'updated_at', 'sort'];

/** A bare date means "end of that day" in the user's zone so it sorts after timed items. */
export function resolveDue(due, zone) {
  if (due == null || due === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return toUtcIso(DateTime.fromISO(due, { zone }).set({ hour: 23, minute: 59 }));
  return toUtcIso(parseInZone(due, zone));
}

export function serializeTask(row, deps) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    important: !!row.important,
    category: row.category,
    due: row.due_at,
    estimate_minutes: row.estimate_minutes,
    project_id: row.project_id,
    milestone_id: row.milestone_id,
    parent_id: row.parent_id,
    checklist: JSON.parse(row.checklist || '[]'),
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    completed_at: row.completed_at,
    archived: !!row.archived,
    is_demo: !!row.is_demo,
    created_at: row.created_at,
    depends_on: deps ?? db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ?').all(row.id).map((r) => r.depends_on_id),
  };
}

export function getTaskRow(userId, taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) throw notFound('Task');
  return row;
}

export const getTask = (userId, taskId) => serializeTask(getTaskRow(userId, taskId));

export function listTasks(userId, f = {}) {
  const where = ['user_id = ?'];
  const args = [userId];
  if (!f.include_archived) where.push('archived = 0');
  if (f.status === 'open') where.push("status != 'done'");
  else if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.priority) { where.push('priority = ?'); args.push(f.priority); }
  if (f.project_id) { where.push('project_id = ?'); args.push(f.project_id); }
  if (f.category) { where.push('category = ?'); args.push(f.category); }
  if (f.parent_id === null) where.push('parent_id IS NULL');
  else if (f.parent_id) { where.push('parent_id = ?'); args.push(f.parent_id); }
  if (f.due_before) { where.push('due_at IS NOT NULL AND due_at < ?'); args.push(f.due_before); }
  if (f.due_after) { where.push('due_at IS NOT NULL AND due_at >= ?'); args.push(f.due_after); }
  if (f.overdue) { where.push("due_at IS NOT NULL AND due_at < ? AND status != 'done'"); args.push(nowIso()); }
  if (f.query) {
    where.push('(lower(title) LIKE ? OR lower(description) LIKE ? OR lower(category) LIKE ?)');
    const q = `%${String(f.query).toLowerCase()}%`;
    args.push(q, q, q);
  }
  const order = {
    due: 'due_at IS NULL, due_at ASC',
    priority: "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_at IS NULL, due_at",
    created: 'created_at DESC',
    title: 'title COLLATE NOCASE',
  }[f.sort || 'due'] || 'due_at IS NULL, due_at ASC';
  const limit = Math.min(Number(f.limit) || 500, 1000);
  const rows = db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY ${order}, sort, created_at LIMIT ${limit}`).all(...args);
  const deps = depsFor(rows.map((r) => r.id));
  return rows.map((r) => serializeTask(r, deps.get(r.id) || []));
}

function depsFor(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT task_id, depends_on_id FROM task_deps WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const r of rows) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id).push(r.depends_on_id);
  }
  return map;
}

function assertRefs(userId, input, selfId) {
  if (input.project_id && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND user_id = ?').get(input.project_id, userId)) throw notFound('Project');
  if (input.milestone_id && !db.prepare('SELECT 1 FROM milestones WHERE id = ? AND user_id = ?').get(input.milestone_id, userId)) throw notFound('Milestone');
  if (input.parent_id) {
    if (input.parent_id === selfId) throw new HttpError(400, 'A task cannot be its own parent.');
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(input.parent_id, userId)) throw notFound('Parent task');
  }
}

function setDeps(userId, taskId, dependsOn) {
  db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
  for (const dep of new Set(dependsOn)) {
    if (dep === taskId) throw new HttpError(400, 'A task cannot depend on itself.');
    if (!db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(dep, userId)) throw notFound('Dependency task');
    if (reaches(dep, taskId)) throw new HttpError(400, 'That dependency would create a cycle.');
    db.prepare('INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dep);
  }
}

/** Does `from` (transitively) depend on `target`? */
function reaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ?').all(from).some((r) => reaches(r.depends_on_id, target, seen));
}

const withIds = (list) => list.map((c) => ({ id: c.id || id().slice(0, 8), text: c.text, done: !!c.done }));

export function createTask(userId, raw, { actor = 'user', isDemo = false } = {}) {
  const input = taskInput.parse(raw);
  const zone = getSettings(userId).timezone;
  assertRefs(userId, input);
  const taskId = id();
  const now = nowIso();
  tx(() => {
    db.prepare(`INSERT INTO tasks (id, user_id, project_id, milestone_id, parent_id, title, description, status, priority, important, category, due_at, estimate_minutes, checklist, recurrence, completed_at, is_demo, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId, userId, input.project_id ?? null, input.milestone_id ?? null, input.parent_id ?? null, input.title, input.description,
      input.status, input.priority, input.important ? 1 : 0, input.category, resolveDue(input.due, zone), input.estimate_minutes ?? null,
      JSON.stringify(withIds(input.checklist)), input.recurrence ? JSON.stringify(input.recurrence) : null,
      input.status === 'done' ? now : null, isDemo ? 1 : 0, now, now,
    );
    if (input.depends_on?.length) setDeps(userId, taskId, input.depends_on);
  });
  audit(userId, actor, 'create', 'task', taskId, input.title);
  return getTask(userId, taskId);
}

export function updateTask(userId, taskId, raw, { actor = 'user' } = {}) {
  const existing = getTaskRow(userId, taskId);
  const input = taskPatch.parse(raw);
  const zone = getSettings(userId).timezone;
  assertRefs(userId, input, taskId);
  const patch = { ...input, updated_at: nowIso() };
  delete patch.due; delete patch.depends_on;
  if ('due' in input) patch.due_at = resolveDue(input.due, zone);
  if (input.checklist) patch.checklist = withIds(input.checklist);
  if ('recurrence' in input) patch.recurrence = input.recurrence ? JSON.stringify(input.recurrence) : null;
  let spawned = null;
  if (input.status === 'done' && existing.status !== 'done') {
    patch.completed_at = nowIso();
    spawned = spawnNextRecurrence(userId, existing, zone);
  } else if (input.status && input.status !== 'done') patch.completed_at = null;
  tx(() => {
    updateRow('tasks', userId, taskId, patch, COLUMNS);
    if (input.depends_on) setDeps(userId, taskId, input.depends_on);
  });
  audit(userId, actor, 'update', 'task', taskId, Object.keys(input).join(','));
  const task = getTask(userId, taskId);
  return spawned ? { ...task, next_recurrence: spawned } : task;
}

/** Completing a recurring task creates its next instance. */
function spawnNextRecurrence(userId, row, zone) {
  if (!row.recurrence) return null;
  const base = row.due_at || nowIso();
  const next = nextOccurrence(base, row.recurrence, zone, DateTime.fromISO(base, { zone: 'utc' }).setZone(zone));
  if (!next) return null;
  const t = createTask(userId, {
    title: row.title, description: row.description, priority: row.priority, important: !!row.important, category: row.category,
    due: toUtcIso(next), estimate_minutes: row.estimate_minutes, project_id: row.project_id,
    checklist: JSON.parse(row.checklist).map((c) => ({ text: c.text, done: false })), recurrence: JSON.parse(row.recurrence),
  }, { actor: 'system' });
  // The recurrence now lives on the new instance.
  db.prepare('UPDATE tasks SET recurrence = NULL WHERE id = ? AND user_id = ?').run(row.id, userId);
  return t.id;
}

export function deleteTask(userId, taskId, { actor = 'user' } = {}) {
  const t = getTaskRow(userId, taskId);
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, userId);
  audit(userId, actor, 'delete', 'task', taskId, t.title);
  return { deleted: true, title: t.title };
}

/**
 * Score for "what should I do next". Combines urgency (time to due date),
 * explicit priority and importance, and lowers blocked/dependent work.
 */
export function scoreTask(t, now = DateTime.utc()) {
  const pri = { urgent: 40, high: 28, medium: 15, low: 5 }[t.priority] || 10;
  let urgency = 0;
  if (t.due) {
    const hours = DateTime.fromISO(t.due, { zone: 'utc' }).diff(now, 'hours').hours;
    if (hours < 0) urgency = 45;
    else if (hours < 24) urgency = 35;
    else if (hours < 72) urgency = 22;
    else if (hours < 168) urgency = 12;
    else urgency = 4;
  }
  const blocked = t.status === 'blocked' ? -30 : 0;
  return pri + urgency + (t.important ? 20 : 0) + blocked;
}

/** Eisenhower matrix: urgent = due within 48h or overdue or priority urgent. */
export function prioritize(userId) {
  const now = DateTime.utc();
  const open = listTasks(userId, { status: 'open', parent_id: null });
  const doneIds = new Set(db.prepare("SELECT id FROM tasks WHERE user_id = ? AND status = 'done'").all(userId).map((r) => r.id));
  const quadrants = { do_now: [], schedule: [], delegate_or_batch: [], drop_or_later: [] };
  for (const t of open) {
    const dueH = t.due ? DateTime.fromISO(t.due, { zone: 'utc' }).diff(now, 'hours').hours : Infinity;
    const urgent = t.priority === 'urgent' || dueH < 48;
    const important = t.important || t.priority === 'high' || t.priority === 'urgent';
    const waitingOn = t.depends_on.filter((d) => !doneIds.has(d));
    const item = { id: t.id, title: t.title, due: t.due, priority: t.priority, score: scoreTask(t, now), overdue: dueH < 0, waiting_on: waitingOn.length };
    const q = urgent && important ? 'do_now' : important ? 'schedule' : urgent ? 'delegate_or_batch' : 'drop_or_later';
    quadrants[q].push(item);
  }
  for (const k of Object.keys(quadrants)) quadrants[k].sort((a, b) => b.score - a.score);
  return quadrants;
}

export function workloadSummary(userId) {
  const zone = getSettings(userId).timezone;
  const now = DateTime.now().setZone(zone);
  const endToday = toUtcIso(now.endOf('day'));
  const endWeek = toUtcIso(now.plus({ days: 7 }).endOf('day'));
  const q = (sql, ...a) => db.prepare(sql).get(userId, ...a).n;
  return {
    open: q("SELECT COUNT(*) n FROM tasks WHERE user_id = ? AND status != 'done' AND archived = 0"),
    overdue: q("SELECT COUNT(*) n FROM tasks WHERE user_id = ? AND status != 'done' AND archived = 0 AND due_at < ?", nowIso()),
    due_today: q("SELECT COUNT(*) n FROM tasks WHERE user_id = ? AND status != 'done' AND archived = 0 AND due_at >= ? AND due_at <= ?", nowIso(), endToday),
    due_this_week: q("SELECT COUNT(*) n FROM tasks WHERE user_id = ? AND status != 'done' AND archived = 0 AND due_at >= ? AND due_at <= ?", nowIso(), endWeek),
    completed_last_7_days: q("SELECT COUNT(*) n FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at >= ?", toUtcIso(now.minus({ days: 7 }))),
    estimated_open_minutes: db.prepare("SELECT COALESCE(SUM(estimate_minutes),0) n FROM tasks WHERE user_id = ? AND status != 'done' AND archived = 0").get(userId).n,
  };
}
