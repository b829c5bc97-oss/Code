import express from 'express';
import { z } from 'zod';
import { parseBody, HttpError } from '../http.js';
import { getSettings } from '../settings.js';
import { DateTime } from '../services/time.js';
import * as f from '../services/finance.js';

export const finance = express.Router();
const uid = (req) => req.user.id;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

finance.get('/categories', (req, res) => res.json(f.listCategories(uid(req))));
finance.post('/categories', (req, res) => res.status(201).json(f.createCategory(uid(req), req.body)));
finance.patch('/categories/:id', (req, res) => {
  f.updateCategory(uid(req), req.params.id, req.body);
  res.json({ ok: true });
});
finance.delete('/categories/:id', (req, res) => {
  f.deleteCategory(uid(req), req.params.id);
  res.json({ ok: true });
});

finance.get('/transactions', (req, res) => {
  const q = req.query;
  res.json(f.listTransactions(uid(req), { from: q.from, to: q.to, type: q.type, category_id: q.category_id, query: q.q, limit: q.limit }));
});
finance.post('/transactions', (req, res) => res.status(201).json(f.createTransaction(uid(req), parseBody(f.transactionInput, req.body))));
finance.patch('/transactions/:id', (req, res) => res.json(f.updateTransaction(uid(req), req.params.id, parseBody(f.transactionPatch, req.body))));
finance.delete('/transactions/:id', (req, res) => res.json(f.deleteTransaction(uid(req), req.params.id)));

finance.get('/summary', (req, res) => {
  const zone = getSettings(uid(req)).timezone;
  const now = DateTime.now().setZone(zone);
  const month = typeof req.query.month === 'string' ? req.query.month : now.toFormat('yyyy-MM');
  const { from, to, start } = f.monthRange(month);
  const prev = f.monthRange(start.minus({ months: 1 }).toFormat('yyyy-MM'));
  res.json({
    month,
    summary: f.summary(uid(req), from, to),
    previous: f.summary(uid(req), prev.from, prev.to),
    budgets: f.budgetStatus(uid(req), month),
    upcoming_bills: f.upcomingBills(uid(req), 30),
    recurring: f.recurringEstimate(uid(req)),
    goals: f.listGoals(uid(req)),
  });
});
finance.get('/range', (req, res) => {
  const b = parseBody(z.object({ from: date, to: date }), req.query);
  res.json(f.summary(uid(req), b.from, b.to));
});
finance.get('/year/:year', (req, res) => res.json(f.yearSummary(uid(req), parseBody(z.coerce.number().int().min(1970).max(2100), req.params.year))));
finance.get('/compare', (req, res) => {
  const b = parseBody(z.object({ a_from: date, a_to: date, b_from: date, b_to: date }), req.query);
  res.json(f.comparePeriods(uid(req), { from: b.a_from, to: b.a_to }, { from: b.b_from, to: b.b_to }));
});

finance.get('/budgets', (req, res) => res.json(f.budgetStatus(uid(req), req.query.month)));
finance.put('/budgets', (req, res) => res.json(f.setBudget(uid(req), req.body)));
finance.delete('/budgets/:id', (req, res) => {
  f.deleteBudget(uid(req), req.params.id);
  res.json({ ok: true });
});

finance.get('/bills', (req, res) => res.json(f.listBills(uid(req), { status: req.query.status, kind: req.query.kind })));
finance.post('/bills', (req, res) => res.status(201).json(f.createBill(uid(req), req.body)));
finance.patch('/bills/:id', (req, res) => res.json(f.updateBill(uid(req), req.params.id, req.body)));
finance.delete('/bills/:id', (req, res) => res.json(f.deleteBill(uid(req), req.params.id)));
finance.post('/bills/:id/paid', (req, res) => {
  const b = parseBody(z.object({ paid_on: date.optional(), record_transaction: z.boolean().default(true) }), req.body);
  res.json(f.markBillPaid(uid(req), req.params.id, b));
});

finance.get('/goals', (req, res) => res.json(f.listGoals(uid(req))));
finance.post('/goals', (req, res) => res.status(201).json(f.createGoal(uid(req), req.body)));
finance.patch('/goals/:id', (req, res) => res.json(f.updateGoal(uid(req), req.params.id, req.body)));
finance.delete('/goals/:id', (req, res) => {
  f.deleteGoal(uid(req), req.params.id);
  res.json({ ok: true });
});

finance.post('/import/preview', express.text({ type: ['text/csv', 'text/plain'], limit: '6mb' }), (req, res) => {
  const text = typeof req.body === 'string' ? req.body : String(req.body?.csv || '');
  let mapping;
  try {
    mapping = req.query.mapping ? parseBody(z.record(z.string(), z.number().int().min(0).max(200)), JSON.parse(String(req.query.mapping))) : undefined;
  } catch {
    throw new HttpError(400, 'Invalid column mapping.');
  }
  res.json(f.previewCsv(uid(req), text, { mapping, dateOrder: req.query.date_order === 'mdy' ? 'mdy' : 'dmy' }));
});
finance.post('/import/commit', (req, res) => res.json(f.commitImport(uid(req), req.body)));
finance.get('/export.csv', (req, res) => {
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="jarvis-transactions-${DateTime.now().toISODate()}.csv"`);
  res.send(f.exportTransactionsCsv(uid(req), { from: req.query.from, to: req.query.to }));
});
