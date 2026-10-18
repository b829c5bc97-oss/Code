// Browser speech recognition + synthesis. Push-to-talk only: no wake word or background listening.
import { state } from './state.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupport = {
  recognition: !!Recognition,
  synthesis: 'speechSynthesis' in window,
  secure: window.isSecureContext,
};

/**
 * Start a single listening session. Returns a controller with stop()/abort().
 * callbacks: onInterim(text), onFinal(text), onState(state, detail), where state ∈ idle|listening|error.
 */
export function listen({ onInterim, onFinal, onState }) {
  if (!Recognition) {
    onState('error', 'Voice input is not supported in this browser. Try Chrome, Edge or Safari, or type instead.');
    return null;
  }
  if (!voiceSupport.secure) {
    onState('error', 'Microphone access needs a secure (https or localhost) connection.');
    return null;
  }
  const rec = new Recognition();
  rec.lang = state.settings?.locale || navigator.language || 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  let errored = false;
  rec.onstart = () => onState('listening');
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onInterim?.((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    errored = true;
    const msg = {
      'not-allowed': 'Microphone permission was denied. Allow it in your browser\'s site settings to use voice.',
      'service-not-allowed': 'Speech recognition is blocked in this browser.',
      'no-speech': 'I didn\'t hear anything. Try again.',
      'audio-capture': 'No microphone was found.',
      network: 'Speech recognition needs a network connection in this browser.',
      aborted: 'Listening cancelled.',
    }[e.error] || `Voice error: ${e.error}`;
    onState('error', msg);
  };
  rec.onend = () => {
    if (errored) return;
    if (finalText.trim()) onFinal(finalText.trim());
    onState('idle');
  };
  try {
    rec.start();
  } catch (e) {
    onState('error', e.message);
    return null;
  }
  return { stop: () => rec.stop(), abort: () => rec.abort() };
}

/** Speak text aloud; markdown symbols are stripped. Returns a promise resolving when speech ends. */
export function speak(text, { onStart, onEnd } = {}) {
  if (!voiceSupport.synthesis) return Promise.resolve();
  stopSpeaking();
  const plain = String(text).replace(/_Demo assistant[^_]*_/g, '').replace(/[*_`#>]/g, '').replace(/\n+/g, '. ').slice(0, 1200);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(plain);
    u.rate = state.settings?.assistant?.speechRate || 1;
    u.lang = state.settings?.locale || 'en-IN';
    const voices = speechSynthesis.getVoices();
    const wanted = state.settings?.assistant?.voiceName;
    const v = voices.find((x) => x.name === wanted);
    if (v) u.voice = v;
    u.onstart = () => onStart?.();
    u.onend = u.onerror = () => {
      onEnd?.();
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (voiceSupport.synthesis) speechSynthesis.cancel();
}

export function listVoices() {
  return voiceSupport.synthesis ? speechSynthesis.getVoices() : [];
}
