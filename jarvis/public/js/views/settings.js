import { h, icon, clear, toast, toastError, confirmDialog, field, input, select, checkbox, emptyState, fmtDateTime, downloadBlob, formModal } from '../ui.js';
import { get, post, patch, del, api } from '../api.js';
import { state, emit } from '../state.js';
import { listVoices, voiceSupport, speak } from '../voice.js';

const SECTIONS = [['general', 'General'], ['schedule', 'Schedule'], ['notifications', 'Notifications'], ['assistant', 'Assistant'], ['privacy', 'Privacy & permissions'], ['data', 'Data'], ['account', 'Account']];

export async function render(el, { query }) {
  let section = query.get('section') || 'general';
  const nav = h('nav', { class: 'stack tight', 'aria-label': 'Settings sections' });
  const body = h('div', { class: 'stack' });
  clear(el, h('div', { class: 'page-head' }, h('div', h('h1', 'Settings'), h('p', 'Personalise JARVIS. Everything here is saved to your account.'))),
    h('div', { class: 'grid', style: { 'grid-template-columns': 'minmax(160px, 220px) minmax(0, 1fr)' } }, h('div', { class: 'card' }, nav), body));
  const draw = async () => {
    clear(nav, SECTIONS.map(([k, l]) => h('button', { class: ['btn', 'ghost', k === section && 'primary'], style: { 'justify-content': 'flex-start' }, 'aria-current': k === section ? 'page' : null, onclick: () => { section = k; draw(); } }, l)));
    try {
      await ({ general, schedule, notifications, assistant, privacy, data, account })[section](body, draw);
    } catch (e) { clear(body, emptyState(e.message)); }
  };
  if (matchMedia('(max-width: 900px)').matches) el.querySelector('.grid').style.gridTemplateColumns = '1fr';
  await draw();
}

