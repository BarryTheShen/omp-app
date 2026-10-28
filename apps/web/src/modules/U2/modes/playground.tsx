import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerSurface } from "../composer/composer";
import type { PromptIntent } from "../contract";
import { ModeIndicator } from "./mode-indicator";
import { modeForText, parseComposerMode, submitModeInput } from "./modes";

const capabilities: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "omp" },
  "omp.cmd.bash": { state: "available", via: "omp" },
  "upstream.python-mode": {
    state: "unavailable",
    via: "upstream",
    detail: "Python mode is not released",
  },
};

function PlaygroundBody({ setLastSubmit }: { readonly setLastSubmit: (value: string) => void }) {
  const text = useAuiState((state) => state.composer.text);
  const mode = modeForText(text);
  const submitPrompt = async (intent: PromptIntent): Promise<void> => {
    const parsed = parseComposerMode(intent.text);
    await submitModeInput(parsed, "new", capabilities, async (submitted) => {
      setLastSubmit(`${submitted.mode}: ${submitted.text}`);
    });
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="u2-modes-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">U2.6 Composer Modes</h1>
          <p className="text-muted-foreground text-sm">
            Bash/Python mode handoff through PromptIntent
          </p>
        </div>
        <span data-testid="mode-label" className="text-muted-foreground text-xs">
          {mode}
        </span>
      </header>
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
        <ComposerSurface submitPrompt={submitPrompt} cancel={async () => undefined}>
          <ModeIndicator capabilities={capabilities} />
        </ComposerSurface>
      </section>
    </main>
  );
}

function Playground() {
  const [lastSubmit, setLastSubmit] = useState("Nothing submitted");
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PlaygroundBody setLastSubmit={setLastSubmit} />
      <p data-testid="last-submit" className="text-muted-foreground text-sm">
        {lastSubmit}
      </p>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("u2-modes-playground-root");
if (!root) throw new Error("U2.6 modes playground root is missing.");
createRoot(root).render(<Playground />);
