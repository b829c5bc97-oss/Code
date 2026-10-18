import { z } from 'zod';
import { db, id, nowIso, audit } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime, toUtcIso, parseInZone, recurrenceSchema } from '../services/time.js';
import * as events from '../services/events.js';
import * as tasks from '../services/tasks.js';
import * as projects from '../services/projects.js';
import * as finance from '../services/finance.js';
import * as reminders from '../services/reminders.js';
import * as notes from '../services/notes.js';
import * as planning from '../services/planning.js';
import * as email from '../integrations/email.js';
import { webSearch, searchStatus } from '../integrations/search.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateTime = z.string().min(10).describe('ISO 8601. Without an offset it is read in the user time zone.');

/**
 * Tool registry. Each tool declares:
 *  - domain: which permission setting governs it
 *  - access: read | write | delete  (delete always needs confirmation)
 *  - confirm: true to always require explicit user approval (bulk or high-impact changes)
 *  - schema: zod schema; arguments are validated on the server before anything runs
 *  - run(userId, args): executes against the user's own data only
 *  - describe(args): human-readable summary shown on confirmation cards
 */
const TOOLS = [];
const def = (t) => TOOLS.push(t);

// ---------- context & memory ----------
def({
  name: 'get_context', domain: 'none', access: 'read',
  description: 'Current date/time, time zone, working hours, focus periods, currency and the user\'s saved assistant memories. Call this when you need preferences beyond what is in the context block.',
  schema: z.object({}),
  run: (u) => {
    const s = getSettings(u);
    return {
      now: DateTime.now().setZone(s.timezone).toISO(), timezone: s.timezone, currency: s.currency, working_hours: s.workingHours,
      focus_periods: s.focusPeriods, daily_schedule: s.dailySchedule,
      memories: s.assistant.useMemory ? db.prepare('SELECT id, content FROM memories WHERE user_id = ? ORDER BY created_at').all(u) : 'memory disabled by user',
    };
  },
});
def({
  name: 'remember', domain: 'memory', access: 'write',
  description: 'Save a preference or routine the user explicitly asked you to remember (e.g. "I prefer meetings after 11am"). Only use when the user asks you to remember something. The user can view and delete memories in Settings.',
  schema: z.object({ content: z.string().trim().min(3).max(500) }),
  run: (u, a) => {
    if (!getSettings(u).assistant.useMemory) return { saved: false, reason: 'The user has turned assistant memory off in Settings.' };
    const mid = id();
    db.prepare('INSERT INTO memories (id, user_id, content, source, created_at) VALUES (?,?,?,?,?)').run(mid, u, a.content, 'assistant', nowIso());
    audit(u, 'assistant', 'create', 'memory', mid, a.content);
    return { saved: true, id: mid };
  },
  describe: (a) => `Remember: "${a.content}"`,
});

