import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getHealth, sendChatMessage } from "../services/api";
import type { AgentState, HealthResponse, Message } from "../types";

const SESSION_STORAGE_KEY = "jarvis.session_id";

function makeId(): string {
  return crypto.randomUUID();
}

export function useJarvis() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<AgentState>("idle");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef<string | null>(
    typeof window !== "undefined" ? window.localStorage.getItem(SESSION_STORAGE_KEY) : null
  );

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", content: trimmed, timestamp: Date.now() },
    ]);
    setState("thinking");

    try {
      const response = await sendChatMessage(trimmed, sessionId.current);
      sessionId.current = response.session_id;
      window.localStorage.setItem(SESSION_STORAGE_KEY, response.session_id);

      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "assistant",
          content: response.reply,
          timestamp: Date.now(),
        },
      ]);
      setState(response.state === "error" ? "error" : "speaking");
      // Return to idle once the "speaking" beat has been shown.
      window.setTimeout(() => setState((s) => (s === "speaking" ? "idle" : s)), 1200);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong.";
      setError(message);
      setState("error");
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { messages, state, health, error, send, clearError };
}
