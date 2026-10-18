// Rendering of assistant messages, executed actions and approval cards (shared by Overview and Assistant).
import { h, icon, markdown, toast, toastError, fmtTime, fmtRelDay } from './ui.js';
import { get, post } from './api.js';
import { state, emit } from './state.js';
import { speak } from './voice.js';

const ACTION_ICON = { ok: 'check', read: 'search', pending: 'clock', error: 'alert', denied: 'alert', conflict: 'alert' };
const ACTION_LABEL = { ok: 'Done', read: 'Read', pending: 'Needs approval', error: 'Failed', denied: 'Not permitted', conflict: 'Conflict' };

export function renderActions(actions = []) {
  const visible = actions.filter((a) => a.status !== 'read');
  const reads = actions.filter((a) => a.status === 'read');
  if (!actions.length) return null;
  return h('div', { class: 'action-list', 'aria-label': 'What JARVIS did' },
    visible.map((a) => h('div', { class: `action ${a.status}` }, icon(ACTION_ICON[a.status] || 'info'), h('span', { class: 'badge' }, ACTION_LABEL[a.status] || a.status), h('span', { class: 'grow' }, a.summary))),
    reads.length ? h('div', { class: 'action' }, icon('search'), h('span', { class: 'grow' }, `Checked your data: ${[...new Set(reads.map((r) => r.summary.replace('Looked up ', '')))].join(', ')}`)) : null,
  );
}

function previewFor(p) {
  const pv = p.preview;
  if (!pv) return null;
  if (pv.blocks) {
    return h('div', { class: 'plan-preview' }, pv.blocks.map((b) => h('div', { class: 'row tight' }, h('span', { class: 'time-col' }, `${fmtRelDay(b.start)} ${fmtTime(b.start)}`), h('span', { class: 'grow' }, b.title || 'Task block'))));
  }
  if (pv.project) {
    return h('div', { class: 'plan-preview' },
      h('strong', pv.project.name), pv.project.deadline ? h('span', { class: 'small muted' }, `Deadline ${pv.project.deadline}`) : null,
      pv.milestones.map((m) => h('div', { class: 'stack tight' }, h('div', { class: 'small' }, h('strong', m.title), m.due_date ? ` · by ${m.due_date}` : ''),
        h('ul', m.tasks.map((t) => h('li', { class: 'small' }, t.title, t.due ? h('span', { class: 'faint' }, ` — ${t.due}`) : '', t.depends_on?.length ? h('span', { class: 'faint' }, ` (after ${t.depends_on.join(', ')})`) : '')))),
      ));
  }
  return null;
}

/** Approval card for an action the assistant queued. The change only happens when the user confirms. */
export function renderPending(p, { onResolved } = {}) {
  const card = h('div', { class: 'confirm-card', role: 'group', 'aria-label': 'Approval needed' });
  const status = h('div', { class: 'small muted' }, 'Nothing has been changed yet.');
  const confirmBtn = h('button', { class: 'btn primary sm' }, icon('check'), 'Approve');
  const rejectBtn = h('button', { class: 'btn ghost sm' }, 'Decline');
  const decide = async (decision) => {
    confirmBtn.disabled = rejectBtn.disabled = true;
    try {
      const r = await post(`/assistant/actions/${p.id}`, { decision });
      card.classList.add('resolved');
      if (r.status === 'ok') {
        const created = r.result?.created;
        const skipped = r.result?.skipped;
        status.textContent = `Approved and saved.${Array.isArray(created) ? ` ${created.length} added.` : ''}${skipped?.length ? ` ${skipped.length} skipped: ${skipped.map((s) => `${s.title} (${s.reason})`).join('; ')}` : ''}${r.result?.created === false ? ' Not created because of a conflict.' : ''}`;
        toast(p.summary, { type: 'success', title: 'Done' });
        emit('data');
      } else if (r.status === 'rejected') status.textContent = 'Declined — nothing was changed.';
      else status.textContent = `Could not complete: ${r.error}`;
      confirmBtn.remove();
      rejectBtn.remove();
      onResolved?.(r);
    } catch (e) {
      toastError(e);
      confirmBtn.disabled = rejectBtn.disabled = false;
    }
  };
  confirmBtn.addEventListener('click', () => decide('confirm'));
  rejectBtn.addEventListener('click', () => decide('reject'));
  card.append(h('div', { class: 'row' }, icon('clock'), h('strong', { class: 'grow' }, p.summary)), previewFor(p), status, h('div', { class: 'row tight' }, confirmBtn, rejectBtn));
  return card;
}

export function renderMessage(m, { pending = [] } = {}) {
  if (m.role === 'event') return h('div', { class: 'msg event' }, h('div', { class: 'bubble' }, m.content));
  const isUser = m.role === 'user';
  return h('div', { class: `msg ${isUser ? 'user' : 'assistant'}` },
    isUser ? null : h('div', { class: 'who' }, icon('sparkle'), 'JARVIS', state.ai && !state.ai.configured ? h('span', { class: 'badge warning' }, 'Demo assistant') : null),
    h('div', { class: 'bubble' }, isUser ? m.content : markdown(m.content)),
    isUser ? null : renderActions(m.actions),
    pending.map((p) => renderPending(p)),
    m.error ? h('div', { class: 'small error-text' }, m.error) : null,
  );
}

export function typingIndicator() {
  return h('div', { class: 'msg assistant' }, h('div', { class: 'bubble typing', 'aria-label': 'JARVIS is thinking' }, h('i'), h('i'), h('i')));
}

/** Send a message; speaks the reply if voice replies are enabled or the request came by voice. */
export async function sendToAssistant(text, conversationId, { viaVoice = false, signal, onSpeaking } = {}) {
  const r = await post('/assistant/chat', { message: text, conversation_id: conversationId || null }, { signal });
  if (r.provider) state.ai = { ...state.ai, ...r.provider };
  if (r.message.actions?.some((a) => a.status === 'ok')) emit('data');
  if (viaVoice || state.settings?.assistant?.voiceReplies) {
    onSpeaking?.(true);
    speak(r.message.content).then(() => onSpeaking?.(false));
  }
  return r;
}

export async function loadAiStatus() {
  state.ai = await get('/assistant/status');
  return state.ai;
}