// ---------- calendar ----------
def({
  name: 'list_events', domain: 'calendar', access: 'read',
  description: 'List calendar events (recurring events expanded) overlapping a time range. Use for "what is next", agendas, availability questions.',
  schema: z.object({ from: dateTime, to: dateTime, query: z.string().max(100).optional(), kind: z.enum(events.EVENT_KINDS).optional() }),
  run: (u, a) => {
    const zone = getSettings(u).timezone;
    return { events: events.listOccurrences(u, toUtcIso(parseInZone(a.from, zone)), toUtcIso(parseInZone(a.to, zone)), a) };
  },
});
def({
  name: 'search_events', domain: 'calendar', access: 'read',
  description: 'Search events by text in title, description, location or participants (any date).',
  schema: z.object({ query: z.string().min(1).max(100) }),
  run: (u, a) => ({ events: events.searchEvents(u, a.query, 30) }),
});
def({
  name: 'check_conflicts', domain: 'calendar', access: 'read',
  description: 'Return events overlapping a proposed time window.',
  schema: z.object({ start: dateTime, end: dateTime }),
  run: (u, a) => {
    const zone = getSettings(u).timezone;
    return { conflicts: events.findConflicts(u, toUtcIso(parseInZone(a.start, zone)), toUtcIso(parseInZone(a.end, zone))) };
  },
});
def({
  name: 'find_free_slots', domain: 'calendar', access: 'read',
  description: 'Find open time slots of at least duration_minutes, respecting working hours (or waking hours), lunch and buffers.',
  schema: z.object({ from: dateTime, to: dateTime, duration_minutes: z.number().int().min(5).max(600).default(30), working_hours_only: z.boolean().default(true) }),
  run: (u, a) => {
    const zone = getSettings(u).timezone;
    return { slots: planning.freeSlots(u, toUtcIso(parseInZone(a.from, zone)), toUtcIso(parseInZone(a.to, zone)), { duration: a.duration_minutes, workingHoursOnly: a.working_hours_only }).slice(0, 30) };
  },
});
def({
  name: 'create_event', domain: 'calendar', access: 'write',
  description: 'Create a calendar event. Conflicts are checked first: if the slot is busy the event is NOT created and the conflicts are returned — tell the user and ask whether to book anyway (then call again with allow_conflict=true) or pick another time.',
  schema: events.eventInput.extend({ allow_conflict: z.boolean().optional().default(false) }),
  run: (u, a) => {
    const { allow_conflict, ...input } = a;
    const r = events.createEvent(u, input, { actor: 'assistant', allowConflict: allow_conflict });
    return r.created ? r : { created: false, conflicts: r.conflicts, message: 'Not created: the time overlaps existing events. Ask the user how to proceed.' };
  },
  describe: (a) => `Create event "${a.title}" at ${a.start}${a.allow_conflict ? ' (overlapping existing events)' : ''}`,
});
def({
  name: 'update_event', domain: 'calendar', access: 'write',
  description: 'Edit or reschedule an event. Changing start keeps the duration unless end/duration_minutes is given. Conflicts block the change unless allow_conflict=true.',
  schema: events.eventPatch.extend({ event_id: z.string(), allow_conflict: z.boolean().optional().default(false) }),
  run: (u, a) => {
    const { event_id, allow_conflict, ...patch } = a;
    const r = events.updateEvent(u, event_id, patch, { actor: 'assistant', allowConflict: allow_conflict });
    return r.updated ? r : { updated: false, conflicts: r.conflicts, message: 'Not changed: the new time overlaps existing events. Ask the user how to proceed.' };
  },
  describe: (a) => `Update event ${a.title ? `"${a.title}"` : a.event_id}${a.start ? ` → ${a.start}` : ''}`,
});
def({
  name: 'delete_event', domain: 'calendar', access: 'delete',
  description: 'Delete an event (or one occurrence of a recurring event via occurrence_start). Requires user confirmation.',
  schema: z.object({ event_id: z.string(), occurrence_start: z.string().optional() }),
  run: (u, a) => events.deleteEvent(u, a.event_id, { occurrenceStart: a.occurrence_start, actor: 'assistant' }),
  describe: (a, u) => `Delete event "${safeTitle(() => events.getEvent(u, a.event_id).title)}"${a.occurrence_start ? ' (this occurrence only)' : ''}`,
});

