import { h, clear, field, input } from '../ui.js';
import { post } from '../api.js';

export function renderAuth(root, { signupAllowed, onAuthed }) {
  let mode = 'login';
  const draw = () => {
    const err = h('p', { class: 'error-text', role: 'alert', hidden: true });
    const form = h('form', { class: 'stack', novalidate: true },
      mode === 'signup' ? field('Your name', input('name', { required: true, autocomplete: 'name', maxlength: 80 })) : null,
      field('Email', input('email', { type: 'email', required: true, autocomplete: 'email' })),
      field('Password', input('password', { type: 'password', required: true, autocomplete: mode === 'signup' ? 'new-password' : 'current-password' }), { help: mode === 'signup' ? 'At least 10 characters.' : null }),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Sign in'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const fd = new FormData(form);
      const body = Object.fromEntries(fd);
      body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await post(mode === 'signup' ? '/auth/signup' : '/auth/login', body);
        onAuthed();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
    clear(root, h('div', { class: 'auth' },
      h('div', { class: 'card auth-card glow' },
        h('div', { class: 'brand' }, h('div', { class: 'brand-mark', 'aria-hidden': 'true' }), h('div', { class: 'brand-name' }, 'JARVIS')),
        h('h1', mode === 'signup' ? 'Create your account' : 'Welcome back'),
        h('p', { class: 'lead' }, 'Your calendar, tasks, money and notes — coordinated by one assistant.'),
        form,
        signupAllowed ? h('p', { class: 'small muted', style: { 'text-align': 'center', 'margin-top': '16px' } },
          mode === 'signup' ? 'Already have an account? ' : 'New to JARVIS? ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = mode === 'signup' ? 'login' : 'signup'; draw(); } }, mode === 'signup' ? 'Sign in' : 'Create an account')) : null,
        h('p', { class: 'tiny faint', style: { 'text-align': 'center', 'margin-top': '10px' } }, 'Your data is stored on this JARVIS server and is private to your account.'),
      )));
    root.querySelector('input')?.focus();
  };
  draw();
}
