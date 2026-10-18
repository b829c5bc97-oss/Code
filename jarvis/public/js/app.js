import { h, icon, clear, toast, openModal, emptyState } from './ui.js';
import { get, post, patch } from './api.js';
import { state, onState, emit } from './state.js';
import { loadAiStatus } from './chat.js';
import { renderAuth } from './views/auth.js';

const ROUTES = [
  ['overview', 'Overview', 'overview', () => import('./views/overview.js')],
  ['assistant', 'AI Assistant', 'assistant', () => import('./views/assistant.js')],
  ['calendar', 'Calendar', 'calendar', () => import('./views/calendar.js')],
  ['tasks', 'Tasks & Projects', 'tasks', () => import('./views/tasks.js')],
  ['schedule', 'Work Schedule', 'schedule', () => import('./views/schedule.js')],
  ['finance', 'Finance', 'finance', () => import('./views/finance.js')],
  ['reminders', 'Reminders', 'reminders', () => import('./views/reminders.js')],
  ['notes', 'Notes & Knowledge', 'notes', () => import('./views/notes.js')],
  ['integrations', 'Integrations', 'integrations', () => import('./views/integrations.js')],
  ['settings', 'Settings', 'settings', () => import('./views/settings.js')],
];

const root = document.getElementById('root');
let shell = null;
let cleanup = null;
let stream = null;
let pollTimer = null;

export function applyTheme() {
  const t = state.settings?.theme || 'dark';
  const resolved = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f4f6fa' : '#07090d');
}

