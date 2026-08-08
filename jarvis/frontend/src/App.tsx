import { useState } from "react";
import { ActivityLog } from "./components/ActivityLog";
import { ConversationPanel } from "./components/ConversationPanel";
import { InputBar } from "./components/InputBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopBar } from "./components/TopBar";
import { Visualizer } from "./components/Visualizer";
import { useJarvis } from "./hooks/useJarvis";
import { useWakeWord } from "./hooks/useWakeWord";

export default function App() {
  const {
    messages,
    state,
    health,
    error,
    toolActivity,
    voiceOutputEnabled,
    setVoiceOutputEnabled,
    send,
    startVoiceCommand,
    clearError,
  } = useJarvis();
  const wakeWord = useWakeWord(startVoiceCommand);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="app">
      <TopBar
        health={health}
        wakeWordEnabled={wakeWord.enabled}
        wakeWordStatus={wakeWord.status}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="app__main">
        <div className="app__center">
          <section className="app__stage">
            <div className="hud-corner hud-corner--tl" />
            <div className="hud-corner hud-corner--tr" />
            <div className="hud-corner hud-corner--bl" />
            <div className="hud-corner hud-corner--br" />
            <Visualizer state={state} />
            {error && (
              <div className="error-banner" role="alert">
                {error}
                <button onClick={clearError} aria-label="Dismiss">
                  ×
                </button>
              </div>
            )}
          </section>
          <ActivityLog activity={toolActivity} />
        </div>

        <ConversationPanel messages={messages} />
      </main>

      <div className="app__input">
        <InputBar state={state} onSend={send} onStartVoiceCommand={startVoiceCommand} />
      </div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        voiceOutputEnabled={voiceOutputEnabled}
        onToggleVoiceOutput={setVoiceOutputEnabled}
        wakeWord={wakeWord}
        browserToolsEnabled={health?.browser_tools_enabled ?? false}
      />
    </div>
  );
}
