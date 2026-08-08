import { isSpeechRecognitionSupported, isSpeechSynthesisSupported } from "../services/voice";

export interface WakeWordControls {
  enabled: boolean;
  toggle: () => void;
  phrase: string;
  setPhrase: (phrase: string) => void;
  status: string;
  error: string | null;
}

export function SettingsPanel({
  open,
  onClose,
  voiceOutputEnabled,
  onToggleVoiceOutput,
  wakeWord,
  browserToolsEnabled,
}: {
  open: boolean;
  onClose: () => void;
  voiceOutputEnabled: boolean;
  onToggleVoiceOutput: (next: boolean) => void;
  wakeWord: WakeWordControls;
  browserToolsEnabled: boolean;
}) {
  if (!open) return null;

  const sttSupported = isSpeechRecognitionSupported();
  const ttsSupported = isSpeechSynthesisSupported();

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel__header">
          <h2>Settings</h2>
          <button className="settings-panel__close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <section className="settings-section">
          <h3>Wake word</h3>
          <p className="settings-section__hint">
            Clap once, then say your phrase within a few seconds. Audio never leaves your
            browser — nothing is recorded or sent anywhere.
          </p>
          {!sttSupported && (
            <p className="settings-section__warning">
              This browser doesn't support speech recognition — try Chrome or Edge.
            </p>
          )}
          <label className="settings-row">
            <span>Enable clap + wake phrase</span>
            <input
              type="checkbox"
              checked={wakeWord.enabled}
              onChange={wakeWord.toggle}
              disabled={!sttSupported}
            />
          </label>
          <label className="settings-row settings-row--column">
            <span>Wake phrase</span>
            <input
              className="settings-input"
              type="text"
              value={wakeWord.phrase}
              onChange={(e) => wakeWord.setPhrase(e.target.value)}
              placeholder="daddy's here"
            />
          </label>
          <p className="settings-status">
            Status: <strong>{wakeWord.enabled ? wakeWord.status : "off"}</strong>
            {wakeWord.error && <span className="settings-status--error"> — {wakeWord.error}</span>}
          </p>
        </section>

        <section className="settings-section">
          <h3>Voice output</h3>
          {!ttsSupported && (
            <p className="settings-section__warning">
              This browser doesn't support speech synthesis.
            </p>
          )}
          <label className="settings-row">
            <span>Speak JARVIS's replies aloud</span>
            <input
              type="checkbox"
              checked={voiceOutputEnabled}
              onChange={(e) => onToggleVoiceOutput(e.target.checked)}
              disabled={!ttsSupported}
            />
          </label>
        </section>

        <section className="settings-section">
          <h3>Tools</h3>
          <p className="settings-row">
            <span>Browser automation</span>
            <strong className={browserToolsEnabled ? "ok-text" : "warn-text"}>
              {browserToolsEnabled ? "enabled" : "disabled"}
            </strong>
          </p>
          <p className="settings-section__hint">
            Configured server-side in <code>jarvis/.env</code> (
            <code>ENABLE_BROWSER_TOOLS</code>). Browsing runs in a real, visible browser window
            so automation stays observable.
          </p>
        </section>
      </div>
    </div>
  );
}
