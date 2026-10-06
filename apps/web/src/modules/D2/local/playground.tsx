import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { ComposerSurface } from "../../U2/composer/composer";
import { createEmojiProvider } from "./emoji";
import type { LocalProvider } from "./provider";
import { LocalTriggerSlot } from "./trigger-slot";

const urlProvider: LocalProvider = {
  trigger: "skill://",
  kind: "internal-url",
  source: "a1.url-catalog",
  search: async () => [],
  // The playground has no server: it shows what the provider returns for a typed `skill://`.
  searchTyped: async () => ({
    state: "ready",
    candidates: [
      {
        id: "url:skill://review",
        kind: "internal-url",
        source: "a1.url-catalog",
        label: "Review skill",
        description: "Skill · Reviews a change before you merge it",
        insertText: "skill://review ",
      },
      {
        id: "url:skill://commit",
        kind: "internal-url",
        source: "a1.url-catalog",
        label: "Commit skill",
        description: "Skill · Writes a commit message from the staged diff",
        insertText: "skill://commit ",
      },
    ],
  }),
};

function Playground() {
  const [selected, setSelected] = useState("No local expansion selected");
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="min-h-screen bg-background text-foreground"
        data-testid="d2-local-playground"
      >
        <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Emoji and internal links</h1>
            <p className="text-muted-foreground text-sm">
              Emoji shortcodes and omp's internal links (skills, rules, files) in the composer
            </p>
          </div>
          <span className="text-muted-foreground text-xs" data-testid="local-selection">
            {selected}
          </span>
        </header>
        <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
          <div className="border-border bg-card rounded-xl border p-4 text-sm">
            <p className="font-medium">Try a local trigger</p>
            <p className="text-muted-foreground mt-1">
              Type <code>:smil</code> for emoji or <code>skill://</code> for skills. Code spans keep
              their text unchanged.
            </p>
          </div>
          <LocalTriggerSlot
            providers={[createEmojiProvider(), urlProvider]}
            onSelect={(candidate) => setSelected(candidate.label)}
          >
            <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
          </LocalTriggerSlot>
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("d2-local-playground-root");
if (!root) throw new Error("D2.5 local playground root is missing.");
createRoot(root).render(<Playground />);
