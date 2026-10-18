import express from 'express';
import { z } from 'zod';
import { db, id, nowIso, audit } from '../db.js';
import { parseBody, HttpError } from '../http.js';
import { getSettings, updateSettings } from '../settings.js';
import { DateTime, toUtcIso, parseInZone } from '../services/time.js';
import * as events from '../services/events.js';
import * as tasks from '../services/tasks.js';
import * as projects from '../services/projects.js';
import * as reminders from '../services/reminders.js';
import * as notes from '../services/notes.js';
import * as planning from '../services/planning.js';
import { subscribe } from '../services/bus.js';
import { loadDemoData, clearDemoData, demoCounts } from '../services/demoData.js';
import { schedulerState } from '../scheduler.js';

export const core = express.Router();
const uid = (req) => req.user.id;
const zoneOf = (req) => getSettings(uid(req)).timezone;

// ---------- settings ----------
core.get('/settings', (req, res) => res.json(getSettings(uid(req))));
core.patch('/settings', (req, res) => {
  try {
    res.json(updateSettings(uid(req), req.body || {}));
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    throw e;
  }
});
core.patch('/profile', (req, res) => {
  const b = parseBody(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(b.name, uid(req));
  updateSettings(uid(req), { profile: { displayName: b.name } });
  res.json({ ok: true });
});

core.get('/memories', (req, res) => res.json(db.prepare('SELECT id, content, source, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC').all(uid(req))));
core.post('/memories', (req, res) => {
  const b = parseBody(z.object({ content: z.string().trim().min(3).max(500) }), req.body);
  const mid = id();
  db.prepare('INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?,?,?,?,?)').run(mid, uid(req), b.content, 'user', nowIso());
  res.status(201).json({ id: mid });
});
core.delete('/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, uid(req));
  res.json({ ok: true });
});

// ---------- demo data ----------
core.get('/demo', (req, res) => res.json({ counts: demoCounts(uid(req)), demoMode: getSettings(uid(req)).demoMode }));
core.post('/demo/load', (req, res) => res.json({ counts: loadDemoData(uid(req)) }));
core.post('/demo/clear', (req, res) => {
  clearDemoData(uid(req));
  res.json({ ok: true });
});

// ---------- dashboard ----------
core.get('/overview', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  res.json(planning.briefing(uid(req), date));
});

// ---------- events ----------
core.get('/events', (req, res) => {
  const zone = zoneOf(req);
  if (req.query.search) return res.json(events.searchEvents(uid(req), String(req.query.search)));
  const from = req.query.from ? toUtcIso(parseInZone(String(req.query.from), zone)) : toUtcIso(DateTime.now().setZone(zone).startOf('month'));
  const to = req.query.to ? toUtcIso(parseInZone(String(req.query.to), zone)) : toUtcIso(DateTime.now().setZone(zone).endOf('month'));
  res.json(events.listOccurrences(uid(req), from, to, { query: req.query.q ? String(req.query.q) : undefined, kind: req.query.kind ? String(req.query.kind) : undefined }));
});
core.get('/events/:id', (req, res) => res.json(events.serializeEvent(events.getEvent(uid(req), req.params.id))));
core.post('/events', (req, res) => {
  const allow = req.body?.allow_conflict === true;
  const { allow_conflict, ...body } = req.body || {};
  const r = events.createEvent(uid(req), parseBody(events.eventInput, body), { allowConflict: allow });
  if (!r.created) return res.status(409).json({ error: 'This time overlaps other events.', conflicts: r.conflicts });
  res.status(201).json(r);
});
core.patch('/events/:id', (req, res) => {
  const allow = req.body?.allow_conflict === true;
  const { allow_conflict, ...body } = req.body || {};
  const r = events.updateEvent(uid(req), req.params.id, parseBody(events.eventPatch, body), { allowConflict: allow });
  if (!r.updated) return res.status(409).json({ error: 'The new time overlaps other events.', conflicts: r.conflicts });
  res.json(r);
});
core.delete('/events/:id', (req, res) => res.json(events.deleteEvent(uid(req), req.params.id, { occurrenceStart: req.query.occurrence ? String(req.query.occurrence) : undefined })));
core.post('/calendar/conflicts', (req, res) => {
  const b = parseBody(z.object({ start: z.string(), end: z.string(), exclude_id: z.string().optional() }), req.body);
  const zone = zoneOf(req);
  res.json(events.findConflicts(uid(req), toUtcIso(parseInZone(b.start, zone)), toUtcIso(parseInZone(b.end, zone)), b.exclude_id));
});
core.post('/calendar/free-slots', (req, res) => {
  const b = parseBody(z.object({ from: z.string(), to: z.string(), duration: z.number().int().min(5).max(600).default(30), working_hours_only: z.boolean().default(true) }), req.body);
  const zone = zoneOf(req);
  res.json(planning.freeSlots(uid(req), toUtcIso(parseInZone(b.from, zone)), toUtcIso(parseInZone(b.to, zone)), { duration: b.duration, workingHoursOnly: b.working_hours_only }));
});