// ---------- tasks & projects ----------
def({
  name: 'list_tasks', domain: 'tasks', access: 'read',
  description: 'List tasks with filters. status "open" means not done. Dates are UTC ISO or local.',
  schema: z.object({
    status: z.enum(['open', ...tasks.STATUSES]).optional(), priority: z.enum(tasks.PRIORITIES).optional(), project_id: z.string().optional(),
    query: z.string().max(100).optional(), due_before: dateTime.optional(), due_after: dateTime.optional(), overdue: z.boolean().optional(),
    sort: z.enum(['due', 'priority', 'created', 'title']).optional(), limit: z.number().int().min(1).max(200).optional().default(50),
  }),
  run: (u, a) => {
    const zone = getSettings(u).timezone;
    const f = { ...a };
    if (a.due_before) f.due_before = toUtcIso(parseInZone(a.due_before, zone));
    if (a.due_after) f.due_after = toUtcIso(parseInZone(a.due_after, zone));
    return { tasks: tasks.listTasks(u, f) };
  },
});
def({
  name: 'create_task', domain: 'tasks', access: 'write',
  description: 'Create a task. due accepts YYYY-MM-DD (end of that day) or a date-time.',
  schema: tasks.taskInput,
  run: (u, a) => ({ task: tasks.createTask(u, a, { actor: 'assistant' }) }),
  describe: (a) => `Create task "${a.title}"${a.due ? ` due ${a.due}` : ''}`,
});
def({
  name: 'update_task', domain: 'tasks', access: 'write',
  description: 'Edit a task (title, status, priority, due, estimate, checklist, project...).',
  schema: tasks.taskPatch.extend({ task_id: z.string() }),
  run: (u, a) => {
    const { task_id, ...patch } = a;
    return { task: tasks.updateTask(u, task_id, patch, { actor: 'assistant' }) };
  },
  describe: (a, u) => `Update task "${safeTitle(() => tasks.getTaskRow(u, a.task_id).title)}"`,
});
def({
  name: 'complete_task', domain: 'tasks', access: 'write',
  description: 'Mark a task done. Recurring tasks automatically get their next instance.',
  schema: z.object({ task_id: z.string() }),
  run: (u, a) => ({ task: tasks.updateTask(u, a.task_id, { status: 'done' }, { actor: 'assistant' }) }),
  describe: (a, u) => `Complete task "${safeTitle(() => tasks.getTaskRow(u, a.task_id).title)}"`,
});
def({
  name: 'delete_task', domain: 'tasks', access: 'delete',
  description: 'Permanently delete a task (prefer update_task archived=true). Requires user confirmation.',
  schema: z.object({ task_id: z.string() }),
  run: (u, a) => tasks.deleteTask(u, a.task_id, { actor: 'assistant' }),
  describe: (a, u) => `Delete task "${safeTitle(() => tasks.getTaskRow(u, a.task_id).title)}"`,
});
def({
  name: 'prioritize_tasks', domain: 'tasks', access: 'read',
  description: 'Group open tasks into an urgent/important matrix with scores (do_now, schedule, delegate_or_batch, drop_or_later).',
  schema: z.object({}),
  run: (u) => tasks.prioritize(u),
});
def({
  name: 'workload_summary', domain: 'tasks', access: 'read',
  description: 'Counts of open, overdue, due today/this week tasks, recent completions and estimated open minutes.',
  schema: z.object({}),
  run: (u) => tasks.workloadSummary(u),
});
def({
  name: 'plan_day', domain: 'calendar', access: 'read',
  description: 'Build a PROPOSED schedule for a date: fits open priority tasks into free time around events, preferring focus periods. Nothing is saved. Present it, then use apply_schedule if the user wants it.',
  schema: z.object({ date, task_ids: z.array(z.string()).max(40).optional() }),
  run: (u, a) => planning.planDay(u, a.date, { taskIds: a.task_ids }),
});
def({
  name: 'reschedule_unfinished', domain: 'calendar', access: 'read',
  description: 'PROPOSE moving unfinished tasks from one day (including overdue ones) into free slots on another day. Nothing is saved; follow with apply_schedule.',
  schema: z.object({ from_date: date, to_date: date }),
  run: (u, a) => planning.rescheduleUnfinished(u, a.from_date, a.to_date),
});
def({
  name: 'apply_schedule', domain: 'calendar', access: 'write', confirm: true,
  description: 'Save time blocks for tasks as calendar events (from plan_day / reschedule_unfinished). Always requires user approval; conflicts are re-checked at save time.',
  schema: planning.applyPlanInput,
  run: (u, a) => planning.applyPlan(u, a, { actor: 'assistant' }),
  describe: (a) => `Add ${a.blocks.length} time block${a.blocks.length > 1 ? 's' : ''} to your calendar${a.set_due_date ? ` and move due dates to ${a.set_due_date}` : ''}`,
  preview: (a, u) => ({ blocks: a.blocks.map((b) => ({ ...b, title: b.title || safeTitle(() => tasks.getTaskRow(u, b.task_id).title) })) }),
});
def({
  name: 'list_projects', domain: 'tasks', access: 'read',
  description: 'List projects with progress and milestones.',
  schema: z.object({ status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).optional() }),
  run: (u, a) => ({ projects: projects.listProjects(u, a) }),
});
def({
  name: 'get_project', domain: 'tasks', access: 'read',
  description: 'Project details including all its tasks.',
  schema: z.object({ project_id: z.string() }),
  run: (u, a) => projects.projectDetail(u, a.project_id),
});
def({
  name: 'create_project_plan', domain: 'tasks', access: 'write', confirm: true,
  description: 'Save a complete project plan (project + milestones + tasks with due dates and dependencies). Use after breaking a goal into stages. Always shown to the user for approval before saving.',
  schema: projects.projectPlanInput,
  run: (u, a) => projects.createProjectFromPlan(u, a, { actor: 'assistant' }),
  describe: (a) => `Create project "${a.project.name}" with ${a.milestones.length} milestones and ${a.milestones.reduce((n, m) => n + m.tasks.length, 0)} tasks`,
  preview: (a) => a,
});

