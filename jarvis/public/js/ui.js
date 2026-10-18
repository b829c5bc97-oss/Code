import { DateTime } from '/vendor/luxon.js';
import { state } from './state.js';

export { DateTime };

/** Tiny DOM builder. Never uses innerHTML for user content. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'selected', 'disabled', 'indeterminate'].includes(k)) el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

// ---------- icons (stroke icons, 24px grid) ----------
const ICONS = {
  overview: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  assistant: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1',
  calendar: 'M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  schedule: 'M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  finance: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  reminders: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  notes: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  integrations: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M18.89 13.23A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  stop: 'M6 6h12v12H6z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  menu: 'M3 12h18M3 6h18M3 18h18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  sparkle: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z',
  alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  play: 'M5 3l14 9-14 9z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  volume: 'M11 5L6 9H2v6h4l5 4zM15.54 8.46a5 5 0 0 1 0 7.07',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  wallet: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(path);
  return svg;
}

// ---------- formatting ----------
export const zone = () => state.settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const dt = (iso) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone());
export const nowZ = () => DateTime.now().setZone(zone());
export const todayIso = () => nowZ().toISODate();
const timeFmt = () => (state.settings?.timeFormat === '24h' ? 'HH:mm' : 'h:mm a');
export const fmtTime = (iso) => dt(iso).toFormat(timeFmt());
export const fmtDate = (iso) => (iso.length === 10 ? DateTime.fromISO(iso, { zone: zone() }) : dt(iso)).toFormat(state.settings?.dateFormat || 'dd LLL yyyy');
export const fmtDateTime = (iso) => `${fmtDate(iso)}, ${fmtTime(iso)}`;
export function fmtRelDay(iso) {
  const d = iso.length === 10 ? DateTime.fromISO(iso, { zone: zone() }) : dt(iso);
  const days = Math.round(d.startOf('day').diff(nowZ().startOf('day'), 'days').days);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toFormat('cccc');
  return d.toFormat('ccc d LLL');
}
/** Local "YYYY-MM-DDTHH:mm" for <input type=datetime-local> in the user's zone. */
export const toLocalInput = (iso) => (iso ? dt(iso).toFormat("yyyy-MM-dd'T'HH:mm") : '');
export const fromLocalInput = (v) => (v ? DateTime.fromISO(v, { zone: zone() }).toUTC().toISO({ suppressMilliseconds: true }) : null);
export const dueDateInput = (iso) => (iso ? dt(iso).toISODate() : '');

export function money(minor, { currency, sign = false, compact = false } = {}) {
  const cur = currency || state.settings?.currency || 'INR';
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits;
  const major = minor / 10 ** digits;
  const out = new Intl.NumberFormat(state.settings?.locale || 'en-IN', { style: 'currency', currency: cur, notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : digits }).format(Math.abs(major));
  return `${sign && minor > 0 ? '+' : minor < 0 ? '−' : ''}${out}`;
}
export const currencyDigits = () => new Intl.NumberFormat('en', { style: 'currency', currency: state.settings?.currency || 'INR' }).resolvedOptions().maximumFractionDigits;