async function boot() {
  try {
    const me = await get('/auth/me');
    if (!me.user) return renderAuth(root, { signupAllowed: me.signupAllowed, onAuthed: boot });
    state.user = me.user;
    state.settings = me.settings;
    applyTheme();
    await loadAiStatus().catch(() => null);
    buildShell();
    route();
    connectStream();
    refreshNotifications();
  } catch (e) {
    clear(root, h('div', { class: 'auth' }, h('div', { class: 'card auth-card' }, h('h1', 'Can\'t reach JARVIS'), h('p', { class: 'lead' }, e.message), h('button', { class: 'btn primary', onclick: boot }, 'Retry'))));
  }
}

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, ROUTES.map(([key, label, ic]) => h('a', { href: `#/${key}`, dataset: { route: key } }, icon(ic), label)));
  const aiPill = h('div', { class: 'ai-pill', title: '' });
  const bellCount = h('span', { class: 'count', hidden: true });
  const bell = h('button', { class: 'btn ghost icon bell', 'aria-label': 'Notifications', 'aria-haspopup': 'true', onclick: toggleNotifications }, icon('bell'), bellCount);
  const themeBtn = h('button', { class: 'btn ghost icon', 'aria-label': 'Toggle light/dark theme', onclick: toggleTheme }, icon(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun'));
  const title = h('h1', '');
  const content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const app = h('div', { class: 'app' },
    h('aside', { class: 'sidebar', 'aria-label': 'Sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }), h('div', h('div', { class: 'brand-name' }, 'JARVIS'), h('div', { class: 'brand-sub' }, 'Personal chief of staff'))),
      nav,
      h('div', { class: 'sidebar-foot stack tight' }, aiPill, h('div', { class: 'row between' }, h('span', { class: 'truncate' }, state.user.email), h('button', { class: 'btn ghost sm icon', 'aria-label': 'Sign out', title: 'Sign out', onclick: logout }, icon('logout'))))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Open menu', onclick: () => app.classList.toggle('nav-open') }, icon('menu')),
        title, h('div', { class: 'spacer' }), themeBtn, h('div', { class: 'bell-wrap', style: { position: 'relative' } }, bell)),
      content));
  app.addEventListener('click', (e) => {
    if (app.classList.contains('nav-open') && (e.target === app || e.target.closest('.nav a'))) app.classList.remove('nav-open');
  });
  clear(root, app);
  shell = { app, nav, content, title, aiPill, bellCount, bell, themeBtn };
  renderAiPill();
}

function renderAiPill() {
  if (!shell) return;
  const ai = state.ai;
  shell.aiPill.className = `ai-pill ${ai?.configured ? 'ok' : ''}`;
  shell.aiPill.title = ai?.configured ? `Connected AI: ${ai.label}` : ai?.hint || '';
  shell.aiPill.replaceChildren(h('span', { class: 'dot' }), h('span', ai?.configured ? ai.label : 'Demo assistant · no AI key'));
}

async function route() {
  if (!shell) return;
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, query = ''] = hash.split('?');
  const [key, ...rest] = path.split('/');
  const def = ROUTES.find((r) => r[0] === key) || ROUTES[0];
  for (const a of shell.nav.querySelectorAll('a')) a.removeAttribute('aria-current');
  shell.nav.querySelector(`a[data-route="${def[0]}"]`)?.setAttribute('aria-current', 'page');
  shell.title.textContent = def[1];
  document.title = `${def[1]} · JARVIS`;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  clear(shell.content, h('div', { class: 'stack' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
  try {
    const mod = await def[3]();
    clear(shell.content);
    cleanup = await mod.render(shell.content, { params: rest, query: new URLSearchParams(query) });
  } catch (e) {
    console.error(e);
    clear(shell.content, emptyState(`This screen failed to load: ${e.message}`, h('button', { class: 'btn', onclick: route }, 'Retry')));
  }
  shell.content.focus({ preventScroll: true });
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  state.settings.theme = next;
  applyTheme();
  shell.themeBtn.replaceChildren(icon(next === 'light' ? 'moon' : 'sun'));
  patch('/settings', { theme: next }).catch(() => {});
}

async function logout() {
  await post('/auth/logout').catch(() => {});
  stream?.close();
  state.user = null;
  shell = null;
  boot();
}

// ---------- notifications ----------
let popover = null;
async function refreshNotifications() {
  try {
    const r = await get('/notifications');
    state.unread = r.unread;
    state.scheduler = r.scheduler;
    if (shell) {
      shell.bellCount.hidden = !r.unread;
      shell.bellCount.textContent = r.unread > 99 ? '99+' : String(r.unread);
    }
    return r;
  } catch {
    return null;
  }
}

async function toggleNotifications() {
  if (popover) {
    popover.remove();
    popover = null;
    return;
  }
  const r = await refreshNotifications();
  const list = r?.notifications || [];
  popover = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Notifications' },
    h('div', { class: 'row between', style: { padding: '12px 14px', 'border-bottom': '1px solid var(--border)' } }, h('strong', 'Notifications'),
      h('div', { class: 'row tight' }, h('button', { class: 'btn ghost sm', onclick: async () => { await post('/notifications/read', { ids: 'all' }); popover?.remove(); popover = null; refreshNotifications(); } }, 'Mark all read'), h('a', { class: 'btn ghost sm', href: '#/reminders?tab=notifications' }, 'View all'))),
    list.length ? list.slice(0, 15).map((n) => h('a', { class: ['notif', !n.read_at && 'unread'], href: n.link || '#/reminders', onclick: () => { post('/notifications/read', { ids: [n.id] }).then(refreshNotifications); popover?.remove(); popover = null; } },
      icon(n.kind === 'bill' ? 'wallet' : n.kind === 'event' ? 'calendar' : n.kind === 'briefing' ? 'sparkle' : 'bell'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, n.title), n.body ? h('div', { class: 'small muted' }, n.body) : null, h('div', { class: 'meta' }, new Date(n.created_at).toLocaleString())))) : emptyState('No notifications yet.'),
    !r?.scheduler?.running ? h('div', { class: 'small warning', style: { padding: '10px 14px' } }, 'The reminder scheduler is not running in this server process. Reminders are delivered only if a separate worker (npm run worker) is running.') : null,
  );
  shell.bell.parentElement.append(popover);
  setTimeout(() => document.addEventListener('click', closePopover, { once: true }), 0);
}
function closePopover(e) {
  if (popover && !popover.contains(e.target)) {
    popover.remove();
    popover = null;
  } else if (popover) document.addEventListener('click', closePopover, { once: true });
}

function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'notification') return;
    const n = msg.notification;
    toast(n.body || '', { title: n.title, timeout: 8000 });
    refreshNotifications();
    if (state.settings?.notifications?.browser && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try {
        new Notification(n.title, { body: n.body, tag: n.id, icon: '/favicon.svg' });
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  };
  // Polling fallback in case the stream is interrupted by a proxy.
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshNotifications, 60000);
}

window.addEventListener('hashchange', route);
window.addEventListener('jarvis:unauthorized', () => {
  if (state.user) {
    toast('Your session ended. Please sign in again.', { type: 'error' });
    state.user = null;
    shell = null;
    boot();
  }
});
onState((what) => {
  if (what === 'settings') {
    applyTheme();
    renderAiPill();
  }
  if (what === 'ai') renderAiPill();
  if (what === 'notifications') refreshNotifications();
});
export const navigate = (hash) => { location.hash = hash; };
export { refreshNotifications, openModal, emit };

boot();
