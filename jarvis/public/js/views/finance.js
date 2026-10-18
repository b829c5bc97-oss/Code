import { h, icon, clear, tabs, money, nowZ, emptyState, toast, toastError, debounce, demoBadge, progressBar, formModal, field, input, select, textarea, checkbox, confirmDialog, fmtDate, fmtRelDay, currencyDigits, downloadBlob, DateTime } from '../ui.js';
import { get, post, patch, put, del, api } from '../api.js';
import { state, onState, emit } from '../state.js';

let tab = 'overview';
let month = null;
const txFilters = { q: '', type: '', category_id: '', from: '', to: '' };

export async function render(el, { query }) {
  if (query.get('tab')) tab = query.get('tab');
  month ||= nowZ().toFormat('yyyy-MM');
  const tabBar = h('div');
  const body = h('div');
  clear(el,
    h('div', { class: 'page-head' },
      h('div', h('h1', 'Finance'), h('p', 'Track income, spending, budgets and bills. JARVIS never moves money or asks for banking passwords.')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => billDialog() }, icon('plus'), 'Bill'), h('button', { class: 'btn primary', onclick: () => txDialog() }, icon('plus'), 'Transaction'))),
    tabBar, body);
  const draw = async () => {
    clear(tabBar, tabs([['overview', 'Overview'], ['transactions', 'Transactions'], ['budgets', 'Budgets'], ['bills', 'Bills & subscriptions'], ['goals', 'Savings goals'], ['reports', 'Reports'], ['import', 'Import / export']], tab, (t) => { tab = t; draw(); }));
    try {
      await ({ overview, transactions, budgets, bills, goals, reports, import: importView })[tab](body, draw);
    } catch (e) {
      clear(body, emptyState(e.message));
    }
  };
  await draw();
  const off = onState((w) => w === 'data' && draw());
  return () => off();
}

function monthPicker(redraw) {
  const m = DateTime.fromISO(`${month}-01`);
  return h('div', { class: 'row tight' },
    h('button', { class: 'btn icon sm', 'aria-label': 'Previous month', onclick: () => { month = m.minus({ months: 1 }).toFormat('yyyy-MM'); redraw(); } }, icon('chevronLeft')),
    h('strong', { style: { 'min-width': '130px', 'text-align': 'center' } }, m.toFormat('LLLL yyyy')),
    h('button', { class: 'btn icon sm', 'aria-label': 'Next month', onclick: () => { month = m.plus({ months: 1 }).toFormat('yyyy-MM'); redraw(); } }, icon('chevronRight')));
}

const stat = (label, value, cls = '', sub) => h('div', { class: 'card stat' }, h('span', { class: 'label' }, label), h('span', { class: `value ${cls}` }, value), sub ? h('span', { class: 'sub' }, sub) : null);