// ---------- finance ----------
def({
  name: 'finance_summary', domain: 'finance', access: 'read',
  description: 'Income, expenses, net, spending by category, daily totals and top merchants for an inclusive date range — from recorded transactions only. Amounts are in minor units (paise for INR).',
  schema: z.object({ from: date, to: date }),
  run: (u, a) => finance.summary(u, a.from, a.to),
});
def({
  name: 'compare_spending', domain: 'finance', access: 'read',
  description: 'Compare two periods (A vs B) by total and by category. Minor units.',
  schema: z.object({ a_from: date, a_to: date, b_from: date, b_to: date }),
  run: (u, a) => finance.comparePeriods(u, { from: a.a_from, to: a.a_to }, { from: a.b_from, to: a.b_to }),
});
def({
  name: 'budget_status', domain: 'finance', access: 'read',
  description: 'Budget vs actual per category for a month (YYYY-MM, default current). projected_minor is a forecast and must be described as such.',
  schema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
  run: (u, a) => ({ budgets: finance.budgetStatus(u, a.month) }),
});
def({
  name: 'list_transactions', domain: 'finance', access: 'read',
  description: 'Search recorded transactions.',
  schema: z.object({ from: date.optional(), to: date.optional(), type: z.enum(['expense', 'income']).optional(), category: z.string().optional(), query: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).default(50) }),
  run: (u, a) => ({ transactions: finance.listTransactions(u, a) }),
});
def({
  name: 'list_categories', domain: 'finance', access: 'read',
  description: 'Finance categories available to the user.',
  schema: z.object({}),
  run: (u) => ({ categories: finance.listCategories(u) }),
});
def({
  name: 'add_transaction', domain: 'finance', access: 'write',
  description: 'Record an income or expense the user tells you about. Never invent transactions. Category must be an existing category name or id.',
  schema: finance.transactionInput,
  run: (u, a) => ({ transaction: finance.createTransaction(u, a, { actor: 'assistant' }) }),
  describe: (a) => `Record ${a.type} of ${a.amount}${a.currency ? ' ' + a.currency : ''} on ${a.date}${a.description ? ` (${a.description})` : ''}`,
});
def({
  name: 'list_bills', domain: 'finance', access: 'read',
  description: 'Bills and subscriptions with due dates and payment status.',
  schema: z.object({ status: z.enum(['unpaid', 'paid']).optional(), kind: z.enum(['bill', 'subscription']).optional() }),
  run: (u, a) => ({ bills: finance.listBills(u, a), recurring_estimate: finance.recurringEstimate(u) }),
});
def({
  name: 'upcoming_bills', domain: 'finance', access: 'read',
  description: 'Unpaid bills due within N days (including overdue).',
  schema: z.object({ days: z.number().int().min(1).max(90).default(14) }),
  run: (u, a) => ({ bills: finance.upcomingBills(u, a.days) }),
});
def({
  name: 'create_bill', domain: 'finance', access: 'write',
  description: 'Track a recurring bill or subscription with its due date. (JARVIS never pays bills.)',
  schema: finance.billInput,
  run: (u, a) => ({ bill: finance.createBill(u, a, { actor: 'assistant' }) }),
  describe: (a) => `Track ${a.kind || 'bill'} "${a.name}" (${a.amount}) due ${a.due_date}`,
});
def({
  name: 'mark_bill_paid', domain: 'finance', access: 'write',
  description: 'Record that the USER has paid a bill (does not make a payment). Optionally logs the expense and moves a recurring bill to its next due date.',
  schema: z.object({ bill_id: z.string(), paid_on: date.optional(), record_transaction: z.boolean().default(true) }),
  run: (u, a) => finance.markBillPaid(u, a.bill_id, { ...a, actor: 'assistant' }),
  describe: (a, u) => `Mark "${safeTitle(() => finance.getBill(u, a.bill_id).name)}" as paid`,
});

