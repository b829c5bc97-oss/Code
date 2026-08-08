import { useEffect, useRef } from "react";
import type { Message } from "../types";

export function ConversationPanel({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  return (
    <aside className="panel conversation-panel">
      <h2 className="panel__title">Conversation</h2>
      <div className="conversation-panel__list">
        {messages.length === 0 && (
          <p className="conversation-panel__empty">
            Say hello — try "What can you do?" or "Open Chrome" (computer control lands in a
            later phase).
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`message message--${message.role}`}>
            <span className="message__role">
              {message.role === "user" ? "You" : "JARVIS"}
            </span>
            <p className="message__content">{message.content}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </aside>
  );
}
