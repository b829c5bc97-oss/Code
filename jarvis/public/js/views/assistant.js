import { h, icon, clear, emptyState, toastError, confirmDialog } from '../ui.js';
import { get, del } from '../api.js';
import { state } from '../state.js';
import { composer, SUGGESTIONS } from '../composer.js';
import { renderMessage, sendToAssistant, typingIndicator, renderPending } from '../chat.js';
import { voiceSupport } from '../voice.js';

export async function render(el, { params, query }) {
  let conversationId = params[0] || null;
  const convList = h('div', { class: 'list' });
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-label': 'Conversation' });
  let abort = null;

  const comp = composer({
    autofocus: true,
    suggestions: false,
    onSubmit: async (text, viaVoice) => {
      if (log.querySelector('.empty')) log.replaceChildren();
      log.append(renderMessage({ role: 'user', content: text }));
      const typing = typingIndicator();
      log.append(typing);
      log.scrollTop = log.scrollHeight;
      abort = new AbortController();
      try {
        const r = await sendToAssistant(text, conversationId, { viaVoice, signal: abort.signal, onSpeaking: (on) => comp.speakingState(on) });
        typing.remove();
        const isNew = !conversationId;
        conversationId = r.conversation_id;
        if (isNew) history.replaceState(null, '', `#/assistant/${conversationId}`);
        log.append(renderMessage(r.message, { pending: r.message.pending }));
        loadConversations();
      } catch (e) {
        typing.remove();
        log.append(h('div', { class: 'msg assistant' }, h('div', { class: 'bubble error-text' }, e.name === 'AbortError' ? 'Cancelled. If the request already reached the server, reload the conversation to see the outcome.' : e.message)));
      }
      log.scrollTop = log.scrollHeight;
    },
    onCancel: () => abort?.abort(),
  });

  const statusLine = h('div', { class: 'small muted row tight' },
    state.ai?.configured ? [h('span', { class: 'badge success' }, 'AI connected'), state.ai.label] : [h('span', { class: 'badge warning' }, 'Demo assistant'), 'No AI model configured — type “help” for supported commands.'],
    state.ai?.web_search?.configured ? h('span', { class: 'badge accent' }, 'Web search on') : null,
    !voiceSupport.recognition ? h('span', { class: 'faint' }, '· Voice input not supported in this browser') : null);

  clear(el, h('div', { class: 'chat-layout' },
    h('aside', { class: 'chat-side card' },
      h('button', { class: 'btn primary', onclick: () => { conversationId = null; history.replaceState(null, '', '#/assistant'); showEmpty(); } }, icon('plus'), 'New conversation'),
      h('div', { class: 'small faint' }, 'History'),
      convList),
    h('section', { class: 'chat-main' },
      log,
      h('div', { class: 'chat-input' }, statusLine, comp.el))));

  function showEmpty() {
    clear(log, h('div', { class: 'empty stack' },
      h('h2', 'How can I help?'),
      h('p', 'I can plan your day, schedule events, organise tasks, track spending, set reminders and work with your notes. Changes that matter are shown for your approval first.'),
      h('div', { class: 'suggestions', style: { 'justify-content': 'center' } }, SUGGESTIONS.map((s) => h('button', { class: 'chip', onclick: () => comp.submit(s) }, s)))));
    for (const c of convList.children) c.setAttribute('aria-current', 'false');
  }

  async function loadConversations() {
    try {
      const list = await get('/assistant/conversations');
      clear(convList, list.length ? list.map((c) => h('div', { class: 'conv', role: 'button', tabindex: 0, 'aria-current': String(c.id === conversationId), onclick: () => open(c.id), onkeydown: (e) => e.key === 'Enter' && open(c.id) },
        h('span', { class: 'grow truncate' }, c.title),
        h('button', { class: 'btn ghost sm icon', 'aria-label': `Delete conversation ${c.title}`, onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete this conversation? Changes JARVIS already made to your data stay in place.', { danger: true, confirmLabel: 'Delete' })) { await del(`/assistant/conversations/${c.id}`); if (c.id === conversationId) { conversationId = null; showEmpty(); } loadConversations(); } } }, icon('trash')))) : h('div', { class: 'small faint' }, 'No conversations yet.'));
    } catch (e) {
      toastError(e);
    }
  }

  async function open(id) {
    conversationId = id;
    history.replaceState(null, '', `#/assistant/${id}`);
    for (const c of convList.children) c.setAttribute('aria-current', 'false');
    try {
      const c = await get(`/assistant/conversations/${id}`);
      clear(log, c.messages.map((m) => renderMessage(m)), c.pending.length ? h('div', { class: 'stack' }, h('div', { class: 'small muted' }, 'Waiting for your approval:'), c.pending.map((p) => renderPending(p))) : null);
      log.scrollTop = log.scrollHeight;
      loadConversations();
    } catch (e) {
      toastError(e);
      conversationId = null;
      showEmpty();
    }
  }

  await loadConversations();
  if (conversationId) await open(conversationId);
  else showEmpty();
  const q = query.get('q');
  if (q) {
    history.replaceState(null, '', '#/assistant');
    comp.submit(q);
  }
}
