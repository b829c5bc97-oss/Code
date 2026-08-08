import type { HealthResponse } from "../types";

export function TopBar({
  health,
  wakeWordEnabled,
  wakeWordStatus,
  onOpenSettings,
}: {
  health: HealthResponse | null;
  wakeWordEnabled: boolean;
  wakeWordStatus: string;
  onOpenSettings: () => void;
}) {
  const connected = health !== null;
  const providerReady = health?.provider_ready ?? false;

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__dot" />
        JARVIS
      </div>
      <div className="top-bar__status">
        <span className={`status-pill ${connected ? "status-pill--ok" : "status-pill--down"}`}>
          {connected ? "Backend connected" : "Backend unreachable"}
        </span>
        {connected && (
          <span
            className={`status-pill ${providerReady ? "status-pill--ok" : "status-pill--warn"}`}
            title={health?.provider_error ?? undefined}
          >
            AI: {health?.ai_provider}
            {!providerReady && " (not configured)"}
          </span>
        )}
        {wakeWordEnabled && (
          <span className="status-pill status-pill--mic" title="Microphone is active for wake-word detection">
            <span className={`status-pill__mic-dot ${wakeWordStatus === "armed" ? "armed" : ""}`} />
            Mic: {wakeWordStatus}
          </span>
        )}
        <button className="top-bar__settings" onClick={onOpenSettings} aria-label="Open settings">
          ⚙
        </button>
      </div>
    </header>
  );
}
