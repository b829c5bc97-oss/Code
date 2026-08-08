/**
 * Speech I/O — Phase 4.
 *
 * Deliberately built on the browser's own Web Speech API rather than a
 * server-side STT/TTS pipeline: the backend has no microphone or speaker
 * of its own (it may not even be running on the same machine as the
 * user), but the browser the user is looking at does. This also means
 * voice works with zero extra setup and no API key.
 *
 * Support caveat: `SpeechRecognition` (speech-to-text) is currently
 * Chrome/Edge/Safari only — there is no polyfill for Firefox. TTS
 * (`speechSynthesis`) is broadly supported. `isSpeechRecognitionSupported`
 * lets the UI say so plainly instead of pretending to listen.
 */

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export class SpeechListenError extends Error {}

/**
 * Listen once and resolve with the final transcript, or reject if nothing
 * was heard within `timeoutMs` / recognition failed / isn't supported.
 */
export function listenOnce(timeoutMs = 8000): Promise<string> {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    return Promise.reject(
      new SpeechListenError("Speech recognition isn't supported in this browser.")
    );
  }

  return new Promise((resolve, reject) => {
    const recognizer = new Ctor();
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.lang = "en-US";
    recognizer.maxAlternatives = 1;

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      recognizer.abort();
      reject(new SpeechListenError("Didn't hear anything."));
    }, timeoutMs);

    recognizer.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result?.[0]?.transcript?.trim();
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (transcript) resolve(transcript);
      else reject(new SpeechListenError("Didn't catch that."));
    };

    recognizer.onerror = (event) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new SpeechListenError(`Speech recognition error: ${event.error}`));
    };

    recognizer.onend = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new SpeechListenError("Didn't hear anything."));
    };

    try {
      recognizer.start();
    } catch (err) {
      settled = true;
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new SpeechListenError(String(err)));
    }
  });
}

/**
 * Listen continuously for up to `windowMs`, calling `onTranscript` with
 * every final phrase heard. Returns a function to stop early.
 */
export function listenWithinWindow(
  windowMs: number,
  onTranscript: (transcript: string) => void
): () => void {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return () => {};

  const recognizer = new Ctor();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = "en-US";

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    try {
      recognizer.stop();
    } catch {
      /* already stopped */
    }
  };

  recognizer.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const transcript = result[0]?.transcript?.trim();
        if (transcript) onTranscript(transcript);
      }
    }
  };
  recognizer.onerror = () => stop();
  recognizer.onend = () => {
    stopped = true;
    window.clearTimeout(timer);
  };

  const timer = window.setTimeout(stop, windowMs);

  try {
    recognizer.start();
  } catch {
    stop();
  }

  return stop;
}

let preferredVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice;
  const voices = window.speechSynthesis.getVoices();
  // Prefer a deeper/male-leaning English voice for the classic JARVIS feel;
  // fall back to whatever English voice is available, then any voice.
  preferredVoice =
    voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur|oliver/i.test(v.name)) ??
    voices.find((v) => /en/i.test(v.lang)) ??
    voices[0] ??
    null;
  return preferredVoice;
}

/** Speak `text` aloud, resolving when speech finishes (or immediately if unsupported). */
export function speak(text: string): Promise<void> {
  if (!isSpeechSynthesisSupported() || !text.trim()) return Promise.resolve();

  return new Promise((resolve) => {
    window.speechSynthesis.cancel(); // don't stack replies
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.pitch = 0.9;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) window.speechSynthesis.cancel();
}

// Some browsers (Chrome) load voices asynchronously after first paint;
// refresh our cached pick once they arrive.
if (typeof window !== "undefined" && isSpeechSynthesisSupported()) {
  window.speechSynthesis.onvoiceschanged = () => {
    preferredVoice = null;
  };
}
