import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, confirmAction, getHealth, sendChatMessage } from "../services/api";
import { listenOnce, speak, stopSpeaking } from "../services/voice";
import type { AgentState, ChatResponse, HealthResponse, Message, ToolActivity } from "../types";

const SESSION_STORAGE_KEY = "jarvis.session_id";
const VOICE_OUTPUT_KEY = "jarvis.voice_output_enabled";

function makeId(): string {
  return crypto.randomUUID();
}

export function useJarvis() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<AgentState>("idle");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [plan, setPlan] = useState<string[]>([]);
  const [voiceOutputEnabled, setVoiceOutputEnabled] = useState<boolean>(
    () => window.localStorage.getItem(VOICE_OUTPUT_KEY) !== "false"
  );
  const sessionId = useRef<string | null>(
    typeof window !== "undefined" ? window.localStorage.getItem(SESSION_STORAGE_KEY) : null
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    window.localStorage.setItem(VOICE_OUTPUT_KEY, String(voiceOutputEnabled));
    if (!voiceOutputEnabled) stopSpeaking();
  }, [voiceOutputEnabled]);

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

  /** Shared tail-end handling for both /api/chat and /api/confirm responses. */
  const applyResponse = useCallback(
    async (response: ChatResponse) => {
      sessionId.current = response.session_id;
      window.localStorage.setItem(SESSION_STORAGE_KEY, response.session_id);
      setToolActivity(response.tool_activity ?? []);
      setPlan(response.plan ?? []);

      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: "assistant", content: response.reply, timestamp: Date.now() },
      ]);

      if (response.state === "error" || response.state === "waiting_for_confirmation") {
        setState(response.state);
        return;
      }

      if (voiceOutputEnabled) {
        setState("speaking");
        await speak(response.reply);
        setState((s) => (s === "speaking" ? "idle" : s));
      } else {
        setState("idle");
      }
    },
    [voiceOutputEnabled]
  );

  const send = useCallback(
    async (text: string) => {
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
        await applyResponse(response);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Something went wrong.";
        setError(message);
        setState("error");
      }
    },
    [applyResponse]
  );

  /** Approve or deny a pending HIGH-risk (or opted-in MEDIUM-risk) tool call. */
  const confirmPending = useCallback(
    async (approved: boolean) => {
      if (!sessionId.current) return;
      setState("executing");
      try {
        const response = await confirmAction(sessionId.current, approved);
        await applyResponse(response);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Something went wrong.";
        setError(message);
        setState("error");
      }
    },
    [applyResponse]
  );

  /** Triggered by the wake word (clap + phrase) or the mic button: capture one spoken command. */
  const startVoiceCommand = useCallback(async () => {
    if (stateRef.current === "listening" || stateRef.current === "thinking") return;
    setError(null);
    setState("listening");
    if (voiceOutputEnabled) await speak("Yes?");
    try {
      const transcript = await listenOnce(7000);
      await send(transcript);
    } catch (err) {
      setState("idle");
      setError(err instanceof Error ? err.message : "Didn't catch that.");
    }
  }, [send, voiceOutputEnabled]);

  const clearError = useCallback(() => setError(null), []);

  return {
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
  };
}
