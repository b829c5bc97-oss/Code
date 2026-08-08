import { useState } from "react";
import type { FormEvent } from "react";
import type { AgentState } from "../types";

export function InputBar({
  state,
  onSend,
}: {
  state: AgentState;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const busy = state === "thinking" || state === "executing";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    onSend(value);
    setValue("");
  }

  return (
    <form className="input-bar" onSubmit={handleSubmit}>
      <button
        type="button"
        className="input-bar__mic"
        title="Voice input arrives in a later phase"
        disabled
        aria-disabled="true"
      >
        🎙
      </button>
      <input
        className="input-bar__field"
        placeholder="Ask JARVIS anything…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        autoFocus
      />
      <button className="input-bar__send" type="submit" disabled={busy || !value.trim()}>
        {busy ? "…" : "Send"}
      </button>
    </form>
  );
}
