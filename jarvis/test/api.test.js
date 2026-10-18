import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { startServer, client } from './helpers.js';

let srv;
let alice;
let bob;
const zone = 'Asia/Kolkata';
// A Wednesday two weeks out, so working-hours logic is deterministic.
const day = DateTime.now().setZone(zone).plus({ weeks: 2 }).set({ weekday: 3 }).toISODate();

before(async () => {
  srv = await startServer();
  alice = client(srv.base);
  bob = client(srv.base);
  await alice.signup('alice@example.com');
  await bob.signup('bob@example.com');
});
after(() => srv.close());

test('auth: rejects unauthenticated access, bad passwords and duplicate signups', async () => {
  const anon = client(srv.base);
  assert.equal((await anon.get('/tasks')).status, 401);
  assert.equal((await anon.post('/auth/login', { email: 'alice@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await anon.post('/auth/signup', { email: 'alice@example.com', password: 'a-long-password-1', name: 'x' })).status, 409);
  assert.equal((await anon.post('/auth/signup', { email: 'c@example.com', password: 'short', name: 'x' })).status, 400);
  const ok = await anon.post('/auth/login', { email: 'ALICE@example.com', password: 'a-long-password-1' });
  assert.equal(ok.status, 200);
});

test('csrf: mutations without the custom header or from another origin are refused', async () => {
  assert.equal((await alice.post('/tasks', { title: 'x' }, { csrf: false })).status, 403);
  assert.equal((await alice.post('/tasks', { title: 'x' }, { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('isolation: one user cannot read or modify another user\'s records', async () => {
  const t = (await alice.post('/tasks', { title: 'Alice secret' })).data;
  const e = (await alice.post('/events', { title: 'Alice meeting', start: `${day}T08:00`, duration_minutes: 30 })).data.event;
  const n = (await alice.post('/notes', { title: 'Alice note' })).data;
  assert.equal((await bob.get(`/tasks/${t.id}`)).status, 404);
  assert.equal((await bob.patch(`/tasks/${t.id}`, { title: 'pwned' })).status, 404);
  assert.equal((await bob.del(`/events/${e.id}`)).status, 404);
  assert.equal((await bob.get(`/notes/${n.id}`)).status, 404);
  assert.ok(!(await bob.get('/tasks')).data.some((x) => x.id === t.id));
  // Bob can't attach Alice's task to his own event either.
  assert.equal((await bob.post('/events', { title: 'x', start: `${day}T20:00`, task_id: t.id })).status, 404);
});

test('calendar: conflicts are detected and only booked with explicit consent', async () => {
  const a = await alice.post('/events', { title: 'Design review', start: `${day}T15:00`, duration_minutes: 60 });
  assert.equal(a.status, 201);
  assert.equal(a.data.event.start, DateTime.fromISO(`${day}T15:00`, { zone }).toUTC().toISO({ suppressMilliseconds: true }));
  const clash = await alice.post('/events', { title: 'Overlap', start: `${day}T15:30`, duration_minutes: 60 });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.conflicts[0].title, 'Design review');
  const forced = await alice.post('/events', { title: 'Overlap', start: `${day}T15:30`, duration_minutes: 60, allow_conflict: true });
  assert.equal(forced.status, 201);
  const touching = await alice.post('/events', { title: 'Back to back', start: `${day}T16:30`, duration_minutes: 30 });
  assert.equal(touching.status, 201, 'adjacent events do not conflict');
});

test('calendar: weekly recurrence expands in local time and supports deleting one occurrence', async () => {
  const start = DateTime.fromISO(day, { zone }).set({ weekday: 1 }).toISODate();
  const r = await alice.post('/events', { title: 'Standup', start: `${start}T09:30`, duration_minutes: 15, recurrence: { freq: 'weekly', byDay: [1, 3, 5] }, allow_conflict: true });
  assert.equal(r.status, 201);
  const from = `${start}T00:00`;
  const to = DateTime.fromISO(start).plus({ days: 14 }).toISODate() + 'T00:00';
  let occ = (await alice.get(`/events?from=${from}&to=${to}&q=Standup`)).data;
  assert.equal(occ.length, 6);
  assert.ok(occ.every((o) => DateTime.fromISO(o.start).setZone(zone).toFormat('HH:mm') === '09:30'));
  await alice.del(`/events/${r.data.event.id}?occurrence=${encodeURIComponent(occ[1].start)}`);
  occ = (await alice.get(`/events?from=${from}&to=${to}&q=Standup`)).data;
  assert.equal(occ.length, 5);
});

test('scheduling: free slots respect working hours, lunch and existing events', async () => {
  const slots = (await alice.post('/calendar/free-slots', { from: `${day}T00:00`, to: `${day}T23:59`, duration: 30 })).data;
  const local = slots.map((s) => [DateTime.fromISO(s.start).setZone(zone).toFormat('HH:mm'), DateTime.fromISO(s.end).setZone(zone).toFormat('HH:mm')]);
  assert.ok(local.every(([s, e]) => s >= '09:00' && e <= '18:00'), JSON.stringify(local));
  assert.ok(!local.some(([s, e]) => s < '14:00' && e > '13:00'), 'lunch is kept free');
  assert.ok(!local.some(([s, e]) => s < '17:10' && e > '14:50'), 'busy afternoon (plus buffer) is excluded');
});

test('planning: plan_day proposes blocks without saving; applying re-checks conflicts', async () => {
  const t = (await alice.post('/tasks', { title: 'Write report', due: day, priority: 'high', estimate_minutes: 90 })).data;
  const plan = (await alice.get(`/plan/day?date=${day}`)).data;
  assert.equal(plan.saved, false);
  const block = plan.blocks.find((b) => b.task_id === t.id);
  assert.ok(block, 'high-priority task due that day is planned');
  const before = (await alice.get(`/events?from=${day}T00:00&to=${day}T23:59`)).data.length;
  assert.equal((await alice.get(`/events?from=${day}T00:00&to=${day}T23:59`)).data.length, before, 'proposal did not create events');
  const applied = (await alice.post('/plan/apply', { blocks: [block] })).data;
  assert.equal(applied.created.length, 1);
  const again = (await alice.post('/plan/apply', { blocks: [block] })).data;
  assert.equal(again.created.length, 0, 'second apply is blocked by the first block');
  assert.equal(again.skipped.length, 1);
});

test('tasks: dependency cycles are rejected and recurring tasks spawn the next instance', async () => {
  const a = (await alice.post('/tasks', { title: 'A' })).data;
  const b = (await alice.post('/tasks', { title: 'B', depends_on: [a.id] })).data;
  assert.equal((await alice.patch(`/tasks/${a.id}`, { depends_on: [b.id] })).status, 400);
  const r = (await alice.post('/tasks', { title: 'Water plants', due: day, recurrence: { freq: 'weekly' } })).data;
  const done = (await alice.patch(`/tasks/${r.id}`, { status: 'done' })).data;
  assert.ok(done.next_recurrence);
  const next = (await alice.get(`/tasks/${done.next_recurrence}`)).data;
  assert.equal(DateTime.fromISO(next.due).setZone(zone).toISODate(), DateTime.fromISO(day).plus({ weeks: 1 }).toISODate());
});

test('finance: totals, categories, budgets and comparisons come from recorded data only', async () => {
  const m = DateTime.now().setZone(zone).minus({ months: 3 }).toFormat('yyyy-MM');
  const prev = DateTime.fromISO(`${m}-01`).minus({ months: 1 }).toFormat('yyyy-MM');
  await alice.post('/finance/transactions', { type: 'income', amount: 50000, category: 'Salary', date: `${m}-01` });
  await alice.post('/finance/transactions', { type: 'expense', amount: 249.5, category: 'Food & Dining', date: `${m}-03` });
  await alice.post('/finance/transactions', { type: 'expense', amount: 1000.25, category: 'Food & Dining', date: `${m}-10` });
  await alice.post('/finance/transactions', { type: 'expense', amount: 300, category: 'Transport', date: `${m}-11` });
  await alice.post('/finance/transactions', { type: 'expense', amount: 800, category: 'Food & Dining', date: `${prev}-11` });
  const s = (await alice.get(`/finance/summary?month=${m}`)).data.summary;
  assert.equal(s.expense_minor, 154975);
  assert.equal(s.income_minor, 5000000);
  assert.equal(s.net_minor, 5000000 - 154975);
  assert.equal(s.by_category[0].name, 'Food & Dining');
  assert.equal(s.by_category[0].total, 124975);
  const cmp = (await alice.get(`/finance/compare?a_from=${m}-01&a_to=${m}-31&b_from=${prev}-01&b_to=${prev}-28`)).data;
  assert.equal(cmp.period_b.expense_minor, 80000);
  const bud = (await alice.put('/finance/budgets', { category: 'Food & Dining', amount: 1000 })).data;
  assert.equal(bud.budget_minor, 100000);
  const status = (await alice.get(`/finance/budgets?month=${m}`)).data.find((x) => x.category === 'Food & Dining');
  assert.equal(status.spent_minor, 124975);
  assert.equal(status.status, 'exceeded');
  assert.equal((await bob.get(`/finance/summary?month=${m}`)).data.summary.expense_minor, 0, 'bob sees none of it');
});

test('finance: CSV import validates rows and detects duplicates', async () => {
  const csv = 'Date,Narration,Withdrawal Amt.,Deposit Amt.\n05/01/2026,Coffee,120.00,\n05/01/2026,Coffee,120.00,\n06/01/2026,"Refund, partial",,50\nnot-a-date,Bad,10,\n';
  const p = (await alice.post('/finance/import/preview', csv, { headers: { 'content-type': 'text/csv' } })).data;
  assert.equal(p.summary.total, 4);
  assert.equal(p.summary.invalid, 1);
  assert.equal(p.rows[1].duplicate, 'repeated in this file');
  assert.equal(p.rows[2].type, 'income');
  const rows = p.rows.filter((r) => r.include);
  const c = (await alice.post('/finance/import/commit', { rows })).data;
  assert.equal(c.imported, 2);
  const again = (await alice.post('/finance/import/preview', csv, { headers: { 'content-type': 'text/csv' } })).data;
  assert.equal(again.rows[0].duplicate, 'already recorded');
  const exp = await alice.get('/finance/export.csv');
  assert.match(exp.data, /Coffee/);
});

test('bills: marking paid records the expense and rolls the due date; JARVIS never pays', async () => {
  const b = (await alice.post('/finance/bills', { name: 'Electricity', amount: 1900, due_date: '2027-01-10', recurrence: 'monthly', category: 'Utilities' })).data;
  const r = (await alice.post(`/finance/bills/${b.id}/paid`, { paid_on: '2027-01-08' })).data;
  assert.equal(r.bill.due_date, '2027-02-10');
  assert.equal(r.transaction.amount_minor, 190000);
  assert.equal(r.transaction.source, 'bill');
});

test('assistant (demo, no AI key): clearly labelled and uses the same validated tools', async () => {
  const st = (await alice.get('/assistant/status')).data;
  assert.equal(st.configured, false);
  const r = (await alice.post('/assistant/chat', { message: 'Create a task to renew passport by Friday' })).data;
  assert.match(r.message.content, /Demo assistant/);
  assert.equal(r.message.actions[0].status, 'ok');
  assert.ok((await alice.get('/tasks?q=passport')).data.length === 1);
});

test('permissions: read-only and confirm modes are enforced on the server', async () => {
  await alice.patch('/settings', { assistant: { permissions: { tasks: 'read' } } });
  let r = (await alice.post('/assistant/chat', { message: 'Create a task to buy milk tomorrow' })).data;
  assert.equal(r.message.actions[0].status, 'denied');
  assert.equal((await alice.get('/tasks?q=milk')).data.length, 0);
  await alice.patch('/settings', { assistant: { permissions: { tasks: 'confirm' } } });
  r = (await alice.post('/assistant/chat', { message: 'Create a task to buy milk tomorrow' })).data;
  assert.equal(r.message.pending.length, 1);
  assert.equal((await alice.get('/tasks?q=milk')).data.length, 0, 'nothing saved before approval');
  assert.equal((await bob.post(`/assistant/actions/${r.message.pending[0].id}`, { decision: 'confirm' })).status, 400, 'another user cannot approve it');
  const ok = (await alice.post(`/assistant/actions/${r.message.pending[0].id}`, { decision: 'confirm' })).data;
  assert.equal(ok.status, 'ok');
  assert.equal((await alice.get('/tasks?q=milk')).data.length, 1);
  assert.equal((await alice.post(`/assistant/actions/${r.message.pending[0].id}`, { decision: 'confirm' })).status, 400, 'cannot be replayed');
  await alice.patch('/settings', { assistant: { permissions: { tasks: 'write' } } });
});

test('scheduler: due reminders become notifications exactly once, recurring ones roll forward', async () => {
  const { runOnce } = await import('../server/scheduler.js');
  const soon = DateTime.utc().plus({ minutes: 1 });
  const r1 = (await alice.post('/reminders', { title: 'Pay rent', remind_at: soon.toISO() })).data;
  const r2 = (await alice.post('/reminders', { title: 'Call mom', remind_at: soon.toISO(), recurrence: { freq: 'daily' } })).data;
  runOnce(DateTime.utc().plus({ minutes: 2 }));
  runOnce(DateTime.utc().plus({ minutes: 2 }));
  const n = (await alice.get('/notifications')).data.notifications.filter((x) => x.kind === 'reminder');
  assert.equal(n.filter((x) => x.title === 'Pay rent').length, 1);
  assert.equal((await alice.get('/reminders')).data.find((x) => x.id === r1.id).status, 'fired');
  const rec = (await alice.get('/reminders')).data.find((x) => x.id === r2.id);
  assert.equal(rec.status, 'pending');
  assert.ok(rec.remind_at > soon.toISO(), 'recurring reminder moved to the next day');
  assert.equal((await bob.get('/notifications')).data.notifications.length, 0);
});

test('email: no mailbox means no inbox, and sending requires matching confirmation', async () => {
  assert.equal((await alice.get('/integrations/email/messages')).status, 400);
  const d = (await alice.post('/integrations/email/drafts', { to: 'x@example.com', subject: 'Hi', body: 'Hello' })).data;
  assert.equal(d.sent, false);
  assert.equal((await alice.post(`/integrations/email/drafts/${d.draft_id}/send`, { confirm_to: 'y@example.com', confirm_subject: 'Hi' })).status, 400);
});

test('data: export contains only the user\'s own data; account deletion removes everything', async () => {
  const exp = (await bob.get('/export')).data;
  assert.equal(exp.user.email, 'bob@example.com');
  assert.ok(exp.tasks.every((t) => t.user_id === exp.user.id));
  assert.equal((await bob.post('/account/delete', { confirm: 'nope' })).status, 400);
  assert.equal((await bob.post('/account/delete', { confirm: 'DELETE' })).status, 200);
  assert.equal((await bob.get('/tasks')).status, 401);
});
