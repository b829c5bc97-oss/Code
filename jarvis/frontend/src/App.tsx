import { ConversationPanel } from "./components/ConversationPanel";
import { InputBar } from "./components/InputBar";
import { TopBar } from "./components/TopBar";
import { Visualizer } from "./components/Visualizer";
import { useJarvis } from "./hooks/useJarvis";

export default function App() {
  const { messages, state, health, error, send, clearError } = useJarvis();

  return (
    <div className="app">
      <TopBar health={health} />

      <main className="app__main">
        <section className="app__stage">
          <Visualizer state={state} />
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={clearError} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
        </section>

        <ConversationPanel messages={messages} />
      </main>

      <div className="app__input">
        <InputBar state={state} onSend={send} />
      </div>
    </div>
  );
}