// ---------- reminders ----------
def({
  name: 'create_reminder', domain: 'reminders', access: 'write',
  description: 'Create a reminder delivered as an in-app notification by the server scheduler at remind_at. For "before the due date" reminders, pick a sensible time before it and say which.',
  schema: reminders.reminderInput,
  run: (u, a) => ({ reminder: reminders.createReminder(u, a, { actor: 'assistant' }) }),
  describe: (a) => `Remind "${a.title}" at ${a.remind_at}`,
});
def({
  name: 'list_reminders', domain: 'reminders', access: 'read',
  description: 'List reminders. status "active" = pending or fired.',
  schema: z.object({ status: z.enum(['active', 'pending', 'fired', 'done', 'dismissed']).optional() }),
  run: (u, a) => ({ reminders: reminders.listReminders(u, a) }),
});
def({
  name: 'update_reminder', domain: 'reminders', access: 'write',
  description: 'Change a reminder (time, title, mark done).',
  schema: reminders.reminderInput.partial().extend({ reminder_id: z.string(), status: z.enum(['pending', 'done', 'dismissed']).optional() }),
  run: (u, a) => {
    const { reminder_id, ...patch } = a;
    return { reminder: reminders.updateReminder(u, reminder_id, patch, { actor: 'assistant' }) };
  },
  describe: (a) => `Update reminder ${a.title ? `"${a.title}"` : ''}`,
});
def({
  name: 'delete_reminder', domain: 'reminders', access: 'delete',
  description: 'Delete a reminder. Requires confirmation.',
  schema: z.object({ reminder_id: z.string() }),
  run: (u, a) => reminders.deleteReminder(u, a.reminder_id, { actor: 'assistant' }),
  describe: (a, u) => `Delete reminder "${safeTitle(() => reminders.getReminder(u, a.reminder_id).title)}"`,
});

// ---------- briefings ----------
def({
  name: 'get_briefing', domain: 'none', access: 'read',
  description: 'Daily briefing data for a date: events, due & overdue tasks, top priorities, reminders, upcoming bills, budgets at risk, free time, conflicts, competing deadlines, rule-based suggestions.',
  schema: z.object({ date: date.optional() }),
  run: (u, a) => planning.briefing(u, a.date),
});
def({
  name: 'get_shutdown_summary', domain: 'none', access: 'read',
  description: 'End-of-day summary: completed today, unfinished, plus a proposed plan for tomorrow (not saved).',
  schema: z.object({ date: date.optional() }),
  run: (u, a) => planning.shutdown(u, a.date),
});
def({
  name: 'meeting_prep', domain: 'calendar', access: 'read',
  description: 'Meetings on a date (default tomorrow) with related notes and open tasks found in the user\'s data.',
  schema: z.object({ date: date.optional() }),
  run: (u, a) => planning.meetingPrep(u, a.date),
});

