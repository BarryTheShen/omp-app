import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { ComposerSurface } from "../composer/composer";
import { ExternalEditorButton } from "../external-editor/editor";
import { PromptHistorySlot, type PromptHistorySource } from "./history";

const source: PromptHistorySource = {
  getUserPrompts: () => ["first historical prompt", "second historical prompt"],
  subscribe: () => () => undefined,
};

function EditorButton() {
  const composer = useAui().composer;
  const text = useAuiState((state) => state.composer.text);
  return (
    <ExternalEditorButton
      text={text}
      onText={(next) => composer.setText(next)}
      onError={() => undefined}
    />
  );
}

function Playground() {
  const [submitted, setSubmitted] = useState("Draft ready");
  const runtime = useExternalStoreRuntime({
    messages: useMemo<readonly ThreadMessage[]>(() => [], []),
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="min-h-screen bg-background text-foreground"
        data-testid="u2-history-playground"
      >
        <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">U2.5 History and editor</h1>
            <p className="text-muted-foreground text-sm">
              Up/Down prompt history and host editor capability
            </p>
          </div>
          <span className="text-muted-foreground text-xs" data-testid="history-status">
            {submitted}
          </span>
        </header>
        <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
          <div className="border-border bg-card rounded-xl border p-4 text-sm">
            <p className="font-medium">Composer controls</p>
            <p className="text-muted-foreground mt-1">
              At an empty boundary, ArrowUp recalls a prior prompt; ArrowDown restores the draft.
            </p>
          </div>
          <PromptHistorySlot source={source}>
            <ComposerSurface
              submitPrompt={async () => setSubmitted("Submitted")}
              cancel={() => undefined}
            >
              <EditorButton />
            </ComposerSurface>
          </PromptHistorySlot>
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("u2-history-playground-root");
if (!root) throw new Error("U2.5 history playground root is missing.");
createRoot(root).render(<Playground />);
