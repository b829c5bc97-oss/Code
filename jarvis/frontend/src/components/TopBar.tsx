import type { HealthResponse } from "../types";

export function TopBar({ health }: { health: HealthResponse | null }) {
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
      </div>
    </header>
  );
}
