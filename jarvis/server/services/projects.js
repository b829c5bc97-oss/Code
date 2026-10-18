import { z } from 'zod';
import { db, id, nowIso, updateRow, audit, tx } from '../db.js';
import { createTask, listTasks } from './tasks.js';
import { notFound, HttpError } from '../http.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const projectInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10000).optional().default(''),
  status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional().default('active'),
  category: z.string().trim().max(60).optional().default(''),
  start_date: date.nullable().optional(),
  deadline: date.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#3b82f6'),
});
export const projectPatch = projectInput.partial();

export const milestoneInput = z.object({
  title: z.string().trim().min(1).max(200),
  due_date: date.nullable().optional(),
  done: z.boolean().optional(),
});

/** A full plan (as proposed by the assistant or the plan builder) saved atomically. */
export const projectPlanInput = z.object({
  project: projectInput,
  milestones: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    due_date: date.nullable().optional(),
    tasks: z.array(z.object({
      key: z.string().max(40).optional().describe('Short identifier used by depends_on within this plan'),
      title: z.string().trim().min(1).max(300),
      description: z.string().max(4000).optional(),
      due: date.nullable().optional(),
      estimate_minutes: z.number().int().min(5).max(2400).nullable().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      depends_on: z.array(z.string().max(40)).max(20).optional().describe('keys of tasks in this plan'),
    })).max(60),
  })).min(1).max(20),
});

export function serializeProject(row) {
  const counts = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done FROM tasks WHERE project_id = ? AND user_id = ? AND archived = 0").get(row.id, row.user_id);
  const milestones = db.prepare('SELECT * FROM milestones WHERE project_id = ? AND user_id = ? ORDER BY sort, due_date').all(row.id, row.user_id)
    .map((m) => ({ id: m.id, title: m.title, due_date: m.due_date, done: !!m.done }));
  const total = counts.total || 0;
  const done = counts.done || 0;
  return {
    id: row.id, name: row.name, description: row.description, status: row.status, category: row.category,
    start_date: row.start_date, deadline: row.deadline, color: row.color, is_demo: !!row.is_demo,
    task_count: total, done_count: done, progress: total ? Math.round((done / total) * 100) : 0, milestones,
  };
}

export function getProjectRow(userId, projectId) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  if (!row) throw notFound('Project');
  return row;
}

export const getProject = (userId, projectId) => serializeProject(getProjectRow(userId, projectId));

export function listProjects(userId, { status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM projects WHERE user_id = ? AND status = ? ORDER BY deadline IS NULL, deadline').all(userId, status)
    : db.prepare("SELECT * FROM projects WHERE user_id = ? AND status != 'archived' ORDER BY deadline IS NULL, deadline").all(userId);
  return rows.map(serializeProject);
}

export function createProject(userId, raw, { actor = 'user', isDemo = false } = {}) {
  const p = projectInput.parse(raw);
  if (p.start_date && p.deadline && p.deadline < p.start_date) throw new HttpError(400, 'Deadline is before the start date.');
  const pid = id();
  const now = nowIso();
  db.prepare('INSERT INTO projects (id, user_id, name, description, status, category, start_date, deadline, color, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(pid, userId, p.name, p.description, p.status, p.category, p.start_date ?? null, p.deadline ?? null, p.color, isDemo ? 1 : 0, now, now);
  audit(userId, actor, 'create', 'project', pid, p.name);
  return getProject(userId, pid);
}

export function updateProject(userId, projectId, raw, { actor = 'user' } = {}) {
  getProjectRow(userId, projectId);
  const p = projectPatch.parse(raw);
  updateRow('projects', userId, projectId, { ...p, updated_at: nowIso() }, ['name', 'description', 'status', 'category', 'start_date', 'deadline', 'color', 'updated_at']);
  audit(userId, actor, 'update', 'project', projectId, Object.keys(p).join(','));
  return getProject(userId, projectId);
}

export function deleteProject(userId, projectId, { deleteTasks = false, actor = 'user' } = {}) {
  const row = getProjectRow(userId, projectId);
  tx(() => {
    if (deleteTasks) db.prepare('DELETE FROM tasks WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(projectId, userId);
  });
  audit(userId, actor, 'delete', 'project', projectId, row.name);
  return { deleted: true, name: row.name };
}

export function addMilestone(userId, projectId, raw) {
  getProjectRow(userId, projectId);
  const m = milestoneInput.parse(raw);
  const mid = id();
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM milestones WHERE project_id = ?').get(projectId).s;
  db.prepare('INSERT INTO milestones (id, user_id, project_id, title, due_date, done, sort) VALUES (?,?,?,?,?,?,?)').run(mid, userId, projectId, m.title, m.due_date ?? null, m.done ? 1 : 0, sort);
  return mid;
}

export function updateMilestone(userId, milestoneId, raw) {
  const m = milestoneInput.partial().parse(raw);
  if (!updateRow('milestones', userId, milestoneId, m, ['title', 'due_date', 'done'])) throw notFound('Milestone');
}

export function deleteMilestone(userId, milestoneId) {
  if (!db.prepare('DELETE FROM milestones WHERE id = ? AND user_id = ?').run(milestoneId, userId).changes) throw notFound('Milestone');
}

export function createProjectFromPlan(userId, raw, { actor = 'user' } = {}) {
  const plan = projectPlanInput.parse(raw);
  return tx(() => {
    const project = createProject(userId, plan.project, { actor });
    const keyToId = new Map();
    const pendingDeps = [];
    let taskCount = 0;
    for (const ms of plan.milestones) {
      const mid = addMilestone(userId, project.id, { title: ms.title, due_date: ms.due_date ?? null });
      for (const t of ms.tasks) {
        const task = createTask(userId, {
          title: t.title, description: t.description || '', due: t.due ?? null, estimate_minutes: t.estimate_minutes ?? null,
          priority: t.priority || 'medium', project_id: project.id, milestone_id: mid,
        }, { actor });
        taskCount += 1;
        if (t.key) keyToId.set(t.key, task.id);
        if (t.depends_on?.length) pendingDeps.push([task.id, t.depends_on]);
      }
    }
    for (const [taskId, keys] of pendingDeps) {
      for (const k of keys) {
        const dep = keyToId.get(k);
        if (dep && dep !== taskId) db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dep);
      }
    }
    return { project: getProject(userId, project.id), task_count: taskCount };
  });
}

export function projectDetail(userId, projectId) {
  return { ...getProject(userId, projectId), tasks: listTasks(userId, { project_id: projectId, include_archived: false }) };
}
