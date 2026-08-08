export type AgentState =
  | "idle"
  | "thinking"
  | "executing"
  | "waiting_for_confirmation"
  | "speaking"
  | "error";

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
}

export interface ChatResponse {
  reply: string;
  state: AgentState;
  provider: string;
  session_id: string;
}

export interface HealthResponse {
  status: string;
  app_name: string;
  ai_provider: string;
  provider_ready: boolean;
  provider_error: string | null;
}