async function save(patchBody, msg = 'Settings saved') {
  try {
    state.settings = await patch('/settings', patchBody);
    emit('settings');
    toast(msg, { type: 'success' });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

function section(title, ...children) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', title)), ...children);
}

function general(body) {
  const s = state.settings;
  const tzs = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  const tz = select('timezone', tzs.map((z) => [z, z]), s.timezone);
  const name = input('name', { value: s.profile.displayName || state.user.name, maxlength: 80 });
  const curr = select('currency', ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CNY', 'CHF', 'ZAR', 'NZD', 'SAR', 'BDT', 'LKR', 'NPR', 'PKR'].map((c) => [c, c]), s.currency);
  const locale = select('locale', [['en-IN', 'English (India)'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'हिन्दी (India)'], ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español']], s.locale);
  const dateFmt = select('dateFormat', [['dd LLL yyyy', '18 Oct 2026'], ['LLL dd, yyyy', 'Oct 18, 2026'], ['yyyy-MM-dd', '2026-10-18'], ['dd/MM/yyyy', '18/10/2026'], ['MM/dd/yyyy', '10/18/2026']], s.dateFormat);
  const timeFmt = select('timeFormat', [['12h', '12-hour (3:00 PM)'], ['24h', '24-hour (15:00)']], s.timeFormat);
  const week = select('weekStart', [['1', 'Monday'], ['0', 'Sunday']], String(s.weekStart));
  const theme = select('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']], s.theme);
  clear(body,
    section('Profile & region',
      h('div', { class: 'form-grid' }, field('Display name', name), field('Time zone', tz, { help: `Browser time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}` }), field('Currency', curr, { help: 'Used for new transactions and all summaries. Existing records keep their currency.' }), field('Language & number format', locale), field('Date format', dateFmt), field('Time format', timeFmt), field('Week starts on', week), field('Theme', theme)),
      h('div', { class: 'row', style: { 'margin-top': '14px' } }, h('button', { class: 'btn primary', onclick: async () => {
        if (name.value.trim() && name.value.trim() !== state.user.name) await patch('/profile', { name: name.value.trim() }).then(() => { state.user.name = name.value.trim(); }).catch(toastError);
        await save({ timezone: tz.value, currency: curr.value, locale: locale.value, dateFormat: dateFmt.value, timeFormat: timeFmt.value, weekStart: Number(week.value), theme: theme.value });
      } }, 'Save'))));
}

function schedule(body) {
  const s = state.settings;
  const ds = s.dailySchedule;
  const wake = input('wake', { type: 'time', value: ds.wake });
  const sleep = input('sleep', { type: 'time', value: ds.sleep });
  const ws = input('ws', { type: 'time', value: s.workingHours.start });
  const we = input('we', { type: 'time', value: s.workingHours.end });
  const days = h('div', { class: 'row tight' }, [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']].map(([d, l]) => h('label', { class: 'check small' }, h('input', { type: 'checkbox', value: d, checked: s.workingHours.days.includes(d) }), l)));
  clear(body, section('Working hours & daily routine',
    h('div', { class: 'form-grid' }, field('Workday starts', ws), field('Workday ends', we), field('Working days', days, { full: true }), field('Usually wake up', wake, { help: 'Personal planning on non-working days uses waking hours.' }), field('Usually go to sleep', sleep)),
    h('p', { class: 'small faint' }, 'Focus periods, lunch and meeting buffers are on the Work Schedule page.'),
    h('div', { class: 'row', style: { 'margin-top': '10px' } }, h('button', { class: 'btn primary', onclick: () => save({ workingHours: { start: ws.value, end: we.value, days: [...days.querySelectorAll('input:checked')].map((x) => Number(x.value)) }, dailySchedule: { wake: wake.value, sleep: sleep.value } }) }, 'Save'), h('a', { class: 'btn', href: '#/schedule' }, 'Work Schedule'))));
}

function notifications(body) {
  const n = state.settings.notifications;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const inApp = checkbox('inApp', 'In-app notifications (bell and notification centre)', n.inApp);
  const browser = checkbox('browser', 'Browser pop-ups while a JARVIS tab is open', n.browser);
  const lead = input('lead', { type: 'number', min: 0, max: 1440, value: n.eventLeadMinutes });
  const billLead = input('billLead', { type: 'number', min: 0, max: 30, value: n.billLeadDays });
  const brief = checkbox('brief', 'Daily briefing notification', n.dailyBriefing);
  const briefAt = input('briefAt', { type: 'time', value: n.dailyBriefingTime });
  const overdue = checkbox('overdue', 'Overdue-task digest (with the morning briefing)', n.overdueDigest);
  clear(body, section('Notifications',
    h('div', { class: 'stack' }, inApp, browser,
      h('p', { class: 'small faint' }, perm === 'unsupported' ? 'This browser does not support notifications.' : perm === 'denied' ? 'Browser notifications are blocked for this site in your browser settings.' : perm === 'granted' ? 'Browser permission granted.' : 'Your browser will ask for permission when you enable pop-ups.'),
      h('div', { class: 'form-grid' }, field('Remind me before events (minutes)', lead), field('Warn about bills (days before due)', billLead), field('Briefing time', briefAt)), brief, overdue,
      h('div', { class: 'banner info' }, icon('info'), 'Delivery: reminders are generated by the JARVIS server scheduler and stored as in-app notifications, so they are waiting for you even if no tab was open. Email, SMS and mobile push are not configured in this build, so JARVIS will not send them.'),
      h('div', h('button', { class: 'btn primary', onclick: async () => {
        let wantBrowser = browser.querySelector('input').checked;
        if (wantBrowser && perm === 'default') wantBrowser = (await Notification.requestPermission()) === 'granted';
        if (wantBrowser && perm === 'denied') { wantBrowser = false; toast('Your browser blocks notifications for this site.', { type: 'error' }); }
        save({ notifications: { inApp: inApp.querySelector('input').checked, browser: wantBrowser, eventLeadMinutes: Number(lead.value), billLeadDays: Number(billLead.value), dailyBriefing: brief.querySelector('input').checked, dailyBriefingTime: briefAt.value, overdueDigest: overdue.querySelector('input').checked } });
      } }, 'Save')))));
}

async function assistant(body, redraw) {
  const a = state.settings.assistant;
  const ai = await get('/assistant/status');
  const verbosity = select('verbosity', [['concise', 'Concise'], ['balanced', 'Balanced'], ['detailed', 'Detailed']], a.verbosity);
  const voiceReplies = checkbox('voiceReplies', 'Speak replies aloud (voice requests are always answered aloud)', a.voiceReplies);
  const voices = listVoices();
  const voiceSel = select('voice', [['', 'Browser default'], ...voices.map((v) => [v.name, `${v.name} (${v.lang})`])], a.voiceName);
  const rate = input('rate', { type: 'range', min: 0.5, max: 2, step: 0.1, value: a.speechRate });
  const memories = await get('/memories');
  const useMemory = checkbox('useMemory', 'Let JARVIS remember preferences you explicitly ask it to remember', a.useMemory);
  const newMem = input('mem', { placeholder: 'e.g. I prefer meetings after 11am', maxlength: 500 });
  clear(body,
    section('AI provider',
      h('p', ai.configured ? `Connected: ${ai.label}.` : h('span', { class: 'warning' }, `${ai.label}. ${ai.hint}`)),
      h('p', { class: 'small faint' }, 'Provider and API keys are configured on the server (environment variables) — never in the browser. See Integrations for the exact variables.')),
    section('Replies & voice',
      h('div', { class: 'form-grid' }, field('Reply length', verbosity), field('Voice', voiceSel, { help: voiceSupport.synthesis ? 'Voices come from your browser/OS.' : 'Speech output is not supported in this browser.' }), field('Speech rate', rate), h('div', { class: 'field' }, h('span', ' '), h('button', { class: 'btn sm', onclick: () => { state.settings.assistant.voiceName = voiceSel.value; state.settings.assistant.speechRate = Number(rate.value); speak('Hello, I am JARVIS. This is how I sound.'); } }, icon('volume'), 'Test voice'))),
      voiceReplies,
      h('p', { class: 'small faint' }, `Voice input: ${voiceSupport.recognition ? 'supported in this browser (push-to-talk via the microphone button)' : 'not supported in this browser — typing always works'}. JARVIS does not listen in the background and has no wake word.`),
      h('div', h('button', { class: 'btn primary', onclick: () => save({ assistant: { verbosity: verbosity.value, voiceReplies: voiceReplies.querySelector('input').checked, voiceName: voiceSel.value, speechRate: Number(rate.value) } }) }, 'Save'))),
    section('Memory',
      useMemory,
      h('p', { class: 'small faint' }, 'Memories are shown to the AI with every request. You can delete them at any time.'),
      memories.length ? h('div', { class: 'list' }, memories.map((m) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, m.content), h('span', { class: 'badge' }, m.source), h('button', { class: 'btn ghost sm icon', 'aria-label': 'Delete memory', onclick: async () => { await del(`/memories/${m.id}`); redraw(); } }, icon('trash'))))) : h('p', { class: 'small faint' }, 'No memories saved.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, newMem), h('button', { class: 'btn', onclick: async () => { if (!newMem.value.trim()) return; try { await post('/memories', { content: newMem.value.trim() }); redraw(); } catch (e) { toastError(e); } } }, 'Add')),
      h('div', h('button', { class: 'btn', onclick: () => save({ assistant: { useMemory: useMemory.querySelector('input').checked } }) }, 'Save memory setting'))));
}

function privacy(body) {
  const a = state.settings.assistant;
  const domains = [['calendar', 'Calendar & scheduling'], ['tasks', 'Tasks & projects'], ['finance', 'Finance records'], ['reminders', 'Reminders'], ['notes', 'Notes']];
  const sels = Object.fromEntries(domains.map(([k]) => [k, select(k, [['write', 'Read & change'], ['confirm', 'Read; ask before changing'], ['read', 'Read only']], a.permissions[k])]));
  const email = select('email', [['confirm', 'Read & prepare drafts (you always send)'], ['read', 'Read only']], a.permissions.email);
  const confirmAll = checkbox('confirmAll', 'Ask me before every change the assistant makes', a.confirmAllChanges);
  clear(body,
    section('Assistant permissions',
      h('p', { class: 'small muted' }, 'These are enforced on the server before any assistant action runs. Deletions, bulk scheduling and project plans always need your approval. Sending email is never done by the assistant.'),
      h('div', { class: 'form-grid' }, domains.map(([k, l]) => field(l, sels[k])), field('Email', email)),
      confirmAll,
      h('div', { style: { 'margin-top': '12px' } }, h('button', { class: 'btn primary', onclick: () => save({ assistant: { confirmAllChanges: confirmAll.querySelector('input').checked, permissions: { ...Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value])), email: email.value } } }) }, 'Save permissions'))),
    section('How your data is handled',
      h('ul', { class: 'small muted' },
        h('li', 'Your records are stored in this server\'s database and isolated to your account.'),
        h('li', 'When an AI provider is configured, the text of your requests and the data the assistant looks up are sent to that provider to generate replies.'),
        h('li', 'OAuth tokens for connected accounts are encrypted at rest. Disconnecting deletes them.'),
        h('li', 'JARVIS never asks for banking passwords and never initiates payments or transfers.'))));
}

