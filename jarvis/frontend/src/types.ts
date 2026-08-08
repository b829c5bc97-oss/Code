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
  plan: string[];
}

export interface HealthResponse {
  status: string;
  app_name: string;
  ai_provider: string;
  provider_ready: boolean;
  provider_error: string | null;
  browser_tools_enabled: boolean;
  computer_tools_enabled: boolean;
  memory_tools_enabled: boolean;
  file_tools_enabled: boolean;
  code_tools_enabled: boolean;
  document_tools_enabled: boolean;
  system_tools_enabled: boolean;
}

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "task",
  "project",
  "app",
  "context",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  created_at: string;
}

export interface SystemInfo {
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  battery: { percent: number; plugged_in: boolean } | null;
  network_up: boolean;
  top_processes: { name: string; memory_percent: number }[];
}
