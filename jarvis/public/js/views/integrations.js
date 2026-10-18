import { h, icon, clear, tabs, emptyState, toast, toastError, confirmDialog, openModal, fmtDateTime, markdown, field, input, textarea, checkbox } from '../ui.js';
import { get, post, patch, del } from '../api.js';
import { state, emit } from '../state.js';

let tab = 'connections';

export async function render(el, { query }) {
  if (query.get('connected')) toast(`${query.get('connected')} connected. Run a sync to import your calendar.`, { type: 'success', title: 'Connected' });
  if (query.get('error')) toast(query.get('error'), { type: 'error', title: 'Connection failed' });
  if (query.get('tab')) tab = query.get('tab');
  if (query.get('connected') || query.get('error')) history.replaceState(null, '', '#/integrations');
  const tabBar = h('div');
  const body = h('div');
  clear(el, h('div', { class: 'page-head' }, h('div', h('h1', 'Integrations'), h('p', 'Connect accounts through official, permission-based APIs. Nothing is connected unless it says so here.'))), tabBar, body);
  const draw = async () => {
    clear(tabBar, tabs([['connections', 'Connections'], ['email', 'Email']], tab, (t) => { tab = t; draw(); }));
    try {
      const data = await get('/integrations');
      if (tab === 'connections') connections(body, data, draw);
      else await emailView(body, data);
    } catch (e) { clear(body, emptyState(e.message)); }
  };
  await draw();
}

function statusBadge(ok, label) {
  return h('span', { class: `badge ${ok ? 'success' : 'warning'}` }, label);
}

function connections(body, data, redraw) {
  const ai = data.ai;
  clear(body, h('div', { class: 'grid grid-2' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', icon('sparkle', 'icon'), 'AI model'), statusBadge(ai.configured, ai.configured ? 'Connected' : 'Not configured')),
      ai.configured ? h('p', { class: 'muted' }, `JARVIS is using ${ai.label}. API keys stay on the server and are never sent to your browser.`) : h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Without an AI provider, a limited rule-based demo assistant answers instead (it says so in every reply). To connect a real model, set environment variables on the server and restart:'),
        h('pre', { class: 'small mono card', style: { 'white-space': 'pre-wrap', margin: 0 } }, '# Anthropic (recommended)\nANTHROPIC_API_KEY=sk-ant-...\n# optional: ANTHROPIC_MODEL=claude-opus-5-5\n\n# or any OpenAI-compatible API\nAI_PROVIDER=openai\nOPENAI_API_KEY=...\nOPENAI_MODEL=...\n# optional: OPENAI_BASE_URL=https://api.openai.com/v1'),
        h('p', { class: 'small faint' }, 'See README.md → “AI provider”.'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', icon('globe', 'icon'), 'Web search'), statusBadge(data.search.configured, data.search.configured ? `Connected (${data.search.provider})` : 'Not configured')),
      h('p', { class: 'muted' }, data.search.configured ? 'JARVIS can search the web; results are always labelled as external.' : 'Set TAVILY_API_KEY or BRAVE_API_KEY on the server to enable web research. Without it, JARVIS will tell you it cannot search rather than guess.')),
    ...data.providers.map((p) => providerCard(p, redraw)),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', icon('wallet', 'icon'), 'Bank accounts'), statusBadge(false, 'Not available')),
      h('p', { class: 'muted' }, data.banking.note)),
  ));
}

