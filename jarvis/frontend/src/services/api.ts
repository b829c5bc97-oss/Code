import type { ChatResponse, HealthResponse, MemoryEntry, SystemInfo } from "../types";

// Configurable at build time via VITE_API_BASE_URL; defaults to the local backend.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(
      "Can't reach the JARVIS backend. Is it running on " + API_BASE_URL + "?"
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail ? JSON.stringify(body.detail) : response.statusText;
    throw new ApiError(`Request to ${path} failed (${response.status}): ${detail}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function sendChatMessage(
  message: string,
  sessionId: string | null
): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, session_id: sessionId }),
  });
}

export function confirmAction(sessionId: string, approved: boolean): Promise<ChatResponse> {
  return request<ChatResponse>("/api/confirm", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, approved }),
  });
}

export function getMemories(): Promise<MemoryEntry[]> {
  return request<MemoryEntry[]>("/api/memory");
}

export function addMemory(content: string, category: string): Promise<MemoryEntry> {
  return request<MemoryEntry>("/api/memory", {
    method: "POST",
    body: JSON.stringify({ content, category }),
  });
}

export function deleteMemory(id: string): Promise<void> {
  return request<void>(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getSystemInfo(): Promise<SystemInfo> {
  return request<SystemInfo>("/api/system");
}