// ---------- planning ----------
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
core.get('/plan/day', (req, res) => res.json(planning.planDay(uid(req), parseBody(dateParam, req.query.date))));
core.post('/plan/apply', (req, res) => res.json(planning.applyPlan(uid(req), req.body)));
core.get('/plan/reschedule', (req, res) => res.json(planning.rescheduleUnfinished(uid(req), parseBody(dateParam, req.query.from), parseBody(dateParam, req.query.to))));
core.get('/plan/shutdown', (req, res) => res.json(planning.shutdown(uid(req), req.query.date ? parseBody(dateParam, req.query.date) : undefined)));
core.get('/plan/meetings', (req, res) => res.json(planning.meetingPrep(uid(req), req.query.date ? parseBody(dateParam, req.query.date) : undefined)));

// ---------- tasks ----------
core.get('/tasks', (req, res) => {
  const q = req.query;
  res.json(tasks.listTasks(uid(req), {
    status: q.status === 'all' ? undefined : q.status, priority: q.priority, project_id: q.project_id, category: q.category, query: q.q, sort: q.sort,
    overdue: q.overdue === '1', include_archived: q.archived === '1', parent_id: q.top === '1' ? null : q.parent_id,
  }));
});
core.get('/tasks/prioritized', (req, res) => res.json(tasks.prioritize(uid(req))));
core.get('/tasks/workload', (req, res) => res.json(tasks.workloadSummary(uid(req))));
core.get('/tasks/:id', (req, res) => {
  const t = tasks.getTask(uid(req), req.params.id);
  res.json({ ...t, subtasks: tasks.listTasks(uid(req), { parent_id: t.id, include_archived: true }) });
});
core.post('/tasks', (req, res) => res.status(201).json(tasks.createTask(uid(req), parseBody(tasks.taskInput, req.body))));
core.patch('/tasks/:id', (req, res) => res.json(tasks.updateTask(uid(req), req.params.id, parseBody(tasks.taskPatch, req.body))));
core.delete('/tasks/:id', (req, res) => res.json(tasks.deleteTask(uid(req), req.params.id)));

// ---------- projects ----------
core.get('/projects', (req, res) => res.json(projects.listProjects(uid(req), { status: req.query.status })));
core.get('/projects/:id', (req, res) => res.json(projects.projectDetail(uid(req), req.params.id)));
core.post('/projects', (req, res) => res.status(201).json(projects.createProject(uid(req), parseBody(projects.projectInput, req.body))));
core.post('/projects/plan', (req, res) => res.status(201).json(projects.createProjectFromPlan(uid(req), parseBody(projects.projectPlanInput, req.body))));
core.patch('/projects/:id', (req, res) => res.json(projects.updateProject(uid(req), req.params.id, parseBody(projects.projectPatch, req.body))));
core.delete('/projects/:id', (req, res) => res.json(projects.deleteProject(uid(req), req.params.id, { deleteTasks: req.query.tasks === '1' })));
core.post('/projects/:id/milestones', (req, res) => res.status(201).json({ id: projects.addMilestone(uid(req), req.params.id, req.body) }));
core.patch('/milestones/:id', (req, res) => {
  projects.updateMilestone(uid(req), req.params.id, req.body);
  res.json({ ok: true });
});
core.delete('/milestones/:id', (req, res) => {
  projects.deleteMilestone(uid(req), req.params.id);
  res.json({ ok: true });
});

// ---------- reminders & notifications ----------
core.get('/reminders', (req, res) => res.json(reminders.listReminders(uid(req), { status: req.query.status })));
core.post('/reminders', (req, res) => res.status(201).json(reminders.createReminder(uid(req), parseBody(reminders.reminderInput, req.body))));
core.patch('/reminders/:id', (req, res) => res.json(reminders.updateReminder(uid(req), req.params.id, req.body)));
core.post('/reminders/:id/snooze', (req, res) => res.json(reminders.snoozeReminder(uid(req), req.params.id, Math.min(Math.max(Number(req.body?.minutes) || 10, 1), 10080))));
core.delete('/reminders/:id', (req, res) => res.json(reminders.deleteReminder(uid(req), req.params.id)));