// ---------- notes ----------
def({
  name: 'search_notes', domain: 'notes', access: 'read',
  description: 'Search the user\'s saved notes (title, content, tags). Returns excerpts.',
  schema: z.object({ query: z.string().max(200).optional(), category: z.string().optional(), tag: z.string().optional() }),
  run: (u, a) => ({ notes: notes.listNotes(u, a).slice(0, 25) }),
});
def({
  name: 'get_note', domain: 'notes', access: 'read',
  description: 'Full content of one note.',
  schema: z.object({ note_id: z.string() }),
  run: (u, a) => notes.getNote(u, a.note_id),
});
def({
  name: 'create_note', domain: 'notes', access: 'write',
  description: 'Save a note (meeting summary, idea, reference).',
  schema: notes.noteInput,
  run: (u, a) => ({ note: notes.createNote(u, a, { actor: 'assistant' }) }),
  describe: (a) => `Save note "${a.title}"`,
});
def({
  name: 'update_note', domain: 'notes', access: 'write',
  description: 'Edit a note or append text to it.',
  schema: notes.noteInput.partial().extend({ note_id: z.string(), append: z.string().max(50000).optional() }),
  run: (u, a) => {
    const { note_id, ...patch } = a;
    return { note: notes.updateNote(u, note_id, patch, { actor: 'assistant' }) };
  },
  describe: (a, u) => `Update note "${safeTitle(() => notes.getNote(u, a.note_id).title)}"`,
});

// ---------- email (only when an integration is connected) ----------
def({
  name: 'list_emails', domain: 'email', access: 'read',
  description: 'List recent messages from the user\'s connected mailbox (Gmail or Outlook). Returns sender, subject, date, snippet, unread flag. Fails if no mailbox is connected.',
  schema: z.object({ unread_only: z.boolean().default(true), query: z.string().max(200).optional(), max: z.number().int().min(1).max(25).default(10) }),
  run: async (u, a) => email.listMessages(u, a),
});
def({
  name: 'get_email_thread', domain: 'email', access: 'read',
  description: 'Full text of an email thread from the connected mailbox, for summarising or extracting action items.',
  schema: z.object({ thread_id: z.string() }),
  run: async (u, a) => email.getThread(u, a.thread_id),
});
def({
  name: 'draft_email', domain: 'email', access: 'write',
  description: 'Prepare an email draft for the user to review. This NEVER sends. The user reviews recipient and text and sends it themselves from the Email screen.',
  schema: z.object({ to: z.string().email().max(300), subject: z.string().max(300), body: z.string().max(20000), thread_id: z.string().optional() }),
  run: async (u, a) => email.saveDraft(u, a),
  describe: (a) => `Draft email to ${a.to}: "${a.subject}"`,
});

// ---------- web search ----------
def({
  name: 'web_search', domain: 'none', access: 'read',
  description: 'Search the public web through the configured search provider. Results are EXTERNAL information — cite the source URLs and keep them separate from the user\'s own data.',
  schema: z.object({ query: z.string().min(2).max(300), max_results: z.number().int().min(1).max(10).default(5) }),
  available: () => searchStatus().configured,
  run: async (_u, a) => webSearch(a.query, a.max_results),
});

function safeTitle(fn) {
  try {
    return fn();
  } catch {
    return '(not found)';
  }
}

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export function availableTools() {
  return TOOLS.filter((t) => !t.available || t.available());
}

