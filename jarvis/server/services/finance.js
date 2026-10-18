import { z } from 'zod';
import crypto from 'node:crypto';
import { db, id, nowIso, updateRow, audit, tx } from '../db.js';
import { getSettings } from '../settings.js';
import { DateTime } from './time.js';
import { HttpError, notFound } from '../http.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.number().finite().positive().max(1e12);

export function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}
export const toMinor = (amount, currency) => Math.round(amount * 10 ** currencyDigits(currency));
export const toMajor = (minor, currency) => minor / 10 ** currencyDigits(currency);

export function formatMoney(minor, currency, locale = 'en-IN') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(toMajor(minor, currency));
}

// ---------- categories ----------
export const categoryInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['expense', 'income']).default('expense'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
});

export const listCategories = (userId) => db.prepare('SELECT id, name, kind, color FROM categories WHERE user_id = ? ORDER BY kind, name').all(userId);

export function createCategory(userId, raw) {
  const c = categoryInput.parse(raw);
  if (db.prepare('SELECT 1 FROM categories WHERE user_id = ? AND name = ? AND kind = ?').get(userId, c.name, c.kind)) throw new HttpError(409, 'That category already exists.');
  const cid = id();
  db.prepare('INSERT INTO categories (id, user_id, name, kind, color) VALUES (?,?,?,?,?)').run(cid, userId, c.name, c.kind, c.color);
  return { id: cid, ...c };
}

export function updateCategory(userId, cid, raw) {
  const c = categoryInput.partial().parse(raw);
  if (!updateRow('categories', userId, cid, c, ['name', 'kind', 'color'])) throw notFound('Category');
}

export function deleteCategory(userId, cid) {
  if (!db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(cid, userId).changes) throw notFound('Category');
}

/** Find a category by id or (case-insensitive) name; optionally create it. */
export function resolveCategory(userId, ref, kind = 'expense', create = false) {
  if (!ref) return null;
  const byId = db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(ref, userId);
  if (byId) return byId.id;
  const byName = db.prepare('SELECT id FROM categories WHERE user_id = ? AND lower(name) = lower(?) ORDER BY kind = ? DESC').get(userId, String(ref).trim(), kind);
  if (byName) return byName.id;
  if (!create) return null;
  return createCategory(userId, { name: String(ref).trim().slice(0, 60), kind }).id;
}

// ---------- transactions ----------
export const transactionInput = z.object({
  type: z.enum(['expense', 'income']),
  amount: money.describe('Amount in major units of the currency, e.g. 249.50'),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  category: z.string().max(80).nullable().optional().describe('Category id or name'),
  date: date.describe('Date the money moved (YYYY-MM-DD)'),
  description: z.string().max(500).optional().default(''),
  merchant: z.string().max(200).optional().default(''),
  notes: z.string().max(2000).optional().default(''),
});
export const transactionPatch = transactionInput.partial();

function serializeTx(r) {
  return {
    id: r.id, type: r.type, amount: toMajor(r.amount_minor, r.currency), amount_minor: r.amount_minor, currency: r.currency,
    category_id: r.category_id, category: r.category_name || null, date: r.occurred_on, description: r.description,
    merchant: r.merchant, notes: r.notes, source: r.source, is_demo: !!r.is_demo,
  };
}

const TX_SELECT = 'SELECT t.*, c.name AS category_name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id';

