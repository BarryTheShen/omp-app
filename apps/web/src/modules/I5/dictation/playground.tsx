import type { ChatModelAdapter } from "@assistant-ui/react";
import { AssistantRuntimeProvider, ComposerPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserDictationPort } from "./adapter";
import { dictationViews } from "./dictation-control";

const DictationControl = dictationViews.control;
function DictationPlayground() {
  const [sends, setSends] = useState(0);
  const dictation = useMemo(() => createBrowserDictationPort(), []);
  const chatModel: ChatModelAdapter = useMemo(
    () => ({
      run: async () => {
        setSends((count) => count + 1);
        return { content: [] };
      },
    }),
    [],
  );
  const runtime = useLocalRuntime(chatModel, { adapters: { dictation } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="min-h-screen bg-background p-4 text-foreground"
        data-testid="i5-3-dictation-playground"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <h1 className="text-xl font-semibold">Voice input</h1>
          <p className="text-sm text-muted-foreground">
            Dictation adds editable words to the message. It never sends them by itself.
          </p>
          <ComposerPrimitive.Root className="flex flex-col gap-3">
            <ComposerPrimitive.Input aria-label="Message input" placeholder="Send a message..." />
            <div className="flex flex-wrap items-center gap-2">
              <DictationControl adapter={dictation} mode="push-to-talk" />
              <DictationControl adapter={dictation} mode="toggle" />
              <ComposerPrimitive.Send>Send message</ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
          <p
            aria-live="polite"
            className="text-sm text-muted-foreground"
            data-testid="i5-3-send-count"
            role="status"
          >
            Messages sent: {sends}
          </p>
        </div>
      </main>
    </AssistantRuntimeProvider>
  );
}

export function I5DictationPlayground() {
  return <DictationPlayground />;
}

const root = document.getElementById("root");
if (!root) throw new Error("The dictation playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <I5DictationPlayground />
  </StrictMode>,
);
