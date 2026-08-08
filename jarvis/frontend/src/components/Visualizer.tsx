import type { AgentState } from "../types";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Standing by",
  listening: "Listening…",
  thinking: "Thinking…",
  executing: "Executing…",
  waiting_for_confirmation: "Needs your input",
  speaking: "Speaking…",
  error: "Something went wrong",
};

const TICKS = Array.from({ length: 24 }, (_, i) => i);

export function Visualizer({ state }: { state: AgentState }) {
  return (
    <div className={`visualizer visualizer--${state}`}>
      <svg className="visualizer__svg" viewBox="0 0 300 300" role="img" aria-label={STATE_LABEL[state]}>
        <defs>
          <radialGradient id="core-cyan" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#eafcff" />
            <stop offset="45%" stopColor="#4fd6ff" />
            <stop offset="100%" stopColor="#1c6fa8" />
          </radialGradient>
          <radialGradient id="core-amber" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#fff6e0" />
            <stop offset="45%" stopColor="#ffc857" />
            <stop offset="100%" stopColor="#a56a12" />
          </radialGradient>
          <radialGradient id="core-red" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffe9ea" />
            <stop offset="45%" stopColor="#ff6b7a" />
            <stop offset="100%" stopColor="#8f2530" />
          </radialGradient>
        </defs>

        {/* outer tick dial */}
        <g className="visualizer__ticks">
          {TICKS.map((i) => {
            const angle = (i / TICKS.length) * 360;
            const long = i % 6 === 0;
            return (
              <line
                key={i}
                x1="150"
                y1={long ? "10" : "18"}
                x2="150"
                y2="26"
                transform={`rotate(${angle} 150 150)`}
                className={long ? "tick tick--long" : "tick"}
              />
            );
          })}
        </g>

        <circle className="visualizer__ring visualizer__ring--outer" cx="150" cy="150" r="128" />
        <circle className="visualizer__ring visualizer__ring--mid" cx="150" cy="150" r="104" />
        <circle className="visualizer__ring visualizer__ring--scan" cx="150" cy="150" r="116" />

        <g className="visualizer__hex">
          <polygon points="150,68 197,95 197,150 150,177 103,150 103,95" />
        </g>

        <circle className="visualizer__core visualizer__core--cyan" cx="150" cy="150" r="58" fill="url(#core-cyan)" />
        <circle className="visualizer__core visualizer__core--amber" cx="150" cy="150" r="58" fill="url(#core-amber)" />
        <circle className="visualizer__core visualizer__core--red" cx="150" cy="150" r="58" fill="url(#core-red)" />
      </svg>
      <p className="visualizer__label">{STATE_LABEL[state]}</p>
    </div>
  );
}
