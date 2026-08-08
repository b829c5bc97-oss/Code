import { useCallback, useEffect, useRef, useState } from "react";
import { WakeWordDetector, type WakeWordStatus } from "../services/wakeWord";

const ENABLED_KEY = "jarvis.wake_word_enabled";
const PHRASE_KEY = "jarvis.wake_phrase";
const DEFAULT_PHRASE = "daddy's here";

export function useWakeWord(onWake: () => void) {
  const [enabled, setEnabled] = useState(
    () => window.localStorage.getItem(ENABLED_KEY) === "true"
  );
  const [phrase, setPhraseState] = useState(
    () => window.localStorage.getItem(PHRASE_KEY) || DEFAULT_PHRASE
  );
  const [status, setStatus] = useState<WakeWordStatus>("stopped");
  const [error, setError] = useState<string | null>(null);
  const detectorRef = useRef<WakeWordDetector | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const isFirstPhraseRender = useRef(true);

  const stopDetector = useCallback(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;
  }, []);

  const startDetector = useCallback((activePhrase: string) => {
    stopDetector();
    setError(null);
    const detector = new WakeWordDetector({
      phrase: activePhrase,
      onWake: () => onWakeRef.current(),
      onStatusChange: (s, detail) => {
        setStatus(s);
        if (s === "error") setError(detail ?? "Microphone error.");
      },
    });
    detectorRef.current = detector;
    detector.start().catch(() => {
      setEnabled(false);
    });
  }, [stopDetector]);

  useEffect(() => {
    window.localStorage.setItem(ENABLED_KEY, String(enabled));
    if (enabled) startDetector(phrase);
    else stopDetector();
    return () => stopDetector();
    // Re-run when `enabled` flips; `phrase` changes are handled below so we
    // don't tear down/relaunch the mic stream on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    window.localStorage.setItem(PHRASE_KEY, phrase);
    if (isFirstPhraseRender.current) {
      isFirstPhraseRender.current = false;
      return;
    }
    if (enabled) startDetector(phrase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrase]);

  const toggle = useCallback(() => setEnabled((e) => !e), []);
  const setPhrase = useCallback((next: string) => setPhraseState(next || DEFAULT_PHRASE), []);

  return { enabled, toggle, phrase, setPhrase, status, error };
}