async function data(body) {
  const [demo, activity] = await Promise.all([get('/demo'), get('/activity')]);
  clear(body,
    section('Export',
      h('p', { class: 'small muted' }, 'Download everything JARVIS stores for your account as JSON.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const r = await api('/export', { raw: true }); downloadBlob(`jarvis-export-${new Date().toISOString().slice(0, 10)}.json`, await r.blob()); } }, icon('download'), 'Export all data (JSON)'), h('a', { class: 'btn', href: '#/finance?tab=import' }, 'Transactions CSV'))),
    section('Demo data',
      h('p', { class: 'small muted' }, demo.demoMode ? `Demo mode is on: ${Object.entries(demo.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}. Demo items are labelled “Demo”.` : 'Load clearly labelled sample data to explore JARVIS. Your own records are not touched.'),
      h('div', { class: 'row' }, demo.demoMode ? h('button', { class: 'btn danger', onclick: async () => { await post('/demo/clear'); state.settings.demoMode = false; toast('Demo data removed', { type: 'success' }); emit('data'); data(body); } }, 'Remove demo data') : h('button', { class: 'btn', onclick: async () => { await post('/demo/load'); state.settings.demoMode = true; toast('Demo data loaded', { type: 'success' }); emit('data'); data(body); } }, 'Load demo data'))),
    section('Clear data',
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => clearScope('assistant_history', 'Delete all assistant conversations?') }, 'Clear assistant history'),
        h('button', { class: 'btn', onclick: () => clearScope('notifications', 'Delete all notifications?') }, 'Clear notifications'),
        h('button', { class: 'btn danger', onclick: () => clearScope('all_content', 'Delete ALL your events, tasks, projects, finances, reminders, notes, memories and conversations? Your account and settings remain. This cannot be undone.') }, 'Delete all content'))),
    section('Recent activity',
      h('p', { class: 'small faint' }, 'An audit trail of changes, including those made by the assistant.'),
      activity.length ? h('div', { class: 'table-wrap', style: { 'max-height': '360px', 'overflow-y': 'auto' } }, h('table', { class: 'table' }, h('thead', h('tr', h('th', 'When'), h('th', 'Who'), h('th', 'Action'), h('th', 'Details'))),
        h('tbody', activity.map((a) => h('tr', h('td', { class: 'nowrap small' }, fmtDateTime(a.created_at)), h('td', h('span', { class: `badge ${a.actor === 'assistant' ? 'accent' : ''}` }, a.actor)), h('td', `${a.action} ${a.entity_type || ''}`), h('td', { class: 'small muted' }, a.details)))))) : emptyState('No activity yet.')));
}

