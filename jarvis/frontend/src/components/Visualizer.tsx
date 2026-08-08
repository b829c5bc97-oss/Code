import type { AgentState } from "../types";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Idle",
  thinking: "Thinking…",
  executing: "Executing…",
  waiting_for_confirmation: "Needs your confirmation",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export function Visualizer({ state }: { state: AgentState }) {
  return (
    <div className={`visualizer visualizer--${state}`} role="img" aria-label={STATE_LABEL[state]}>
      <div className="visualizer__ring visualizer__ring--outer" />
      <div className="visualizer__ring visualizer__ring--mid" />
      <div className="visualizer__core" />
      <p className="visualizer__label">{STATE_LABEL[state]}</p>
    </div>
  );
}