async function overview(body, redraw) {
  const d = await get(`/finance/summary?month=${month}`);
  const x = d.summary;
  const prev = d.previous;
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const ch = pct(x.expense_minor, prev.expense_minor);
  const maxCat = Math.max(1, ...x.by_category.map((c) => c.total));
  clear(body,
    h('div', { class: 'row between', style: { 'margin-bottom': '14px' } }, monthPicker(redraw), h('span', { class: 'small faint' }, `Figures come from your ${x.expense_count + x.income_count} recorded transactions in ${x.currency}.`)),
    h('div', { class: 'grid grid-4' },
      stat('Income', money(x.income_minor), 'pos'),
      stat('Spending', money(x.expense_minor), '', ch == null ? 'No data for previous month' : `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch)}% vs previous month`),
      stat('Net', money(x.net_minor), x.net_minor < 0 ? 'neg' : 'pos'),
      stat('Recurring (est.)', money(d.recurring.monthly_minor), '', `Monthly estimate from bills & subscriptions · subscriptions ${money(d.recurring.subscriptions_monthly_minor)}`)),
    h('div', { class: 'grid grid-3', style: { 'margin-top': '16px' } },
      h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h3', 'Daily spending')), dailyChart(x, month)),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Where the money went')),
        x.by_category.length ? h('div', x.by_category.map((c) => h('div', { class: 'hbar' }, h('span', { class: 'truncate row tight' }, h('span', { class: 'swatch', style: { background: c.color || 'var(--accent)' } }), c.name), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(c.total / maxCat) * 100}%`, background: c.color || 'var(--accent)' } })), h('span', { class: 'small nowrap' }, `${money(c.total)} · ${c.share}%`)))) : emptyState('No expenses this month.')),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Budgets'), h('button', { class: 'btn sm ghost', onclick: () => { tab = 'budgets'; redraw(); } }, 'Manage')),
        d.budgets.length ? h('div', { class: 'stack' }, d.budgets.map(budgetRow)) : emptyState('No budgets set.')),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Top merchants')),
        x.top_merchants.length ? h('div', { class: 'list' }, x.top_merchants.map((m) => h('div', { class: 'list-item' }, h('span', { class: 'grow truncate' }, m.name || '—'), h('span', { class: 'small faint' }, `${m.n}×`), h('span', money(m.total))))) : emptyState('—')),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Upcoming bills'), h('span', { class: 'tiny faint' }, 'Scheduled, not yet spent')),
        d.upcoming_bills.length ? h('div', { class: 'list' }, d.upcoming_bills.slice(0, 6).map((b) => h('div', { class: 'list-item' }, h('span', { class: 'grow truncate' }, b.name), h('span', { class: `small ${b.days_until_due < 0 ? 'neg' : 'muted'}` }, b.days_until_due < 0 ? 'Overdue' : fmtRelDay(b.due_date)), h('span', money(b.amount_minor))))) : emptyState('No unpaid bills in the next 30 days.')),
      x.other_currencies.length ? h('section', { class: 'card span-3' }, h('h3', 'Other currencies (not converted)'), h('div', { class: 'list' }, x.other_currencies.map((o) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, `${o.currency} ${o.type}`), h('span', money(o.total, { currency: o.currency }))))), h('p', { class: 'small faint' }, 'JARVIS does not apply exchange rates; these are excluded from totals above.')) : null,
    ));
}

function budgetRow(b) {
  const cls = b.status === 'exceeded' ? 'danger' : b.status === 'at_risk' ? 'warning' : 'success';
  return h('div', { class: 'stack tight' },
    h('div', { class: 'row between small' }, h('span', { class: 'row tight' }, h('span', { class: 'swatch', style: { background: b.color } }), b.category), h('span', `${money(b.spent_minor)} / ${money(b.budget_minor)}`)),
    progressBar(b.percent_used, cls),
    h('div', { class: 'tiny faint' }, `${b.percent_used}% used${b.projected_minor != null ? ` · forecast ≈ ${money(b.projected_minor)} by month end (straight-line)` : ''}`));
}

function dailyChart(x, m) {
  const start = DateTime.fromISO(`${m}-01`);
  const days = start.daysInMonth;
  const map = Object.fromEntries(x.daily.map((d) => [d.date, d]));
  const vals = [];
  for (let i = 1; i <= days; i++) vals.push(map[start.set({ day: i }).toISODate()]?.expense || 0);
  const max = Math.max(1, ...vals);
  const W = 640;
  const H = 180;
  const pad = 24;
  const bw = (W - pad) / days;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 20}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Daily spending for ${start.toFormat('LLLL')}. Highest day ${money(max)}.`);
  const el = (tag, attrs, text) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };
  for (const f of [0.5, 1]) {
    el('line', { x1: pad, x2: W, y1: H - f * (H - 10), y2: H - f * (H - 10), class: 'grid-line' });
    el('text', { x: 0, y: H - f * (H - 10) + 4 }, money(max * f, { compact: true }));
  }
  vals.forEach((v, i) => {
    const bh = (v / max) * (H - 10);
    const r = el('rect', { x: pad + i * bw + 1, y: H - bh, width: Math.max(1, bw - 2), height: bh, rx: 2, class: 'bar expense' });
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = `${start.set({ day: i + 1 }).toFormat('d LLL')}: ${money(v)}`;
    r.append(t);
    if ((i + 1) % 5 === 1) el('text', { x: pad + i * bw, y: H + 14 }, String(i + 1));
  });
  return svg;
}