/** JSON schemas for the model, derived from the same zod schemas used for validation. */
export function toolSpecs() {
  return availableTools().map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' });
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

/** Decide whether a tool may run now, needs approval, or is denied by the user's permissions. */
export function permissionFor(userId, tool) {
  const s = getSettings(userId);
  if (tool.access === 'read') {
    return 'allow';
  }
  if (tool.domain === 'memory') return s.assistant.useMemory ? 'allow' : 'deny';
  const level = s.assistant.permissions[tool.domain] ?? 'confirm';
  if (level === 'read') return 'deny';
  if (tool.domain === 'email') return 'allow'; // drafting only; sending is a separate user action
  if (tool.access === 'delete' || tool.confirm || level === 'confirm' || s.assistant.confirmAllChanges) return 'confirm';
  return 'allow';
}

export class ToolInputError extends Error {}

export function validateArgs(tool, args) {
  const r = tool.schema.safeParse(args ?? {});
  if (!r.success) throw new ToolInputError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * Execute one tool call on behalf of the assistant: validate → permission → run or queue for approval.
 * Returns { status, result | pending | error } and never throws.
 */
export async function executeToolCall(userId, conversationId, name, rawArgs) {
  const tool = toolMap.get(name);
  if (!tool || (tool.available && !tool.available())) return { status: 'error', error: `Unknown or unavailable tool: ${name}` };
  let args;
  try {
    args = validateArgs(tool, rawArgs);
  } catch (e) {
    return { status: 'error', error: `Invalid arguments — ${e.message}` };
  }
  const perm = permissionFor(userId, tool);
  if (perm === 'deny') {
    return { status: 'denied', error: `The user's settings do not allow the assistant to change ${tool.domain} data. Tell the user they can change this in Settings → Assistant permissions.` };
  }
  if (perm === 'confirm') {
    const summary = tool.describe ? tool.describe(args, userId) : `${name}`;
    const pid = id();
    db.prepare('INSERT INTO pending_actions (id, user_id, conversation_id, tool, args, summary, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(pid, userId, conversationId, name, JSON.stringify(args), summary, nowIso());
    return { status: 'pending', pending: { id: pid, tool: name, summary, preview: tool.preview ? tool.preview(args, userId) : null } };
  }
  try {
    const result = await tool.run(userId, args);
    if (result && (result.created === false || result.updated === false) && result.conflicts) {
      return { status: 'conflict', result, summary: `Not saved — overlaps ${result.conflicts.map((c) => `"${c.title}"`).join(', ')}` };
    }
    return { status: 'ok', result, summary: tool.access === 'read' ? null : tool.describe?.(args, userId) };
  } catch (e) {
    return { status: 'error', error: e.status && e.status < 500 ? e.message : `Tool failed: ${e.message}` };
  }
}

/** Run a queued action after the user approved it. Arguments are re-validated and ownership re-checked inside services. */
export async function runConfirmedAction(userId, actionId, decision) {
  const row = db.prepare('SELECT * FROM pending_actions WHERE id = ? AND user_id = ?').get(actionId, userId);
  if (!row) return { status: 'error', error: 'Action not found.' };
  if (row.status !== 'pending') return { status: 'error', error: `This action was already ${row.status}.` };
  if (Date.now() - Date.parse(row.created_at) > 24 * 3600e3) {
    db.prepare("UPDATE pending_actions SET status = 'expired', resolved_at = ? WHERE id = ?").run(nowIso(), actionId);
    return { status: 'error', error: 'This approval request expired. Ask again.' };
  }
  if (decision === 'reject') {
    db.prepare("UPDATE pending_actions SET status = 'rejected', resolved_at = ? WHERE id = ?").run(nowIso(), actionId);
    return { status: 'rejected', action: row };
  }
  const tool = toolMap.get(row.tool);
  // Permissions may have changed since the request was queued.
  if (!tool || permissionFor(userId, tool) === 'deny') {
    db.prepare("UPDATE pending_actions SET status = 'rejected', resolved_at = ? WHERE id = ?").run(nowIso(), actionId);
    return { status: 'error', error: 'This action is no longer permitted by your settings.' };
  }
  try {
    const args = validateArgs(tool, JSON.parse(row.args));
    const result = await tool.run(userId, args);
    db.prepare("UPDATE pending_actions SET status = 'confirmed', result = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), actionId);
    return { status: 'ok', result, action: row };
  } catch (e) {
    db.prepare("UPDATE pending_actions SET status = 'failed', result = ?, resolved_at = ? WHERE id = ?").run(JSON.stringify({ error: e.message }), nowIso(), actionId);
    return { status: 'error', error: e.message, action: row };
  }
}

export { recurrenceSchema };