core.get('/notifications', (req, res) => {
  const list = reminders.listNotifications(uid(req), { unread: req.query.unread === '1' });
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(uid(req)).n;
  res.json({ notifications: list, unread, scheduler: { running: schedulerState.enabled, last_run_at: schedulerState.lastRunAt, last_error: schedulerState.lastError } });
});
core.post('/notifications/read', (req, res) => {
  const b = parseBody(z.object({ ids: z.union([z.literal('all'), z.array(z.string()).max(500)]) }), req.body);
  res.json({ updated: reminders.markNotificationsRead(uid(req), b.ids) });
});
core.delete('/notifications', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(uid(req));
  res.json({ ok: true });
});

/** Server-sent events: pushes new notifications to open tabs (in addition to polling). */
core.get('/stream', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const unsub = subscribe(uid(req), (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
});

// ---------- notes ----------
core.get('/notes', (req, res) => res.json(notes.listNotes(uid(req), { query: req.query.q, category: req.query.category, tag: req.query.tag, project_id: req.query.project_id })));
core.get('/notes/meta', (req, res) => res.json(notes.noteMeta(uid(req))));
core.get('/notes/:id', (req, res) => {
  const n = notes.getNote(uid(req), req.params.id);
  res.json({ ...n, action_items: notes.extractActionItems(n.content) });
});
core.post('/notes', (req, res) => res.status(201).json(notes.createNote(uid(req), parseBody(notes.noteInput, req.body))));
core.patch('/notes/:id', (req, res) => res.json(notes.updateNote(uid(req), req.params.id, req.body)));
core.delete('/notes/:id', (req, res) => res.json(notes.deleteNote(uid(req), req.params.id)));
core.post('/notes/:id/to-tasks', (req, res) => {
  const n = notes.getNote(uid(req), req.params.id);
  const b = parseBody(z.object({ items: z.array(z.string().trim().min(1).max(300)).min(1).max(50), project_id: z.string().nullable().optional(), due: z.string().nullable().optional() }), req.body);
  const created = b.items.map((title) => tasks.createTask(uid(req), { title, description: `From note: ${n.title}`, project_id: b.project_id ?? n.project_id ?? null, due: b.due ?? null }));
  res.status(201).json({ created });
});

// ---------- data export / deletion / activity ----------
const EXPORT_TABLES = ['events', 'tasks', 'task_deps', 'projects', 'milestones', 'categories', 'transactions', 'budgets', 'bills', 'savings_goals', 'reminders', 'notes', 'memories', 'conversations', 'messages', 'notifications', 'email_drafts', 'audit_log'];
core.get('/export', (req, res) => {
  const u = uid(req);
  const out = { exported_at: nowIso(), user: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(u), settings: getSettings(u) };
  for (const t of EXPORT_TABLES) {
    out[t] = t === 'task_deps'
      ? db.prepare('SELECT d.* FROM task_deps d JOIN tasks t ON t.id = d.task_id WHERE t.user_id = ?').all(u)
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(u);
  }
  out.integrations = db.prepare('SELECT provider, status, account_email, scopes, last_sync_at FROM integrations WHERE user_id = ?').all(u);
  audit(u, 'user', 'export', null, null);
  res.set('content-disposition', `attachment; filename="jarvis-export-${DateTime.now().toISODate()}.json"`);
  res.json(out);
});
core.get('/activity', (req, res) => res.json(db.prepare('SELECT actor, action, entity_type, entity_id, details, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(uid(req))));
core.post('/account/delete', (req, res) => {
  const b = parseBody(z.object({ confirm: z.literal('DELETE') }), req.body);
  void b;
  db.prepare('DELETE FROM users WHERE id = ?').run(uid(req)); // cascades to every user-owned table
  res.clearCookie('jarvis_sid', { path: '/' });
  res.clearCookie('__Host-jarvis_sid', { path: '/' });
  res.json({ deleted: true });
});
core.post('/data/clear', (req, res) => {
  const b = parseBody(z.object({ scope: z.enum(['assistant_history', 'notifications', 'all_content']) }), req.body);
  const u = uid(req);
  if (b.scope === 'assistant_history') db.prepare('DELETE FROM conversations WHERE user_id = ?').run(u);
  if (b.scope === 'notifications') db.prepare('DELETE FROM notifications WHERE user_id = ?').run(u);
  if (b.scope === 'all_content') {
    for (const t of ['events', 'tasks', 'projects', 'transactions', 'budgets', 'bills', 'savings_goals', 'reminders', 'notes', 'memories', 'conversations', 'notifications', 'email_drafts']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u);
    updateSettings(u, { demoMode: false });
  }
  audit(u, 'user', 'clear_data', null, null, b.scope);
  res.json({ ok: true });
});
