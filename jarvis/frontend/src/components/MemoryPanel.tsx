import { useEffect, useState } from "react";
import { addMemory, deleteMemory, getMemories } from "../services/api";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry } from "../types";

export function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("fact");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getMemories()
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load memory."))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newContent.trim()) return;
    try {
      const entry = await addMemory(newContent.trim(), newCategory);
      setEntries((prev) => [...prev, entry]);
      setNewContent("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMemory(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that.");
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel__header">
          <h2>Memory</h2>
          <button className="settings-panel__close" onClick={onClose} aria-label="Close memory panel">
            ×
          </button>
        </div>

        <p className="settings-section__hint">
          What JARVIS remembers about you across conversations. Nothing here is sent anywhere
          except to the AI provider as context for your own requests.
        </p>

        <form className="memory-add" onSubmit={handleAdd}>
          <input
            className="settings-input"
            placeholder="Remember something…"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <select
            className="settings-input"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
          >
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button className="memory-add__button" type="submit" disabled={!newContent.trim()}>
            Add
          </button>
        </form>

        {error && <p className="settings-status settings-status--error">{error}</p>}
        {loading && <p className="settings-status">Loading…</p>}

        <div className="memory-list">
          {entries.length === 0 && !loading && (
            <p className="settings-section__hint">Nothing remembered yet.</p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className="memory-item">
              <div className="memory-item__body">
                <span className="memory-item__category">{entry.category}</span>
                <p className="memory-item__content">{entry.content}</p>
              </div>
              <button
                className="memory-item__delete"
                onClick={() => handleDelete(entry.id)}
                aria-label={`Forget: ${entry.content}`}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