function providerCard(p, redraw) {
  const c = p.connection;
  const connected = c && c.status === 'connected';
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', icon(p.key === 'google' ? 'mail' : 'calendar', 'icon'), p.label),
      h('div', { class: 'row tight' }, connected ? statusBadge(true, 'Connected') : c ? statusBadge(false, c.status) : statusBadge(false, p.configured ? 'Ready to connect' : 'Server not configured'), h('span', { class: 'badge', title: 'This integration follows the official API documentation but has not been verified against a live account in this build.' }, 'Untested'))),
    connected ? h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, `Signed in as ${c.account_email || 'unknown account'}. Granted: ${c.scopes.split(' ').filter((s) => !['openid', 'email'].includes(s)).map((s) => s.split('/').pop()).join(', ')}`),
      h('p', { class: 'small faint' }, c.last_sync_at ? `Last calendar import ${fmtDateTime(c.last_sync_at)}.` : 'Calendar not imported yet.', ' Calendar import is one-way (provider → JARVIS) for the next 30 days.'),
      c.last_error ? h('div', { class: 'banner warn' }, icon('alert'), c.last_error) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; try { const r = await post(`/integrations/${p.key}/sync`); toast(`Imported: ${r.created} new, ${r.updated} updated, ${r.removed} removed.`, { type: 'success' }); emit('data'); redraw(); } catch (err) { toastError(err); } finally { e.target.disabled = false; } } }, icon('refresh'), 'Import calendar now'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Disconnect ${p.label}? Stored tokens and imported events are deleted from JARVIS. You can also revoke access from your ${p.key === 'google' ? 'Google' : 'Microsoft'} account security page.`, { danger: true, confirmLabel: 'Disconnect' })) { await post(`/integrations/${p.key}/disconnect`); emit('data'); redraw(); } } }, 'Disconnect')))
      : h('div', { class: 'stack' },
        p.configured ? h('a', { class: 'btn primary', href: `/api/integrations/${p.key}/connect` }, icon('link'), `Connect ${p.key === 'google' ? 'Google' : 'Microsoft'} account`) : h('div', { class: 'banner warn' }, icon('alert'), 'This server has no OAuth credentials for this provider yet. Follow the steps below.'),
        h('details', { open: !p.configured },
          h('summary', { class: 'small', style: { cursor: 'pointer' } }, 'Setup steps'),
          h('ol', { class: 'small muted' }, p.setup.map((s) => h('li', s))),
          h('div', { class: 'small' }, 'Redirect URI: ', h('code', p.redirect_uri)),
          h('div', { class: 'small faint', style: { 'margin-top': '6px' } }, `Requested permissions: ${p.scopes.join(', ')}`))));
}

async function emailView(body, data) {
  const connected = data.providers.filter((p) => p.connection?.status === 'connected');
  const drafts = await get('/integrations/email/drafts');
  const inbox = h('section', { class: 'card span-2' });
  clear(body, h('div', { class: 'grid grid-3' }, inbox,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', icon('edit', 'icon'), 'Drafts'), h('button', { class: 'btn sm', onclick: () => draftDialog({}) }, icon('plus'), 'New')),
      h('p', { class: 'small faint' }, 'JARVIS can prepare drafts, but only you can send them — after confirming the recipient and message.'),
      drafts.length ? h('div', { class: 'list' }, drafts.map((d) => h('div', { class: 'list-item clickable', onclick: () => draftDialog(d) },
        h('div', { class: 'grow' }, h('div', { class: 'title truncate' }, d.subject || '(no subject)'), h('div', { class: 'small faint truncate' }, `To ${d.to_addr}`)),
        h('span', { class: `badge ${d.status === 'sent' ? 'success' : d.status === 'failed' ? 'danger' : ''}` }, d.status)))) : emptyState('No drafts.'))));

  if (!connected.length) {
    clear(inbox, h('div', { class: 'card-head' }, h('h3', icon('mail', 'icon'), 'Inbox')),
      h('div', { class: 'banner info' }, icon('info'), h('span', { class: 'grow' }, 'No mailbox is connected. JARVIS does not show a sample inbox. Connect Gmail or Outlook on the Connections tab to read, summarise and draft replies.')),
      h('button', { class: 'btn', onclick: () => { tab = 'connections'; render(document.getElementById('main'), { query: new URLSearchParams() }); } }, 'Go to connections'));
    return;
  }
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search mail…', 'aria-label': 'Search mail' });
  const unreadOnly = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'list' });
  const load = async () => {
    clear(list, h('span', { class: 'spinner' }));
    try {
      const r = await get(`/integrations/email/messages?${new URLSearchParams({ unread: unreadOnly.checked ? '1' : '0', q: q.value })}`);
      clear(list, r.messages.length ? r.messages.map((m) => h('div', { class: 'list-item clickable', onclick: () => threadDialog(m) },
        m.unread ? h('span', { class: 'prio medium', title: 'Unread' }) : h('span', { class: 'prio low' }),
        h('div', { class: 'grow' }, h('div', { class: 'title truncate' }, m.important ? '⭐ ' : '', m.subject || '(no subject)'), h('div', { class: 'small faint truncate' }, `${m.from} · ${m.snippet || ''}`)),
        h('span', { class: 'small faint nowrap' }, m.date ? new Date(m.date).toLocaleDateString() : ''))) : emptyState(unreadOnly.checked ? 'No unread messages.' : 'No messages.'));
    } catch (e) { clear(list, h('p', { class: 'error-text' }, e.message)); }
  };
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  unreadOnly.addEventListener('change', load);
  clear(inbox, h('div', { class: 'card-head' }, h('h3', icon('mail', 'icon'), `Inbox · ${connected.map((c) => c.connection.account_email || c.label).join(', ')}`),
    state.ai?.configured ? h('a', { class: 'btn sm', href: `#/assistant?q=${encodeURIComponent('Summarise my unread emails and identify the important ones')}` }, icon('sparkle'), 'Summarise unread') : null),
  h('div', { class: 'row', style: { 'margin-bottom': '10px' } }, h('div', { class: 'grow' }, q), h('label', { class: 'check small' }, unreadOnly, 'Unread only'), h('button', { class: 'btn sm', onclick: load }, icon('refresh'), 'Refresh')), list);
  load();
}