export function durationLabel(mins) {
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${hrs}h ${m}m` : `${hrs}h`;
}

// ---------- safe mini-markdown (escape first, then add our own tags) ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
export function markdown(text) {
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/)) || (m = line.match(/^\s*→\s+(.*)/))) {
      if (list?.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; }
      list.items.push(inline(m[1]));
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list?.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; }
      list.items.push(inline(m[1]));
    } else if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      flush();
      out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
    } else if (!line.trim()) {
      flush();
    } else {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  const div = h('div', { class: 'md' });
  div.innerHTML = out.join('');
  return div;
}

// ---------- toasts ----------
export function toast(message, { type = 'info', title, timeout = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, title ? h('strong', title) : null, message);
  box.append(t);
  setTimeout(() => t.remove(), timeout);
}
export const toastError = (e) => toast(e?.message || String(e), { type: 'error', title: 'Something went wrong' });

// ---------- dialogs ----------
export function openModal({ title, body, actions = [], wide = false, onClose }) {
  const dialog = h('dialog', { class: ['modal', wide && 'wide'], 'aria-labelledby': 'modal-title' });
  const close = () => {
    dialog.close();
  };
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  const foot = h('div', { class: 'modal-foot' });
  for (const a of actions) {
    const btn = h('button', { type: a.submit ? 'submit' : 'button', class: ['btn', a.primary && 'primary', a.danger && 'danger', a.left && 'left', a.ghost && 'ghost'] }, a.label);
    btn.addEventListener('click', async (e) => {
      if (a.submit) return; // handled by the form submit listener
      e.preventDefault();
      if (!a.onClick) return close();
      btn.disabled = true;
      try {
        const keep = await a.onClick({ close, dialog, button: btn });
        if (keep !== false) close();
      } catch (err) {
        toastError(err);
      } finally {
        btn.disabled = false;
      }
    });
    foot.append(btn);
  }
  dialog.append(
    h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title' }, title), h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null,
  );
  document.body.append(dialog);
  dialog.showModal();
  const first = dialog.querySelector('.modal-body input, .modal-body select, .modal-body textarea, .modal-body button');
  first?.focus();
  return { dialog, close };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: typeof message === 'string' ? h('p', message) : message,
      actions: [
        { label: 'Cancel', ghost: true },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Build a form inside a modal; `onSubmit(values)` may throw to keep it open. */
export function formModal({ title, fields, submitLabel = 'Save', onSubmit, extraActions = [], wide = false }) {
  const form = h('form', { class: 'form-grid', novalidate: true });
  for (const f of fields) form.append(f);
  const errorBox = h('p', { class: 'error-text full', role: 'alert', hidden: true });
  form.append(errorBox);
  const submitBtn = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
  const m = openModal({ title, body: form, wide, actions: [...extraActions, { label: 'Cancel', ghost: true }] });
  m.dialog.querySelector('.modal-foot').append(submitBtn);
  submitBtn.setAttribute('form', 'jarvis-modal-form');
  form.id = 'jarvis-modal-form';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    submitBtn.disabled = true;
    try {
      const keep = await onSubmit(new FormData(form), form);
      if (keep !== false) m.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
  return m;
}

export function field(label, control, { help, full = false, id } = {}) {
  const fid = id || control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = fid;
  return h('label', { class: ['field', full && 'full'], for: fid }, label, control, help ? h('span', { class: 'help' }, help) : null);
}

export function input(name, { type = 'text', value = '', required, placeholder, min, max, step, maxlength, autocomplete } = {}) {
  return h('input', { class: 'input', name, type, value: value ?? '', required, placeholder, min, max, step, maxlength, autocomplete });
}
export function select(name, options, value) {
  return h('select', { class: 'input', name }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}
export function textarea(name, value = '', { rows = 4, placeholder, maxlength } = {}) {
  const t = h('textarea', { class: 'input', name, rows, placeholder, maxlength });
  t.value = value ?? '';
  return t;
}
export function checkbox(name, label, checked) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: !!checked }), label);
}

export function emptyState(text, action) {
  return h('div', { class: 'empty' }, h('div', text), action || null);
}

export function badgeForPriority(p) {
  return h('span', { class: 'row tight small muted' }, h('span', { class: `prio ${p}`, 'aria-hidden': 'true' }), p);
}

export function demoBadge(item) {
  return item?.is_demo ? h('span', { class: 'badge demo', title: 'Sample data from demo mode' }, 'Demo') : null;
}

export function progressBar(pct, cls = '') {
  return h('div', { class: ['progress', cls], role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: `${Math.min(100, Math.max(0, pct))}%` } }));
}

export function tabs(items, active, onChange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  for (const [key, label] of items) {
    bar.append(h('button', { role: 'tab', 'aria-selected': String(key === active), onclick: () => onChange(key) }, label));
  }
  return bar;
}

export function loading() {
  return h('div', { class: 'stack' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
}

/** Debounce helper for search inputs. */
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
