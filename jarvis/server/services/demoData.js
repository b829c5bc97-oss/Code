import { db, tx, audit } from '../db.js';
import { getSettings, updateSettings } from '../settings.js';
import { DateTime } from './time.js';
import { createEvent } from './events.js';
import { createTask } from './tasks.js';
import { createProject, addMilestone } from './projects.js';
import { createTransaction, setBudget, createBill, createGoal } from './finance.js';
import { createReminder } from './reminders.js';
import { createNote } from './notes.js';

const DEMO_TABLES = ['events', 'tasks', 'projects', 'transactions', 'bills', 'savings_goals', 'reminders', 'notes', 'budgets'];

/** Sample data, clearly flagged is_demo = 1 and shown with a "Demo" badge. Removable in one click. */
export function loadDemoData(userId) {
  const zone = getSettings(userId).timezone;
  const now = DateTime.now().setZone(zone);
  const d = (days, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return now.startOf('day').plus({ days }).set({ hour: h, minute: m }).toISO({ includeOffset: false });
  };
  const date = (days) => now.startOf('day').plus({ days }).toISODate();
  const opts = { isDemo: true, actor: 'system' };
  tx(() => {
    clearDemoData(userId);
    createEvent(userId, { title: 'Team stand-up', start: d(0 - ((now.weekday + 6) % 7), '09:30'), duration_minutes: 15, kind: 'meeting', recurrence: { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }, location: 'Google Meet' }, opts);
    createEvent(userId, { title: 'Design review with Priya', start: d(0, '15:00'), duration_minutes: 60, participants: ['priya@example.com'], description: 'Review the new onboarding flow. Bring metrics from last sprint.' }, opts);
    createEvent(userId, { title: 'Deep work: quarterly report', start: d(1, '10:00'), duration_minutes: 120, kind: 'focus' }, opts);
    createEvent(userId, { title: 'Client call — Acme Corp', start: d(1, '16:00'), duration_minutes: 45, participants: ['rahul@acme.example'], description: 'Agenda: scope for phase 2, timelines, invoice status.' }, opts);
    createEvent(userId, { title: 'Gym', start: d(2, '07:00'), duration_minutes: 60, kind: 'personal', recurrence: { freq: 'weekly', interval: 1, byDay: [1, 3, 5] } }, opts);
    createEvent(userId, { title: 'Dinner with Aditi', start: d(3, '20:00'), duration_minutes: 90, kind: 'personal', location: 'Indigo Deli' }, opts);

    const p = createProject(userId, { name: 'Portfolio website relaunch', description: 'Redesign and relaunch the personal portfolio site.', deadline: date(14), start_date: date(-3), color: '#8b5cf6' }, opts);
    const m1 = addMilestone(userId, p.id, { title: 'Design', due_date: date(4) });
    const m2 = addMilestone(userId, p.id, { title: 'Build & launch', due_date: date(14) });
    const t1 = createTask(userId, { title: 'Collect inspiration and write content outline', project_id: p.id, milestone_id: m1, due: date(-1), estimate_minutes: 60, status: 'done' }, opts);
    const t2 = createTask(userId, { title: 'Wireframe home and project pages', project_id: p.id, milestone_id: m1, due: date(2), estimate_minutes: 120, priority: 'high', depends_on: [t1.id] }, opts);
    createTask(userId, { title: 'Build responsive layout', project_id: p.id, milestone_id: m2, due: date(9), estimate_minutes: 240, depends_on: [t2.id] }, opts);
    createTask(userId, { title: 'Set up hosting and domain', project_id: p.id, milestone_id: m2, due: date(12), estimate_minutes: 45, priority: 'low' }, opts);

    createTask(userId, { title: 'Finish quarterly report draft', due: date(0), priority: 'urgent', important: true, estimate_minutes: 90, category: 'Work', checklist: [{ text: 'Revenue section' }, { text: 'Charts' }, { text: 'Executive summary' }] }, opts);
    createTask(userId, { title: 'Reply to Acme about phase 2 scope', due: date(0), priority: 'high', estimate_minutes: 20, category: 'Work' }, opts);
    createTask(userId, { title: 'Book dentist appointment', due: date(-2), priority: 'medium', estimate_minutes: 10, category: 'Personal' }, opts);
    createTask(userId, { title: 'Study: chapter 5 of statistics course', due: date(3), priority: 'medium', estimate_minutes: 90, category: 'Study' }, opts);
    createTask(userId, { title: 'Water the plants', due: date(1), priority: 'low', estimate_minutes: 10, category: 'Home', recurrence: { freq: 'weekly', interval: 1 } }, opts);
    createTask(userId, { title: 'Prepare invoice for freelance project', due: date(5), priority: 'high', important: true, estimate_minutes: 30, category: 'Freelance' }, opts);

    const money = (days, type, amount, category, description, merchant = "") => createTransaction(userId, { type, amount, category, date: date(days), description, merchant }, { ...opts, source: 'demo' });
    const start = now.startOf('month');
    const offset = (dt) => Math.round(dt.startOf('day').diff(now.startOf('day'), 'days').days);
    for (const [monthBack, salary] of [[1, 85000], [0, 85000]]) {
      const ms = start.minus({ months: monthBack });
      const o = offset(ms);
      const inRange = (n) => (monthBack === 0 ? o + n <= 0 : true);
      if (inRange(0)) money(o, 'income', salary, 'Salary', 'Monthly salary', 'Employer Pvt Ltd');
      if (inRange(1)) money(o + 1, 'expense', 22000, 'Rent & Housing', 'Rent', 'Landlord');
      if (inRange(2)) money(o + 2, 'expense', 1840, 'Utilities', 'Electricity bill', 'BESCOM');
      if (inRange(3)) money(o + 3, 'expense', 2350, 'Groceries', 'Weekly groceries', 'BigBasket');
      if (inRange(4)) money(o + 4, 'expense', 649, 'Subscriptions', 'Streaming subscription', 'Netflix');
      if (inRange(5)) money(o + 5, 'expense', 480, 'Food & Dining', 'Lunch with team', 'Truffles');
      if (inRange(6)) money(o + 6, 'expense', 320, 'Transport', 'Cab to office', 'Uber');
      if (inRange(8)) money(o + 8, 'expense', 1250, 'Food & Dining', 'Dinner', 'Toit');
      if (inRange(9)) money(o + 9, 'income', 18000, 'Freelance', 'Logo design project', 'Client');
      if (inRange(10)) money(o + 10, 'expense', 2780, 'Groceries', 'Groceries', 'DMart');
      if (inRange(11)) money(o + 11, 'expense', 3999, 'Shopping', 'Running shoes', 'Decathlon');
      if (inRange(12)) money(o + 12, 'expense', 260, 'Transport', 'Metro card top-up', 'Namma Metro');
      if (inRange(14)) money(o + 14, 'expense', 890, 'Food & Dining', 'Food delivery', 'Swiggy');
      if (inRange(15)) money(o + 15, 'expense', 1500, 'Health', 'Pharmacy', 'Apollo');
      if (inRange(17)) money(o + 17, 'expense', 540, 'Transport', 'Cab', 'Ola');
      if (inRange(18)) money(o + 18, 'expense', 760, 'Entertainment', 'Movie tickets', 'PVR');
      if (inRange(20)) money(o + 20, 'expense', 2100, 'Groceries', 'Groceries', 'BigBasket');
      if (inRange(22)) money(o + 22, 'expense', 1320, 'Food & Dining', 'Weekend brunch', 'Third Wave');
      if (inRange(25)) money(o + 25, 'expense', 450, 'Transport', 'Fuel', 'HP Petrol');
    }
    setBudget(userId, { category: 'Food & Dining', amount: 4000 });
    setBudget(userId, { category: 'Transport', amount: 1500 });
    setBudget(userId, { category: 'Groceries', amount: 8000 });
    setBudget(userId, { category: 'Shopping', amount: 3000 });
    db.prepare('UPDATE budgets SET is_demo = 1 WHERE user_id = ?').run(userId);

    createBill(userId, { name: 'Electricity (BESCOM)', amount: 1900, category: 'Utilities', due_date: date(4), recurrence: 'monthly' }, opts);
    createBill(userId, { name: 'Broadband', amount: 999, category: 'Utilities', due_date: date(1), recurrence: 'monthly', autopay: true }, opts);
    createBill(userId, { name: 'Netflix', amount: 649, category: 'Subscriptions', kind: 'subscription', due_date: date(9), recurrence: 'monthly' }, opts);
    createBill(userId, { name: 'Health insurance premium', amount: 14500, category: 'Health', due_date: date(26), recurrence: 'yearly' }, opts);
    createGoal(userId, { name: 'Emergency fund', target: 300000, saved: 120000, deadline: date(240) }, opts);
    createGoal(userId, { name: 'Goa trip', target: 40000, saved: 15500, deadline: date(75) }, opts);

    createReminder(userId, { title: 'Pay electricity bill', remind_at: d(3, '09:00'), entity_type: null }, opts);
    createReminder(userId, { title: 'Call mom', remind_at: d(0, '19:30'), recurrence: { freq: 'weekly', interval: 1 } }, opts);

    createNote(userId, { title: 'Acme Corp — phase 2 notes', category: 'Meetings', tags: ['acme', 'client'], content: 'Discussed phase 2 scope.\n\n- [ ] Send revised estimate to Rahul\n- [ ] Confirm launch date with design team\nAction: share invoice status before the next call.\n\nOpen questions: analytics integration, SSO.' }, opts);
    createNote(userId, { title: 'Portfolio site ideas', category: 'Ideas', tags: ['portfolio', 'design'], content: 'Dark theme with electric-blue accents. Case studies first. Add a "now" page.\nTODO: pick a font pairing' }, opts);
    createNote(userId, { title: 'Statistics — key formulas', category: 'Study', tags: ['study'], content: 'Variance = E[X²] − (E[X])²\nStandard error = σ/√n\nCentral limit theorem: sample means approach normal as n grows.' }, opts);
  });
  updateSettings(userId, { demoMode: true });
  audit(userId, 'user', 'load_demo', null, null);
  return demoCounts(userId);
}

export function clearDemoData(userId) {
  tx(() => {
    for (const t of DEMO_TABLES) db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND is_demo = 1`).run(userId);
  });
  updateSettings(userId, { demoMode: false });
}

export function demoCounts(userId) {
  const out = {};
  for (const t of DEMO_TABLES) out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ? AND is_demo = 1`).get(userId).n;
  return out;
}