async function threadDialog(m) {
  const box = h('div', { class: 'stack' }, h('span', { class: 'spinner' }));
  const modal = openModal({ title: m.subject || '(no subject)', body: box, wide: true, actions: [
    { label: 'Ask JARVIS to draft a reply', onClick: () => { location.hash = `#/assistant?q=${encodeURIComponent(`Read email thread ${m.thread_id} ("${m.subject}") and draft a reply for me to review.`)}`; } },
    { label: 'Close', primary: true }] });
  try {
    const t = await get(`/integrations/email/threads/${encodeURIComponent(m.thread_id)}`);
    clear(box,
      t.extracted.action_items.length || t.extracted.dates.length ? h('div', { class: 'card' }, h('strong', 'Detected (keyword-based, may be incomplete)'),
        t.extracted.dates.length ? h('p', { class: 'small' }, `Dates mentioned: ${t.extracted.dates.join(', ')}`) : null,
        t.extracted.action_items.length ? h('ul', { class: 'small' }, t.extracted.action_items.map((a) => h('li', a))) : null,
        h('div', { class: 'row tight' },
          h('button', { class: 'btn sm', onclick: async () => { await post('/reminders', { title: `Follow up: ${m.subject}`.slice(0, 300), remind_at: new Date(Date.now() + 2 * 864e5).toISOString(), notes: `From ${m.from}` }); toast('Follow-up reminder set for 2 days from now.', { type: 'success' }); } }, 'Remind me to follow up'),
          t.extracted.action_items.length ? h('button', { class: 'btn sm', onclick: async () => { for (const a of t.extracted.action_items.slice(0, 5)) await post('/tasks', { title: a.slice(0, 300), description: `From email: ${m.subject}` }); toast('Tasks created from email.', { type: 'success' }); emit('data'); } }, 'Create tasks') : null)) : null,
      t.messages.map((x) => h('div', { class: 'card' }, h('div', { class: 'small faint' }, `${x.from} → ${x.to || ''} · ${x.date}`), h('div', { style: { 'white-space': 'pre-wrap', 'margin-top': '6px' } }, x.body || '(no text content)'))),
      h('button', { class: 'btn', onclick: () => { modal.close(); const last = t.messages.at(-1); draftDialog({ to_addr: (last?.from || '').match(/<([^>]+)>/)?.[1] || last?.from || '', subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, thread_id: m.thread_id }); } }, 'Write reply'));
  } catch (e) { clear(box, h('p', { class: 'error-text' }, e.message)); }
}

function draftDialog(d) {
  const sent = d.status === 'sent';
  const to = input('to', { type: 'email', value: d.to_addr || '', required: true });
  const subject = input('subject', { value: d.subject || '', maxlength: 300 });
  const bodyT = textarea('body', d.body || '', { rows: 10 });
  if (sent) [to, subject, bodyT].forEach((x) => { x.disabled = true; });
  const save = async () => {
    if (d.id) await patch(`/integrations/email/drafts/${d.id}`, { to: to.value, subject: subject.value, body: bodyT.value });
    else d = { ...d, id: (await post('/integrations/email/drafts', { to: to.value, subject: subject.value, body: bodyT.value, thread_id: d.thread_id })).draft_id };
  };
  openModal({
    title: sent ? 'Sent email' : d.id ? 'Edit draft' : 'New draft', wide: true,
    body: h('div', { class: 'form-grid' }, field('To', to, { full: true }), field('Subject', subject, { full: true }), field('Message', bodyT, { full: true }), d.error ? h('p', { class: 'error-text full' }, `Last send failed: ${d.error}`) : null),
    actions: sent ? [{ label: 'Close', primary: true }] : [
      d.id ? { label: 'Delete', danger: true, left: true, onClick: async () => { await del(`/integrations/email/drafts/${d.id}`); emit('data'); render(document.getElementById('main'), { query: new URLSearchParams('tab=email') }); } } : null,
      { label: 'Save draft', onClick: async () => { await save(); toast('Draft saved', { type: 'success' }); render(document.getElementById('main'), { query: new URLSearchParams('tab=email') }); } },
      { label: 'Review & send…', primary: true, onClick: async () => { await save(); return confirmSend(d.id, to.value, subject.value, bodyT.value); } },
    ].filter(Boolean),
  });
}

/** Explicit send confirmation: shows the exact recipient and message and requires a tick. */
function confirmSend(id, to, subject, body) {
  const tick = checkbox('ok', `I have reviewed this message and want to send it to ${to}`, false);
  const sendBtnState = { sending: false };
  openModal({
    title: 'Send this email?',
    body: h('div', { class: 'stack' }, h('div', { class: 'banner warn' }, icon('alert'), 'This will send a real email from your connected account.'), h('div', h('strong', 'To: '), to), h('div', h('strong', 'Subject: '), subject || '(no subject)'), h('div', { class: 'card', style: { 'white-space': 'pre-wrap', 'max-height': '240px', 'overflow-y': 'auto' } }, body), tick),
    actions: [{ label: 'Cancel', ghost: true }, { label: 'Send email', primary: true, onClick: async () => {
      if (!tick.querySelector('input').checked) { toast('Tick the confirmation box first.'); return false; }
      if (sendBtnState.sending) return false;
      sendBtnState.sending = true;
      await post(`/integrations/email/drafts/${id}/send`, { confirm_to: to, confirm_subject: subject });
      toast(`Email sent to ${to}.`, { type: 'success' });
      render(document.getElementById('main'), { query: new URLSearchParams('tab=email') });
    } }],
  });
  return true;
}

export { markdown };
