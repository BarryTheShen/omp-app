import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ComposerSurface } from "./composer";

function Playground() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMode, setErrorMode] = useState(false);
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isStreaming,
    onNew: async () => undefined,
    onCancel: async () => {
      setIsStreaming(false);
    },
  });
  const submitPrompt = async (_intent: PromptIntent): Promise<void> => {
    if (errorMode) {
      throw new AppFailure({
        code: "permission",
        message: "The playground rejected this prompt",
        retryable: false,
      });
    }
    setIsStreaming(true);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="min-h-screen bg-background text-foreground"
        data-testid="u2-composer-playground"
      >
        <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">U2.2 ComposerSurface</h1>
            <p className="text-muted-foreground text-sm">
              Assistant-ui composer contract playground
            </p>
          </div>
          <span className="text-muted-foreground text-xs" data-testid="playground-status">
            {errorMode ? "error" : isStreaming ? "streaming" : "idle"}
          </span>
        </header>
        <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
          <div className="border-border bg-card rounded-xl border p-4 text-sm">
            <p className="font-medium">State controls</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="playground-idle"
                className="border-border rounded-md border px-3 py-2 text-sm"
                onClick={() => {
                  setErrorMode(false);
                  setIsStreaming(false);
                }}
              >
                Idle
              </button>
              <button
                type="button"
                data-testid="playground-streaming"
                className="border-border rounded-md border px-3 py-2 text-sm"
                onClick={() => {
                  setErrorMode(false);
                  setIsStreaming(true);
                }}
              >
                Streaming
              </button>
              <button
                type="button"
                data-testid="playground-error"
                className="border-border rounded-md border px-3 py-2 text-sm"
                onClick={() => {
                  setErrorMode(true);
                  setIsStreaming(false);
                }}
              >
                Error on send
              </button>
            </div>
          </div>
          <ComposerSurface
            submitPrompt={submitPrompt}
            cancel={async () => {
              setIsStreaming(false);
            }}
          />
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("u2-composer-playground-root");
if (!root) throw new Error("U2.2 composer playground root is missing.");
createRoot(root).render(<Playground />);