async function transactions(body, redraw) {
  const cats = await get('/finance/categories');
  const p = new URLSearchParams(Object.entries(txFilters).filter(([, v]) => v));
  if (txFilters.q) { p.delete('q'); p.set('q', txFilters.q); }
  const list = await get(`/finance/transactions?${p}`);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search description, merchant, notes…', value: txFilters.q, 'aria-label': 'Search transactions' });
  search.addEventListener('input', debounce(() => { txFilters.q = search.value; redraw(); }, 300));
  const sel = (name, opts) => {
    const s = select(name, opts, txFilters[name]);
    s.setAttribute('aria-label', name);
    s.addEventListener('change', () => { txFilters[name] = s.value; redraw(); });
    return s;
  };
  const dateIn = (name) => {
    const i = h('input', { class: 'input', type: 'date', value: txFilters[name], 'aria-label': name, style: { width: '160px' } });
    i.addEventListener('change', () => { txFilters[name] = i.value; redraw(); });
    return i;
  };
  const totalExp = list.filter((t) => t.type === 'expense' && t.currency === state.settings.currency).reduce((s, t) => s + t.amount_minor, 0);
  const totalInc = list.filter((t) => t.type === 'income' && t.currency === state.settings.currency).reduce((s, t) => s + t.amount_minor, 0);
  clear(body, h('div', { class: 'card' },
    h('div', { class: 'row', style: { 'margin-bottom': '12px' } }, h('div', { class: 'grow', style: { 'min-width': '200px' } }, search),
      sel('type', [['', 'All types'], ['expense', 'Expenses'], ['income', 'Income']]),
      sel('category_id', [['', 'All categories'], ...cats.map((c) => [c.id, `${c.name} (${c.kind})`])]), dateIn('from'), dateIn('to'),
      h('button', { class: 'btn ghost sm', onclick: () => { Object.assign(txFilters, { q: '', type: '', category_id: '', from: '', to: '' }); redraw(); } }, 'Reset')),
    h('div', { class: 'row small muted', style: { 'margin-bottom': '8px' } }, `${list.length} transactions · spent ${money(totalExp)} · received ${money(totalInc)}`),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Date'), h('th', 'Description'), h('th', 'Category'), h('th', 'Source'), h('th', { class: 'right' }, 'Amount'), h('th', ''))),
      h('tbody', list.map((t) => h('tr',
        h('td', { class: 'nowrap' }, fmtDate(t.date)),
        h('td', h('div', t.description || '—'), t.merchant ? h('div', { class: 'small faint' }, t.merchant) : null),
        h('td', t.category || h('span', { class: 'faint' }, 'Uncategorised')),
        h('td', h('span', { class: 'badge' }, t.source), ' ', demoBadge(t)),
        h('td', { class: `right nowrap ${t.type === 'income' ? 'pos' : ''}` }, `${t.type === 'income' ? '+' : '−'}${money(t.amount_minor, { currency: t.currency })}`),
        h('td', { class: 'right nowrap' }, h('button', { class: 'btn ghost sm icon', 'aria-label': 'Edit transaction', onclick: () => txDialog(t) }, icon('edit')),
          h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete transaction', onclick: async () => { if (await confirmDialog('Delete this transaction?', { danger: true, confirmLabel: 'Delete' })) { await del(`/finance/transactions/${t.id}`); emit('data'); } } }, icon('trash')))))))) : emptyState('No transactions match.', h('button', { class: 'btn primary', onclick: () => txDialog() }, 'Add a transaction'))));
}

async function txDialog(t = {}) {
  const cats = await get('/finance/categories');
  const typeSel = select('type', [['expense', 'Expense'], ['income', 'Income']], t.type || 'expense');
  const catSel = select('category', [], '');
  const fillCats = () => catSel.replaceChildren(h('option', { value: '' }, 'Uncategorised'), ...cats.filter((c) => c.kind === typeSel.value).map((c) => h('option', { value: c.id, selected: c.id === t.category_id }, c.name)));
  typeSel.addEventListener('change', fillCats);
  fillCats();
  const step = 1 / 10 ** currencyDigits();
  formModal({
    title: t.id ? 'Edit transaction' : 'New transaction', submitLabel: t.id ? 'Save' : 'Add',
    fields: [
      field('Type', typeSel),
      field(`Amount (${state.settings.currency})`, input('amount', { type: 'number', min: step, step, value: t.amount ?? '', required: true })),
      field('Date', input('date', { type: 'date', value: t.date || nowZ().toISODate(), required: true })),
      field('Category', catSel),
      field('Description', input('description', { value: t.description || '', maxlength: 500 })),
      field('Merchant / payer', input('merchant', { value: t.merchant || '', maxlength: 200 })),
      field('Notes', textarea('notes', t.notes || '', { rows: 2 }), { full: true }),
    ],
    onSubmit: async (fd) => {
      const body = { type: fd.get('type'), amount: Number(fd.get('amount')), date: fd.get('date'), category: fd.get('category') || null, description: fd.get('description'), merchant: fd.get('merchant'), notes: fd.get('notes') };
      if (!(body.amount > 0)) throw new Error('Enter an amount greater than zero.');
      if (t.id) await patch(`/finance/transactions/${t.id}`, body);
      else await post('/finance/transactions', body);
      toast(t.id ? 'Transaction saved' : 'Transaction recorded', { type: 'success' });
      emit('data');
    },
  });
}

async function budgets(body, redraw) {
  const [list, cats] = await Promise.all([get(`/finance/budgets?month=${month}`), get('/finance/categories')]);
  const expenseCats = cats.filter((c) => c.kind === 'expense');
  const catSel = select('category', expenseCats.map((c) => [c.id, c.name]), '');
  const amt = input('amount', { type: 'number', min: 1, step: 1, placeholder: 'Monthly limit' });
  clear(body,
    h('div', { class: 'row between', style: { 'margin-bottom': '14px' } }, monthPicker(redraw)),
    h('div', { class: 'grid grid-3' },
      h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h3', 'Budget progress')),
        list.length ? h('div', { class: 'stack' }, list.map((b) => h('div', { class: 'row' }, h('div', { class: 'grow' }, budgetRow(b)), demoBadge(b),
          h('button', { class: 'btn ghost sm icon', 'aria-label': `Remove ${b.category} budget`, onclick: async () => { await del(`/finance/budgets/${b.id}`); emit('data'); } }, icon('trash'))))) : emptyState('No budgets yet. Set a monthly limit for a category.')),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Set a monthly budget')),
        h('div', { class: 'stack' }, field('Category', catSel), field(`Limit (${state.settings.currency})`, amt),
          h('button', { class: 'btn primary', onclick: async () => { try { await put('/finance/budgets', { category: catSel.value, amount: Number(amt.value) }); toast('Budget saved', { type: 'success' }); emit('data'); } catch (e) { toastError(e); } } }, 'Save budget'),
          h('p', { class: 'small faint' }, 'Setting a budget for a category that already has one updates it.')),
        h('hr'), h('h3', 'Categories'), categoryManager(cats))));
}

function categoryManager(cats) {
  const name = input('name', { placeholder: 'New category', maxlength: 60 });
  const kind = select('kind', [['expense', 'Expense'], ['income', 'Income']], 'expense');
  const color = input('color', { type: 'color', value: '#3b82f6' });
  return h('div', { class: 'stack tight' },
    h('div', { class: 'list' }, cats.map((c) => h('div', { class: 'list-item' }, h('span', { class: 'swatch', style: { background: c.color } }), h('span', { class: 'grow' }, c.name), h('span', { class: 'small faint' }, c.kind),
      h('button', { class: 'btn ghost sm icon', 'aria-label': `Delete category ${c.name}`, onclick: async () => { if (await confirmDialog(`Delete "${c.name}"? Transactions in it become uncategorised.`, { danger: true, confirmLabel: 'Delete' })) { await del(`/finance/categories/${c.id}`); emit('data'); } } }, icon('trash'))))),
    h('div', { class: 'row tight' }, h('div', { class: 'grow' }, name), kind, h('div', { style: { width: '50px' } }, color)),
    h('button', { class: 'btn', onclick: async () => { try { await post('/finance/categories', { name: name.value, kind: kind.value, color: color.value }); emit('data'); } catch (e) { toastError(e); } } }, icon('plus'), 'Add category'));
}

async function bills(body) {
  const list = await get('/finance/bills');
  const today = nowZ().toISODate();
  clear(body, h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', 'Bills & subscriptions'), h('button', { class: 'btn primary sm', onclick: () => billDialog() }, icon('plus'), 'Add')),
    h('p', { class: 'small faint' }, 'Mark a bill as paid after you pay it yourself — JARVIS can then record the expense and roll recurring bills to the next due date. Reminders are sent before due dates (see Settings → Notifications).'),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', h('tr', h('th', 'Name'), h('th', 'Due'), h('th', 'Repeats'), h('th', 'Status'), h('th', { class: 'right' }, 'Amount'), h('th', ''))),
      h('tbody', list.map((b) => h('tr',
        h('td', h('div', b.name, ' ', demoBadge(b)), h('div', { class: 'small faint' }, [b.kind === 'subscription' ? 'Subscription' : 'Bill', b.category, b.autopay ? 'autopay' : null].filter(Boolean).join(' · '))),
        h('td', { class: `nowrap ${b.status === 'unpaid' && b.due_date < today ? 'neg' : ''}` }, fmtDate(b.due_date), h('div', { class: 'small faint' }, b.status === 'unpaid' ? fmtRelDay(b.due_date) : '')),
        h('td', b.recurrence),
        h('td', h('span', { class: `badge ${b.status === 'paid' ? 'success' : b.due_date < today ? 'danger' : 'warning'}` }, b.status === 'paid' ? 'Paid' : b.due_date < today ? 'Overdue' : 'Unpaid'), b.last_paid_on ? h('div', { class: 'tiny faint' }, `Last paid ${fmtDate(b.last_paid_on)}`) : null),
        h('td', { class: 'right nowrap' }, money(b.amount_minor)),
        h('td', { class: 'right nowrap' },
          b.status === 'unpaid' ? h('button', { class: 'btn sm', onclick: () => markPaid(b) }, 'Mark paid') : null,
          h('button', { class: 'btn ghost sm icon', 'aria-label': 'Edit bill', onclick: () => billDialog(b) }, icon('edit')),
          h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete bill', onclick: async () => { if (await confirmDialog(`Stop tracking "${b.name}"?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/finance/bills/${b.id}`); emit('data'); } } }, icon('trash')))))))) : emptyState('No bills tracked yet.')));
}

function markPaid(b) {
  formModal({
    title: `Mark “${b.name}” as paid`, submitLabel: 'Mark paid',
    fields: [field('Paid on', input('paid_on', { type: 'date', value: nowZ().toISODate() })), h('div', { class: 'full' }, checkbox('record', `Also record a ${money(b.amount_minor)} expense`, true)),
      h('p', { class: 'help full' }, b.recurrence !== 'none' ? `The next due date will move forward (${b.recurrence}).` : 'This one-off bill will be marked as paid.')],
    onSubmit: async (fd) => {
      await post(`/finance/bills/${b.id}/paid`, { paid_on: fd.get('paid_on'), record_transaction: !!fd.get('record') });
      toast('Bill marked as paid', { type: 'success' });
      emit('data');
    },
  });
}

async function billDialog(b = {}) {
  const cats = (await get('/finance/categories')).filter((c) => c.kind === 'expense');
  formModal({
    title: b.id ? 'Edit bill' : 'Track a bill or subscription', submitLabel: b.id ? 'Save' : 'Add',
    fields: [
      field('Name', input('name', { value: b.name || '', required: true, maxlength: 200, placeholder: 'Electricity, Netflix…' }), { full: true }),
      field('Type', select('kind', [['bill', 'Bill'], ['subscription', 'Subscription']], b.kind || 'bill')),
      field(`Amount (${state.settings.currency})`, input('amount', { type: 'number', min: 0.01, step: 0.01, value: b.amount ?? '', required: true })),
      field('Next due date', input('due_date', { type: 'date', value: b.due_date || nowZ().plus({ days: 7 }).toISODate(), required: true })),
      field('Repeats', select('recurrence', [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly'], ['weekly', 'Weekly'], ['none', 'One-off']], b.recurrence || 'monthly')),
      field('Category', select('category', [['', 'None'], ...cats.map((c) => [c.id, c.name])], b.category_id || '')),
      h('div', { class: 'field' }, h('span', ' '), checkbox('autopay', 'Paid automatically (autopay)', b.autopay)),
      field('Notes', textarea('notes', b.notes || '', { rows: 2 }), { full: true }),
    ],
    onSubmit: async (fd) => {
      const body = { name: fd.get('name'), kind: fd.get('kind'), amount: Number(fd.get('amount')), due_date: fd.get('due_date'), recurrence: fd.get('recurrence'), category: fd.get('category') || null, autopay: !!fd.get('autopay'), notes: fd.get('notes') };
      if (b.id) await patch(`/finance/bills/${b.id}`, body);
      else await post('/finance/bills', body);
      toast('Saved', { type: 'success' });
      emit('data');
    },
  });
}

async function goals(body) {
  const list = await get('/finance/goals');
  clear(body,
    h('div', { class: 'row between', style: { 'margin-bottom': '14px' } }, h('p', { class: 'muted' }, 'Track progress toward savings targets. Contributions are recorded manually.'), h('button', { class: 'btn primary', onclick: () => goalDialog() }, icon('plus'), 'New goal')),
    list.length ? h('div', { class: 'grid grid-3' }, list.map((g) => {
      const left = g.target_minor - g.saved_minor;
      const monthsLeft = g.deadline ? Math.max(1, Math.ceil(DateTime.fromISO(g.deadline).diff(nowZ(), 'months').months)) : null;
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', g.name), demoBadge(g)),
        h('div', { class: 'stat' }, h('span', { class: 'value' }, money(g.saved_minor)), h('span', { class: 'sub' }, `of ${money(g.target_minor)} · ${g.progress}%`)),
        progressBar(g.progress, g.progress >= 100 ? 'success' : ''),
        h('p', { class: 'small muted', style: { 'margin-top': '8px' } }, left > 0 ? `${money(left)} to go${monthsLeft ? ` · about ${money(Math.ceil(left / monthsLeft))}/month to reach it by ${fmtDate(g.deadline)}` : ''}` : 'Goal reached 🎉'),
        h('div', { class: 'row tight' },
          h('button', { class: 'btn sm', onclick: () => formModal({ title: `Add to “${g.name}”`, submitLabel: 'Add', fields: [field('Amount', input('amount', { type: 'number', min: 0.01, step: 0.01, required: true }), { full: true })], onSubmit: async (fd) => { await patch(`/finance/goals/${g.id}`, { contribute: Number(fd.get('amount')) }); emit('data'); } }) }, icon('plus'), 'Contribution'),
          h('button', { class: 'btn ghost sm icon', 'aria-label': 'Edit goal', onclick: () => goalDialog(g) }, icon('edit')),
          h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete goal', onclick: async () => { if (await confirmDialog(`Delete goal "${g.name}"?`, { danger: true, confirmLabel: 'Delete' })) { await del(`/finance/goals/${g.id}`); emit('data'); } } }, icon('trash'))));
    })) : emptyState('No savings goals yet.'));
}

function goalDialog(g = {}) {
  formModal({
    title: g.id ? 'Edit goal' : 'New savings goal', submitLabel: 'Save',
    fields: [field('Name', input('name', { value: g.name || '', required: true }), { full: true }), field('Target amount', input('target', { type: 'number', min: 1, step: 0.01, value: g.target ?? '', required: true })), field('Saved so far', input('saved', { type: 'number', min: 0, step: 0.01, value: g.saved ?? 0 })), field('Target date (optional)', input('deadline', { type: 'date', value: g.deadline || '' }))],
    onSubmit: async (fd) => {
      const body = { name: fd.get('name'), target: Number(fd.get('target')), saved: Number(fd.get('saved') || 0), deadline: fd.get('deadline') || null };
      if (g.id) await patch(`/finance/goals/${g.id}`, body);
      else await post('/finance/goals', body);
      emit('data');
    },
  });
}

let reportYear = null;
async function reports(body, redraw) {
  reportYear ||= nowZ().year;
  const y = await get(`/finance/year/${reportYear}`);
  const max = Math.max(1, ...y.months.flatMap((m) => [m.income_minor, m.expense_minor]));
  const W = 720;
  const H = 220;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 24}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Income and spending by month in ${reportYear}`);
  const add = (tag, attrs, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.append(n); return n; };
  const slot = W / 12;
  y.months.forEach((m, i) => {
    const ih = (m.income_minor / max) * (H - 10);
    const eh = (m.expense_minor / max) * (H - 10);
    const a = add('rect', { x: i * slot + 8, y: H - ih, width: slot / 2 - 10, height: ih, rx: 3, class: 'bar income' });
    a.append(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'), { textContent: `${m.month} income ${money(m.income_minor)}` }));
    const b = add('rect', { x: i * slot + slot / 2, y: H - eh, width: slot / 2 - 10, height: eh, rx: 3, class: 'bar expense' });
    b.append(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'), { textContent: `${m.month} spending ${money(m.expense_minor)}` }));
    add('text', { x: i * slot + slot / 2 - 10, y: H + 16 }, DateTime.fromISO(`${m.month}-01`).toFormat('LLL'));
  });
  const months = y.months.filter((m) => m.expense_minor || m.income_minor);
  clear(body,
    h('div', { class: 'row', style: { 'margin-bottom': '14px' } },
      h('button', { class: 'btn icon sm', 'aria-label': 'Previous year', onclick: () => { reportYear -= 1; redraw(); } }, icon('chevronLeft')), h('strong', String(reportYear)),
      h('button', { class: 'btn icon sm', 'aria-label': 'Next year', onclick: () => { reportYear += 1; redraw(); } }, icon('chevronRight')),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => exportCsv(`${reportYear}-01-01`, `${reportYear}-12-31`) }, icon('download'), `Export ${reportYear} CSV`)),
    h('div', { class: 'grid grid-3' }, stat('Income', money(y.totals.income_minor), 'pos'), stat('Spending', money(y.totals.expense_minor)), stat('Net', money(y.totals.net_minor), y.totals.net_minor < 0 ? 'neg' : 'pos', months.length ? `Average monthly spend ${money(Math.round(y.totals.expense_minor / months.length))} over ${months.length} months with data` : null)),
    h('div', { class: 'grid grid-3', style: { 'margin-top': '16px' } },
      h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h3', 'Monthly income vs spending'), h('div', { class: 'legend' }, h('span', h('span', { class: 'swatch', style: { background: 'var(--success)' } }), 'Income'), h('span', h('span', { class: 'swatch', style: { background: 'var(--accent)' } }), 'Spending'))), svg),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Spending by category')), y.by_category.length ? h('div', { class: 'list' }, y.by_category.map((c) => h('div', { class: 'list-item' }, h('span', { class: 'swatch', style: { background: c.color || 'var(--accent)' } }), h('span', { class: 'grow' }, c.name), h('span', { class: 'small faint' }, `${c.share}%`), h('span', money(c.total))))) : emptyState('No data.')),
      h('section', { class: 'card span-3' }, h('h3', 'Compare two periods'), compareTool())));
}

function compareTool() {
  const n = nowZ();
  const aF = input('a_from', { type: 'date', value: n.startOf('month').toISODate() });
  const aT = input('a_to', { type: 'date', value: n.toISODate() });
  const bF = input('b_from', { type: 'date', value: n.minus({ months: 1 }).startOf('month').toISODate() });
  const bT = input('b_to', { type: 'date', value: n.minus({ months: 1 }).endOf('month').toISODate() });
  const out = h('div', { style: { 'margin-top': '12px' } });
  const run = async () => {
    try {
      const r = await get(`/finance/compare?${new URLSearchParams({ a_from: aF.value, a_to: aT.value, b_from: bF.value, b_to: bT.value })}`);
      clear(out, h('p', `Period A spent ${money(r.period_a.expense_minor)} vs period B ${money(r.period_b.expense_minor)}${r.expense_change_pct != null ? ` (${r.expense_change_pct > 0 ? '+' : ''}${r.expense_change_pct}%)` : ''}.`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', h('tr', h('th', 'Category'), h('th', { class: 'right' }, 'A'), h('th', { class: 'right' }, 'B'), h('th', { class: 'right' }, 'Change'))),
          h('tbody', r.by_category.map((c) => h('tr', h('td', c.name), h('td', { class: 'right' }, money(c.a)), h('td', { class: 'right' }, money(c.b)), h('td', { class: `right ${c.diff > 0 ? 'neg' : c.diff < 0 ? 'pos' : ''}` }, `${money(c.diff, { sign: true })}${c.change_pct != null ? ` (${c.change_pct}%)` : ''}`)))))));
    } catch (e) { toastError(e); }
  };
  return h('div', h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'A'), aF, aT, h('span', { class: 'small muted' }, 'vs B'), bF, bT, h('button', { class: 'btn', onclick: run }, 'Compare')), out);
}

async function exportCsv(from, to) {
  try {
    const res = await api(`/finance/export.csv?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`, { raw: true });
    if (!res.ok) throw new Error('Export failed');
    downloadBlob(`jarvis-transactions${from ? `-${from}` : ''}.csv`, await res.blob());
  } catch (e) { toastError(e); }
}

async function importView(body) {
  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv', class: 'input', 'aria-label': 'CSV file' });
  const order = select('date_order', [['dmy', 'Dates are day-first (31/12/2026)'], ['mdy', 'Dates are month-first (12/31/2026)']], 'dmy');
  const out = h('div', { style: { 'margin-top': '14px' } });
  let preview = null;
  let text = '';
  const run = async (mapping) => {
    if (!fileIn.files[0] && !text) return toast('Choose a CSV file first.');
    if (fileIn.files[0]) text = await fileIn.files[0].text();
    try {
      const qs = new URLSearchParams({ date_order: order.value, ...(mapping ? { mapping: JSON.stringify(mapping) } : {}) });
      preview = await api(`/finance/import/preview?${qs}`, { method: 'POST', body: text, headers: { 'content-type': 'text/csv' } });
      drawPreview();
    } catch (e) {
      const header = e.body?.details?.header;
      clear(out, h('div', { class: 'banner warn' }, icon('alert'), e.message), header ? mappingForm(header, run) : null);
    }
  };
  const drawPreview = () => {
    const p = preview;
    const rows = p.rows;
    const importBtn = h('button', { class: 'btn primary' }, `Import ${rows.filter((r) => r.include).length} transactions`);
    const updateCount = () => { importBtn.textContent = `Import ${rows.filter((r) => r.include).length} transactions`; };
    importBtn.addEventListener('click', async () => {
      const sel = rows.filter((r) => r.include);
      if (!sel.length) return toast('Nothing selected.');
      importBtn.disabled = true;
      try {
        const r = await post('/finance/import/commit', { rows: sel.map(({ date, type, amount, description, category, merchant }) => ({ date, type, amount, description, category, merchant })), allow_duplicates: sel.some((x) => x.duplicate) });
        toast(`Imported ${r.imported} transactions${r.skipped_duplicates ? `, skipped ${r.skipped_duplicates} duplicates` : ''}.`, { type: 'success' });
        clear(out);
        text = '';
        fileIn.value = '';
        emit('data');
      } catch (e) { toastError(e); importBtn.disabled = false; }
    });
    clear(out,
      h('div', { class: 'row small' }, h('span', { class: 'badge' }, `${p.summary.total} rows`), h('span', { class: 'badge success' }, `${p.summary.valid} valid`), h('span', { class: 'badge warning' }, `${p.summary.duplicates} possible duplicates`), h('span', { class: 'badge danger' }, `${p.summary.invalid} with errors`), h('span', { class: 'faint' }, `Detected columns: ${Object.entries(p.mapping).map(([k, v]) => `${k} → "${p.header[v]}"`).join(', ')}`)),
      h('div', { class: 'table-wrap', style: { 'max-height': '420px', 'overflow-y': 'auto', 'margin-top': '10px' } }, h('table', { class: 'table' },
        h('thead', h('tr', h('th', 'Import'), h('th', 'Row'), h('th', 'Date'), h('th', 'Description'), h('th', 'Type'), h('th', { class: 'right' }, 'Amount'), h('th', 'Category'), h('th', 'Notes'))),
        h('tbody', rows.map((r) => h('tr',
          h('td', h('input', { type: 'checkbox', checked: r.include, disabled: r.errors.length > 0, 'aria-label': `Import row ${r.row}`, onchange: (e) => { r.include = e.target.checked; updateCount(); } })),
          h('td', { class: 'faint' }, r.row), h('td', { class: 'nowrap' }, r.date || '—'), h('td', r.description), h('td', r.type || '—'),
          h('td', { class: 'right' }, r.amount != null ? money(Math.round(r.amount * 10 ** currencyDigits())) : '—'),
          h('td', h('input', { class: 'input', style: { height: '30px', width: '140px' }, value: r.category, placeholder: 'Uncategorised', 'aria-label': `Category for row ${r.row}`, oninput: (e) => { r.category = e.target.value; } })),
          h('td', r.errors.length ? h('span', { class: 'error-text' }, r.errors.join('; ')) : r.duplicate ? h('span', { class: 'badge warning' }, `Duplicate: ${r.duplicate}`) : h('span', { class: 'badge success' }, 'OK'))))))),
      h('div', { class: 'row', style: { 'margin-top': '12px' } }, importBtn, h('span', { class: 'small faint' }, 'Duplicates are unticked by default. New category names are created automatically.')));
  };
  clear(body, h('div', { class: 'grid grid-3' },
    h('section', { class: 'card span-2' }, h('div', { class: 'card-head' }, h('h3', icon('upload', 'icon'), 'Import transactions from CSV')),
      h('p', { class: 'small muted' }, 'Export a statement as CSV from your bank or card provider. JARVIS detects date, description and amount (or debit/credit) columns, validates every row and flags duplicates before anything is saved.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, fileIn), order, h('button', { class: 'btn primary', onclick: () => run() }, 'Preview')), out),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', icon('download', 'icon'), 'Export')),
      h('div', { class: 'stack' }, h('button', { class: 'btn', onclick: () => exportCsv() }, 'All transactions (CSV)'),
        h('button', { class: 'btn', onclick: () => { const m = DateTime.fromISO(`${month}-01`); exportCsv(m.toISODate(), m.endOf('month').toISODate()); } }, `${DateTime.fromISO(`${month}-01`).toFormat('LLLL yyyy')} (CSV)`),
        h('a', { class: 'btn', href: '#/settings?section=data' }, 'Full data export (JSON)')),
      h('hr'), h('h3', 'Bank connections'), h('p', { class: 'small muted' }, 'No bank-data provider is connected in this build. JARVIS will never ask for your online-banking password. Manual entry and CSV import work fully without one.'))));
}

function mappingForm(header, run) {
  const opts = [['', '—'], ...header.map((hd, i) => [String(i), hd || `Column ${i + 1}`])];
  const sels = Object.fromEntries(['date', 'description', 'amount', 'debit', 'credit', 'category'].map((k) => [k, select(k, opts, '')]));
  return h('div', { class: 'card', style: { 'margin-top': '10px' } }, h('h3', 'Map columns'),
    h('div', { class: 'form-grid' }, Object.entries(sels).map(([k, s]) => field(k[0].toUpperCase() + k.slice(1), s))),
    h('p', { class: 'help' }, 'Choose either a single signed Amount column, or Debit and Credit columns.'),
    h('button', { class: 'btn primary', onclick: () => run(Object.fromEntries(Object.entries(sels).filter(([, s]) => s.value !== '').map(([k, s]) => [k, Number(s.value)]))) }, 'Preview with this mapping'));
}
