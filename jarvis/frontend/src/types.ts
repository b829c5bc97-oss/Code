export type AgentState =
  | "idle"
  | "listening" // client-only: capturing a voice command, backend never returns this
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

export interface ToolActivity {
  name: string;
  success: boolean;
  summary: string;
}

export interface ChatResponse {
  reply: string;
  state: Exclude<AgentState, "listening">;
  provider: string;
  session_id: string;
  tool_activity: ToolActivity[];
}

export interface HealthResponse {
  status: string;
  app_name: string;
  ai_provider: string;
  provider_ready: boolean;
  provider_error: string | null;
  browser_tools_enabled: boolean;
}
