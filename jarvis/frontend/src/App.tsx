import { useState } from "react";
import { ActivityLog } from "./components/ActivityLog";
import { ConfirmationBar } from "./components/ConfirmationBar";
import { ConversationPanel } from "./components/ConversationPanel";
import { InputBar } from "./components/InputBar";
import { MemoryPanel } from "./components/MemoryPanel";
import { PlanPanel } from "./components/PlanPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SystemStatus } from "./components/SystemStatus";
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
    plan,
    voiceOutputEnabled,
    setVoiceOutputEnabled,
    send,
    confirmPending,
    startVoiceCommand,
    clearError,
  } = useJarvis();
  const wakeWord = useWakeWord(startVoiceCommand);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <div className="app">
      <TopBar
        health={health}
        wakeWordEnabled={wakeWord.enabled}
        wakeWordStatus={wakeWord.status}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMemory={() => setMemoryOpen(true)}
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
          <div className="app__strip">
            <PlanPanel plan={plan} />
            <ActivityLog activity={toolActivity} />
            <SystemStatus enabled={health?.system_tools_enabled ?? false} />
          </div>
        </div>

        <ConversationPanel messages={messages} />
      </main>

      <div className="app__input">
        {state === "waiting_for_confirmation" && <ConfirmationBar onConfirm={confirmPending} />}
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
      <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </div>
  );
}