async function clearScope(scope, message) {
  if (!(await confirmDialog(message, { danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await post('/data/clear', { scope });
    toast('Deleted', { type: 'success' });
    emit('data');
  } catch (e) { toastError(e); }
}

function account(body) {
  const cur = input('current', { type: 'password', autocomplete: 'current-password' });
  const next = input('next', { type: 'password', autocomplete: 'new-password' });
  clear(body,
    section('Signed in', h('p', `${state.user.name} · ${state.user.email}`),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { if (await confirmDialog('Sign out of every device, including this one?', { confirmLabel: 'Sign out everywhere' })) { await post('/auth/logout-all'); location.reload(); } } }, 'Sign out everywhere'))),
    section('Change password', h('div', { class: 'form-grid' }, field('Current password', cur), field('New password', next, { help: 'At least 10 characters. Other sessions are signed out.' })),
      h('div', { style: { 'margin-top': '10px' } }, h('button', { class: 'btn primary', onclick: async () => { try { await post('/auth/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('Password changed', { type: 'success' }); } catch (e) { toastError(e); } } }, 'Change password'))),
    section('Delete account',
      h('p', { class: 'small muted' }, 'Permanently deletes your account and every record in it. Export your data first if you want a copy.'),
      h('button', { class: 'btn danger', onclick: () => formModal({ title: 'Delete account permanently', submitLabel: 'Delete my account', fields: [h('p', { class: 'full' }, 'Type DELETE to confirm. This cannot be undone.'), field('Confirmation', input('confirm', { required: true }), { full: true })], onSubmit: async (fd) => { await post('/account/delete', { confirm: fd.get('confirm') }); location.reload(); } }) }, 'Delete account')));
}
