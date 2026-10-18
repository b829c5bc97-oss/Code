// Assistant input: text box + push-to-talk microphone + stop/cancel + voice status.
import { h, icon } from './ui.js';
import { listen, voiceSupport, stopSpeaking } from './voice.js';

export const SUGGESTIONS = [
  'Plan my day based on my meetings and deadlines',
  'What do I need to finish today?',
  'How much did I spend this month, and where did my money go?',
  'Find a free time slot for a meeting next week',
  'Organise my tasks by urgency and importance',
  'Prepare me for tomorrow\'s meetings',
  'Move my unfinished tasks to suitable times tomorrow',
  'Give me a summary of my day and a plan for tomorrow',
];

/**
 * @param {object} o
 * @param {(text: string, viaVoice: boolean) => Promise<void>} o.onSubmit
 * @param {() => void} [o.onCancel] abort an in-flight request
 */
export function composer({ onSubmit, onCancel, placeholder = 'Ask JARVIS anything — "Schedule two hours for my project tomorrow afternoon"', autofocus = false, suggestions = true }) {
  const inputEl = h('input', { type: 'text', placeholder, 'aria-label': 'Message JARVIS', autocomplete: 'off', maxlength: 8000, autofocus });
  const status = h('div', { class: 'voice-status', 'aria-live': 'polite' });
  const micBtn = h('button', { type: 'button', class: 'btn icon mic', 'aria-label': 'Start voice input', title: voiceSupport.recognition ? 'Hold a conversation by voice (push to talk)' : 'Voice input is not supported in this browser', dataset: { state: 'idle' } }, icon('mic'));
  const sendBtn = h('button', { type: 'submit', class: 'btn primary icon', 'aria-label': 'Send' }, icon('send'));
  const stopBtn = h('button', { type: 'button', class: 'btn icon danger', 'aria-label': 'Stop', title: 'Stop listening, speaking or the current request', hidden: true }, icon('stop'));
  let ctrl = null;
  let busy = false;

  const setStatus = (text, spinner = false) => {
    status.replaceChildren(...(spinner ? [h('span', { class: 'spinner' })] : []), text || '');
  };
  const setBusy = (b) => {
    busy = b;
    sendBtn.disabled = b;
    inputEl.disabled = b;
    stopBtn.hidden = !b && !ctrl;
    if (b) setStatus('JARVIS is working…', true);
    else if (!ctrl) setStatus('');
  };

  const submit = async (text, viaVoice = false) => {
    const t = text.trim();
    if (!t || busy) return;
    inputEl.value = '';
    setBusy(true);
    try {
      await onSubmit(t, viaVoice);
    } finally {
      setBusy(false);
      inputEl.focus();
    }
  };

  micBtn.addEventListener('click', () => {
    if (ctrl) {
      ctrl.stop();
      return;
    }
    stopSpeaking();
    ctrl = listen({
      onInterim: (t) => { inputEl.value = t; },
      onFinal: (t) => submit(t, true),
      onState: (s, detail) => {
        micBtn.dataset.state = s;
        micBtn.setAttribute('aria-label', s === 'listening' ? 'Stop listening' : 'Start voice input');
        if (s === 'listening') { setStatus('Listening… speak now, then pause.'); stopBtn.hidden = false; }
        if (s === 'idle' || s === 'error') { ctrl = null; stopBtn.hidden = !busy; }
        if (s === 'error') setStatus(detail);
        if (s === 'idle' && !busy) setStatus('');
      },
    });
  });
  stopBtn.addEventListener('click', () => {
    ctrl?.abort();
    ctrl = null;
    stopSpeaking();
    if (busy) onCancel?.();
    micBtn.dataset.state = 'idle';
    setStatus('Stopped.');
    stopBtn.hidden = true;
  });

  const form = h('form', { class: 'command', onsubmit: (e) => { e.preventDefault(); submit(inputEl.value); } }, icon('sparkle'), inputEl, stopBtn, micBtn, sendBtn);
  const chips = suggestions ? h('div', { class: 'suggestions' }, SUGGESTIONS.slice(0, 5).map((s) => h('button', { type: 'button', class: 'chip', onclick: () => submit(s) }, s))) : null;
  return {
    el: h('div', { class: 'stack' }, form, status, chips),
    input: inputEl,
    submit,
    setStatus,
    speakingState: (on) => {
      stopBtn.hidden = !on && !busy && !ctrl;
      setStatus(on ? 'Speaking… press stop to silence.' : '');
    },
  };
}