export function listTransactions(userId, f = {}) {
  const where = ['t.user_id = ?'];
  const args = [userId];
  if (f.from) { where.push('t.occurred_on >= ?'); args.push(f.from); }
  if (f.to) { where.push('t.occurred_on <= ?'); args.push(f.to); }
  if (f.type) { where.push('t.type = ?'); args.push(f.type); }
  if (f.category_id) { where.push('t.category_id = ?'); args.push(f.category_id); }
  if (f.category) {
    const cid = resolveCategory(userId, f.category);
    if (!cid) return [];
    where.push('t.category_id = ?'); args.push(cid);
  }
  if (f.query) {
    where.push('(lower(t.description) LIKE ? OR lower(t.merchant) LIKE ? OR lower(t.notes) LIKE ?)');
    const q = `%${String(f.query).toLowerCase()}%`;
    args.push(q, q, q);
  }
  const limit = Math.min(Number(f.limit) || 500, 5000);
  return db.prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT ${limit}`).all(...args).map(serializeTx);
}

export function getTransaction(userId, tid) {
  const r = db.prepare(`${TX_SELECT} WHERE t.id = ? AND t.user_id = ?`).get(tid, userId);
  if (!r) throw notFound('Transaction');
  return serializeTx(r);
}

export function importHash(userId, t) {
  const norm = `${t.date}|${t.type}|${t.amount_minor}|${String(t.description || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
  return crypto.createHash('sha256').update(`${userId}|${norm}`).digest('hex').slice(0, 32);
}

export function createTransaction(userId, raw, { actor = 'user', source = 'manual', isDemo = false } = {}) {
  const t = transactionInput.parse(raw);
  const currency = t.currency || getSettings(userId).currency;
  const amountMinor = toMinor(t.amount, currency);
  const categoryId = t.category ? resolveCategory(userId, t.category, t.type, actor === 'user') : null;
  if (t.category && !categoryId) throw new HttpError(400, `Unknown category "${t.category}". Create it first or pick an existing one.`);
  const tid = id();
  db.prepare(`INSERT INTO transactions (id, user_id, type, amount_minor, currency, category_id, occurred_on, description, merchant, notes, source, import_hash, is_demo, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tid, userId, t.type, amountMinor, currency, categoryId, t.date, t.description, t.merchant, t.notes, source,
    importHash(userId, { date: t.date, type: t.type, amount_minor: amountMinor, description: t.description }), isDemo ? 1 : 0, nowIso());
  audit(userId, actor, 'create', 'transaction', tid, `${t.type} ${t.amount} ${currency}`);
  return getTransaction(userId, tid);
}

export function updateTransaction(userId, tid, raw, { actor = 'user' } = {}) {
  const cur = getTransaction(userId, tid);
  const t = transactionPatch.parse(raw);
  const patch = {};
  if (t.type) patch.type = t.type;
  if (t.currency) patch.currency = t.currency;
  if (t.amount != null) patch.amount_minor = toMinor(t.amount, t.currency || cur.currency);
  if (t.date) patch.occurred_on = t.date;
  if (t.description != null) patch.description = t.description;
  if (t.merchant != null) patch.merchant = t.merchant;
  if (t.notes != null) patch.notes = t.notes;
  if ('category' in t) {
    patch.category_id = t.category ? resolveCategory(userId, t.category, t.type || cur.type, actor === 'user') : null;
    if (t.category && !patch.category_id) throw new HttpError(400, `Unknown category "${t.category}".`);
  }
  updateRow('transactions', userId, tid, patch, ['type', 'currency', 'amount_minor', 'occurred_on', 'description', 'merchant', 'notes', 'category_id']);
  audit(userId, actor, 'update', 'transaction', tid, Object.keys(t).join(','));
  return getTransaction(userId, tid);
}

export function deleteTransaction(userId, tid, { actor = 'user' } = {}) {
  const cur = getTransaction(userId, tid);
  db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(tid, userId);
  audit(userId, actor, 'delete', 'transaction', tid, `${cur.type} ${cur.amount}`);
  return { deleted: true };
}

// ---------- summaries ----------
/**
 * Totals for [from, to] inclusive computed from stored transactions only.
 * Amounts in other currencies are reported separately (no FX conversion).
 */
export function summary(userId, from, to) {
  const currency = getSettings(userId).currency;
  const totals = db.prepare(`SELECT type, COALESCE(SUM(amount_minor),0) total, COUNT(*) n FROM transactions WHERE user_id = ? AND currency = ? AND occurred_on BETWEEN ? AND ? GROUP BY type`).all(userId, currency, from, to);
  const get = (type) => totals.find((r) => r.type === type) || { total: 0, n: 0 };
  const byCategory = db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') name, c.id category_id, c.color, SUM(t.amount_minor) total, COUNT(*) n
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.currency = ? AND t.type = 'expense' AND t.occurred_on BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`).all(userId, currency, from, to);
  const incomeByCategory = db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') name, SUM(t.amount_minor) total
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND t.currency = ? AND t.type = 'income' AND t.occurred_on BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`).all(userId, currency, from, to);
  const daily = db.prepare(`SELECT occurred_on date, SUM(CASE WHEN type='expense' THEN amount_minor ELSE 0 END) expense, SUM(CASE WHEN type='income' THEN amount_minor ELSE 0 END) income
    FROM transactions WHERE user_id = ? AND currency = ? AND occurred_on BETWEEN ? AND ? GROUP BY occurred_on ORDER BY occurred_on`).all(userId, currency, from, to);
  const topMerchants = db.prepare(`SELECT COALESCE(NULLIF(merchant,''), description) name, SUM(amount_minor) total, COUNT(*) n FROM transactions
    WHERE user_id = ? AND currency = ? AND type = 'expense' AND occurred_on BETWEEN ? AND ? GROUP BY lower(COALESCE(NULLIF(merchant,''), description)) ORDER BY total DESC LIMIT 5`).all(userId, currency, from, to);
  const otherCurrencies = db.prepare(`SELECT currency, type, SUM(amount_minor) total, COUNT(*) n FROM transactions WHERE user_id = ? AND currency != ? AND occurred_on BETWEEN ? AND ? GROUP BY currency, type`).all(userId, currency, from, to);
  const expense = get('expense');
  const income = get('income');
  return {
    basis: 'recorded transactions',
    currency, from, to,
    income_minor: income.total, expense_minor: expense.total, net_minor: income.total - expense.total,
    income_count: income.n, expense_count: expense.n,
    by_category: byCategory.map((c) => ({ ...c, share: expense.total ? Math.round((c.total / expense.total) * 1000) / 10 : 0 })),
    income_by_category: incomeByCategory,
    daily, top_merchants: topMerchants,
    other_currencies: otherCurrencies,
  };
}

export function monthRange(month) {
  const start = DateTime.fromISO(`${month}-01`);
  if (!start.isValid) throw new HttpError(400, 'Month must be YYYY-MM.');
  return { from: start.toISODate(), to: start.endOf('month').toISODate(), start };
}

export function comparePeriods(userId, a, b) {
  const sa = summary(userId, a.from, a.to);
  const sb = summary(userId, b.from, b.to);
  const cats = new Map();
  for (const c of sa.by_category) cats.set(c.name, { name: c.name, a: c.total, b: 0 });
  for (const c of sb.by_category) cats.set(c.name, { ...(cats.get(c.name) || { name: c.name, a: 0 }), b: c.total });
  const pct = (x, y) => (y ? Math.round(((x - y) / y) * 1000) / 10 : null);
  return {
    basis: 'recorded transactions', currency: sa.currency,
    period_a: { from: a.from, to: a.to, expense_minor: sa.expense_minor, income_minor: sa.income_minor },
    period_b: { from: b.from, to: b.to, expense_minor: sb.expense_minor, income_minor: sb.income_minor },
    expense_change_pct: pct(sa.expense_minor, sb.expense_minor),
    income_change_pct: pct(sa.income_minor, sb.income_minor),
    by_category: [...cats.values()].map((c) => ({ ...c, diff: c.a - c.b, change_pct: pct(c.a, c.b) })).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)),
  };
}

export function yearSummary(userId, year) {
  const currency = getSettings(userId).currency;
  const rows = db.prepare(`SELECT substr(occurred_on,1,7) month, SUM(CASE WHEN type='expense' THEN amount_minor ELSE 0 END) expense, SUM(CASE WHEN type='income' THEN amount_minor ELSE 0 END) income
    FROM transactions WHERE user_id = ? AND currency = ? AND occurred_on BETWEEN ? AND ? GROUP BY month ORDER BY month`).all(userId, currency, `${year}-01-01`, `${year}-12-31`);
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const r = rows.find((x) => x.month === key) || { expense: 0, income: 0 };
    months.push({ month: key, expense_minor: r.expense, income_minor: r.income, net_minor: r.income - r.expense });
  }
  const s = summary(userId, `${year}-01-01`, `${year}-12-31`);
  return { basis: 'recorded transactions', currency, year, months, totals: { income_minor: s.income_minor, expense_minor: s.expense_minor, net_minor: s.net_minor }, by_category: s.by_category };
}

// ---------- budgets ----------
export const budgetInput = z.object({ category: z.string().min(1).max(80), amount: money });

export function setBudget(userId, raw, { actor = 'user' } = {}) {
  const b = budgetInput.parse(raw);
  const cid = resolveCategory(userId, b.category, 'expense');
  if (!cid) throw new HttpError(400, `Unknown category "${b.category}".`);
  const currency = getSettings(userId).currency;
  db.prepare('INSERT INTO budgets (id, user_id, category_id, amount_minor) VALUES (?,?,?,?) ON CONFLICT(user_id, category_id) DO UPDATE SET amount_minor = excluded.amount_minor')
    .run(id(), userId, cid, toMinor(b.amount, currency));
  audit(userId, actor, 'set_budget', 'category', cid, String(b.amount));
  return budgetStatus(userId).find((x) => x.category_id === cid);
}

export function deleteBudget(userId, budgetId) {
  if (!db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(budgetId, userId).changes) throw notFound('Budget');
}

/** Monthly budget progress. `projected_minor` is a straight-line forecast, labelled as such. */
export function budgetStatus(userId, month) {
  const zone = getSettings(userId).timezone;
  const today = DateTime.now().setZone(zone);
  const m = month || today.toFormat('yyyy-MM');
  const { from, to, start } = monthRange(m);
  const currency = getSettings(userId).currency;
  const daysInMonth = start.daysInMonth;
  const isCurrent = today.toFormat('yyyy-MM') === m;
  const elapsed = isCurrent ? today.day : (start < today ? daysInMonth : 0);
  const rows = db.prepare(`SELECT b.id, b.category_id, b.amount_minor, c.name, c.color,
      (SELECT COALESCE(SUM(t.amount_minor),0) FROM transactions t WHERE t.user_id = b.user_id AND t.category_id = b.category_id AND t.type = 'expense' AND t.currency = ? AND t.occurred_on BETWEEN ? AND ?) spent
    FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.user_id = ? ORDER BY c.name`).all(currency, from, to, userId);
  return rows.map((r) => {
    const projected = elapsed ? Math.round((r.spent / elapsed) * daysInMonth) : 0;
    const pct = r.amount_minor ? Math.round((r.spent / r.amount_minor) * 1000) / 10 : 0;
    return {
      id: r.id, category_id: r.category_id, category: r.name, color: r.color, month: m, currency,
      budget_minor: r.amount_minor, spent_minor: r.spent, remaining_minor: r.amount_minor - r.spent, percent_used: pct,
      projected_minor: isCurrent ? projected : null, projection_basis: isCurrent ? 'forecast: straight-line from spending so far this month' : null,
      status: pct >= 100 ? 'exceeded' : pct >= 80 || (isCurrent && projected > r.amount_minor) ? 'at_risk' : 'ok',
    };
  });
}

// ---------- bills & subscriptions ----------
export const billInput = z.object({
  name: z.string().trim().min(1).max(200),
  amount: money,
  category: z.string().max(80).nullable().optional(),
  kind: z.enum(['bill', 'subscription']).optional().default('bill'),
  due_date: date,
  recurrence: z.enum(['none', 'weekly', 'monthly', 'quarterly', 'yearly']).optional().default('monthly'),
  autopay: z.boolean().optional().default(false),
  notes: z.string().max(1000).optional().default(''),
});

function serializeBill(r, currency) {
  return {
    id: r.id, name: r.name, amount: toMajor(r.amount_minor, currency), amount_minor: r.amount_minor, currency, category_id: r.category_id, category: r.category_name || null,
    kind: r.kind, due_date: r.due_date, recurrence: r.recurrence, status: r.status, last_paid_on: r.last_paid_on, autopay: !!r.autopay, notes: r.notes, is_demo: !!r.is_demo,
  };
}

export function listBills(userId, { status, kind, due_before } = {}) {
  const currency = getSettings(userId).currency;
  const where = ['b.user_id = ?'];
  const args = [userId];
  if (status) { where.push('b.status = ?'); args.push(status); }
  if (kind) { where.push('b.kind = ?'); args.push(kind); }
  if (due_before) { where.push('b.due_date <= ?'); args.push(due_before); }
  return db.prepare(`SELECT b.*, c.name category_name FROM bills b LEFT JOIN categories c ON c.id = b.category_id WHERE ${where.join(' AND ')} ORDER BY b.due_date`).all(...args).map((r) => serializeBill(r, currency));
}

export function getBill(userId, bid) {
  const r = db.prepare('SELECT b.*, c.name category_name FROM bills b LEFT JOIN categories c ON c.id = b.category_id WHERE b.id = ? AND b.user_id = ?').get(bid, userId);
  if (!r) throw notFound('Bill');
  return serializeBill(r, getSettings(userId).currency);
}

export function createBill(userId, raw, { actor = 'user', isDemo = false } = {}) {
  const b = billInput.parse(raw);
  const currency = getSettings(userId).currency;
  const cid = b.category ? resolveCategory(userId, b.category, 'expense') : null;
  const bid = id();
  db.prepare('INSERT INTO bills (id, user_id, name, amount_minor, category_id, kind, due_date, recurrence, autopay, notes, is_demo, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(bid, userId, b.name, toMinor(b.amount, currency), cid, b.kind, b.due_date, b.recurrence, b.autopay ? 1 : 0, b.notes, isDemo ? 1 : 0, nowIso());
  audit(userId, actor, 'create', 'bill', bid, b.name);
  return getBill(userId, bid);
}

export function updateBill(userId, bid, raw, { actor = 'user' } = {}) {
  getBill(userId, bid);
  const b = billInput.partial().extend({ status: z.enum(['unpaid', 'paid']).optional() }).parse(raw);
  const currency = getSettings(userId).currency;
  const patch = { ...b };
  delete patch.amount; delete patch.category;
  if (b.amount != null) patch.amount_minor = toMinor(b.amount, currency);
  if ('category' in b) patch.category_id = b.category ? resolveCategory(userId, b.category, 'expense') : null;
  updateRow('bills', userId, bid, patch, ['name', 'amount_minor', 'category_id', 'kind', 'due_date', 'recurrence', 'autopay', 'notes', 'status']);
  audit(userId, actor, 'update', 'bill', bid, Object.keys(b).join(','));
  return getBill(userId, bid);
}

export function deleteBill(userId, bid, { actor = 'user' } = {}) {
  const b = getBill(userId, bid);
  db.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').run(bid, userId);
  audit(userId, actor, 'delete', 'bill', bid, b.name);
  return { deleted: true, name: b.name };
}

const advance = { weekly: { weeks: 1 }, monthly: { months: 1 }, quarterly: { months: 3 }, yearly: { years: 1 } };

/**
 * Record that the user paid a bill (JARVIS never pays anything itself).
 * Optionally logs the expense, and rolls a recurring bill to its next due date.
 */
export function markBillPaid(userId, bid, { paid_on, record_transaction = true, actor = 'user' } = {}) {
  const b = getBill(userId, bid);
  const zone = getSettings(userId).timezone;
  const paidOn = paid_on || DateTime.now().setZone(zone).toISODate();
  return tx(() => {
    let transaction = null;
    if (record_transaction) {
      transaction = createTransaction(userId, { type: 'expense', amount: b.amount, category: b.category_id, date: paidOn, description: b.name, merchant: b.name, notes: 'Recorded when bill was marked paid' }, { actor, source: 'bill' });
    }
    if (b.recurrence !== 'none' && advance[b.recurrence]) {
      const next = DateTime.fromISO(b.due_date).plus(advance[b.recurrence]).toISODate();
      db.prepare("UPDATE bills SET due_date = ?, status = 'unpaid', last_paid_on = ? WHERE id = ? AND user_id = ?").run(next, paidOn, bid, userId);
    } else {
      db.prepare("UPDATE bills SET status = 'paid', last_paid_on = ? WHERE id = ? AND user_id = ?").run(paidOn, bid, userId);
    }
    audit(userId, actor, 'mark_paid', 'bill', bid, paidOn);
    return { bill: getBill(userId, bid), transaction };
  });
}

/** Unpaid bills due within `days` (inclusive), plus overdue ones. These are scheduled amounts, not recorded spending. */
export function upcomingBills(userId, days = 14) {
  const zone = getSettings(userId).timezone;
  const today = DateTime.now().setZone(zone).startOf('day');
  const limit = today.plus({ days }).toISODate();
  return listBills(userId, { status: 'unpaid', due_before: limit }).map((b) => ({
    ...b, days_until_due: Math.round(DateTime.fromISO(b.due_date, { zone }).diff(today, 'days').days), basis: 'scheduled bill (not yet recorded as spending)',
  }));
}

/** Monthly-equivalent cost of recurring bills/subscriptions: an estimate, not actual spending. */
export function recurringEstimate(userId) {
  const factor = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, none: 0 };
  const bills = listBills(userId);
  const monthly = bills.reduce((s, b) => s + Math.round(b.amount_minor * (factor[b.recurrence] ?? 0)), 0);
  return { basis: 'estimate from recurring bills and subscriptions', monthly_minor: monthly, subscriptions_monthly_minor: bills.filter((b) => b.kind === 'subscription').reduce((s, b) => s + Math.round(b.amount_minor * (factor[b.recurrence] ?? 0)), 0) };
}

// ---------- savings goals ----------
export const goalInput = z.object({
  name: z.string().trim().min(1).max(200),
  target: money,
  saved: z.number().finite().min(0).max(1e12).optional().default(0),
  deadline: date.nullable().optional(),
});

function serializeGoal(r, currency) {
  return { id: r.id, name: r.name, target: toMajor(r.target_minor, currency), saved: toMajor(r.saved_minor, currency), target_minor: r.target_minor, saved_minor: r.saved_minor, deadline: r.deadline, currency, progress: r.target_minor ? Math.min(100, Math.round((r.saved_minor / r.target_minor) * 100)) : 0, is_demo: !!r.is_demo };
}

export function listGoals(userId) {
  const currency = getSettings(userId).currency;
  return db.prepare('SELECT * FROM savings_goals WHERE user_id = ? ORDER BY deadline IS NULL, deadline').all(userId).map((r) => serializeGoal(r, currency));
}

export function createGoal(userId, raw, { isDemo = false } = {}) {
  const g = goalInput.parse(raw);
  const currency = getSettings(userId).currency;
  const gid = id();
  db.prepare('INSERT INTO savings_goals (id, user_id, name, target_minor, saved_minor, deadline, is_demo, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(gid, userId, g.name, toMinor(g.target, currency), toMinor(g.saved, currency), g.deadline ?? null, isDemo ? 1 : 0, nowIso());
  return listGoals(userId).find((x) => x.id === gid);
}

export function updateGoal(userId, gid, raw) {
  const g = goalInput.partial().extend({ contribute: z.number().finite().optional() }).parse(raw);
  const currency = getSettings(userId).currency;
  const row = db.prepare('SELECT * FROM savings_goals WHERE id = ? AND user_id = ?').get(gid, userId);
  if (!row) throw notFound('Savings goal');
  const patch = {};
  if (g.name) patch.name = g.name;
  if (g.target != null) patch.target_minor = toMinor(g.target, currency);
  if (g.saved != null) patch.saved_minor = toMinor(g.saved, currency);
  if (g.contribute) patch.saved_minor = Math.max(0, (patch.saved_minor ?? row.saved_minor) + toMinor(g.contribute, currency));
  if ('deadline' in g) patch.deadline = g.deadline ?? null;
  updateRow('savings_goals', userId, gid, patch, ['name', 'target_minor', 'saved_minor', 'deadline']);
  return listGoals(userId).find((x) => x.id === gid);
}

export function deleteGoal(userId, gid) {
  if (!db.prepare('DELETE FROM savings_goals WHERE id = ? AND user_id = ?').run(gid, userId).changes) throw notFound('Savings goal');
}

// ---------- CSV import / export ----------
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'txn date', 'value date', 'posted date', 'booking date'],
  description: ['description', 'narration', 'details', 'particulars', 'memo', 'remarks', 'name'],
  amount: ['amount', 'value', 'amount (inr)', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'withdrawal amt.', 'withdrawal amount', 'dr', 'debit amount', 'money out'],
  credit: ['credit', 'deposit', 'deposit amt.', 'deposit amount', 'cr', 'credit amount', 'money in'],
  type: ['type', 'transaction type', 'dr/cr'],
  category: ['category'],
  merchant: ['merchant', 'payee'],
};

export function detectMapping(header) {
  const h = header.map((x) => x.trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = h.findIndex((col) => aliases.includes(col));
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /\bdr\b/i.test(s);
  s = s.replace(/[^\d.,-]/g, '').replace(/-/g, '');
  // Treat comma as thousands separator unless it's the only separator and looks decimal (e.g. "12,50").
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function parseDate(raw, preferDayFirst = true) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const formats = preferDayFirst
    ? ['yyyy-MM-dd', 'dd/MM/yyyy', 'dd-MM-yyyy', 'dd/MM/yy', 'dd-MM-yy', 'd/M/yyyy', 'dd MMM yyyy', 'd MMM yyyy', 'dd-MMM-yyyy', 'dd-MMM-yy', 'MM/dd/yyyy', 'yyyy/MM/dd', 'dd.MM.yyyy']
    : ['yyyy-MM-dd', 'MM/dd/yyyy', 'M/d/yyyy', 'MM/dd/yy', 'dd/MM/yyyy', 'dd MMM yyyy', 'MMM d, yyyy', 'yyyy/MM/dd'];
  for (const f of formats) {
    const d = DateTime.fromFormat(s, f);
    if (d.isValid) return d.toISODate();
  }
  const iso = DateTime.fromISO(s);
  return iso.isValid ? iso.toISODate() : null;
}

/** Parse + validate a CSV without saving. Flags duplicates against stored data and within the file. */
export function previewCsv(userId, text, { mapping, dateOrder = 'dmy' } = {}) {
  if (text.length > 5_000_000) throw new HttpError(413, 'CSV is larger than 5 MB.');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one data row.');
  const header = rows[0];
  const map = { ...detectMapping(header), ...(mapping || {}) };
  if (map.date == null) throw new HttpError(400, 'Could not find a date column. Map the columns manually.', { header });
  if (map.amount == null && map.debit == null && map.credit == null) throw new HttpError(400, 'Could not find an amount (or debit/credit) column. Map the columns manually.', { header });
  if (rows.length > 10001) throw new HttpError(400, 'Import at most 10,000 rows at a time.');
  const currency = getSettings(userId).currency;
  const seen = new Set();
  const existing = db.prepare('SELECT 1 FROM transactions WHERE user_id = ? AND import_hash = ?');
  const out = rows.slice(1).map((cells, i) => {
    const errors = [];
    const dateVal = parseDate(cells[map.date], dateOrder === 'dmy');
    if (!dateVal) errors.push(`Unrecognised date "${cells[map.date] ?? ''}"`);
    let amount = null;
    let type = null;
    if (map.amount != null) {
      amount = parseAmount(cells[map.amount]);
      if (amount != null) {
        type = amount < 0 ? 'expense' : 'income';
        if (map.type != null) {
          const t = String(cells[map.type] || '').toLowerCase();
          if (/(debit|dr|withdraw|expense|out)/.test(t)) type = 'expense';
          else if (/(credit|cr|deposit|income|in)/.test(t)) type = 'income';
        }
        amount = Math.abs(amount);
      }
    } else {
      const debit = parseAmount(cells[map.debit]);
      const credit = parseAmount(cells[map.credit]);
      if (debit) { amount = Math.abs(debit); type = 'expense'; } else if (credit) { amount = Math.abs(credit); type = 'income'; }
    }
    if (!amount) errors.push('Missing or zero amount');
    const description = String(cells[map.description] ?? '').trim().slice(0, 500);
    const category = map.category != null ? String(cells[map.category] || '').trim() : '';
    const merchant = map.merchant != null ? String(cells[map.merchant] || '').trim().slice(0, 200) : '';
    let duplicate = null;
    if (!errors.length) {
      const h = importHash(userId, { date: dateVal, type, amount_minor: toMinor(amount, currency), description });
      if (existing.get(userId, h)) duplicate = 'already recorded';
      else if (seen.has(h)) duplicate = 'repeated in this file';
      seen.add(h);
    }
    return { row: i + 2, date: dateVal, type, amount, description, category, merchant, errors, duplicate, include: !errors.length && !duplicate };
  });
  return { header, mapping: map, currency, rows: out, summary: { total: out.length, valid: out.filter((r) => !r.errors.length).length, duplicates: out.filter((r) => r.duplicate).length, invalid: out.filter((r) => r.errors.length).length } };
}

export const importRowsInput = z.object({
  rows: z.array(z.object({
    date, type: z.enum(['expense', 'income']), amount: money, description: z.string().max(500).default(''),
    category: z.string().max(80).optional().default(''), merchant: z.string().max(200).optional().default(''),
  })).min(1).max(10000),
  allow_duplicates: z.boolean().optional().default(false),
});

export function commitImport(userId, raw) {
  const { rows, allow_duplicates } = importRowsInput.parse(raw);
  const currency = getSettings(userId).currency;
  let imported = 0;
  let skipped = 0;
  tx(() => {
    const exists = db.prepare('SELECT 1 FROM transactions WHERE user_id = ? AND import_hash = ?');
    for (const r of rows) {
      const h = importHash(userId, { date: r.date, type: r.type, amount_minor: toMinor(r.amount, currency), description: r.description });
      if (!allow_duplicates && exists.get(userId, h)) { skipped++; continue; }
      const cid = r.category ? resolveCategory(userId, r.category, r.type, true) : null;
      db.prepare(`INSERT INTO transactions (id, user_id, type, amount_minor, currency, category_id, occurred_on, description, merchant, notes, source, import_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id(), userId, r.type, toMinor(r.amount, currency), currency, cid, r.date, r.description, r.merchant, '', 'csv', h, nowIso());
      imported++;
    }
  });
  audit(userId, 'user', 'csv_import', 'transaction', null, `${imported} imported, ${skipped} skipped`);
  return { imported, skipped_duplicates: skipped };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportTransactionsCsv(userId, f = {}) {
  const list = listTransactions(userId, { ...f, limit: 5000 });
  const lines = [['date', 'type', 'amount', 'currency', 'category', 'description', 'merchant', 'notes', 'source'].join(',')];
  for (const t of list) lines.push([t.date, t.type, t.amount, t.currency, t.category || '', t.description, t.merchant, t.notes, t.source].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}
