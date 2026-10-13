import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ComponentProps, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import { ComposerSurface } from "../../U2/composer/composer";
import type { MentionProvider, TriggerSearchResult } from "../contract";
import { MentionComposerSlot } from "./trigger-slot";

/** The mention lists under a trigger root of their own, as the playground mounts them. */
function MentionTriggerSlot(props: ComponentProps<typeof MentionComposerSlot>) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <MentionComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

const fileProvider: MentionProvider = {
  trigger: "@",
  kind: "file",
  source: "a1.file-search",
  search: async () => [],
  searchTyped: async (query): Promise<TriggerSearchResult> => {
    if (query.trim().toLocaleLowerCase() === "none") {
      return {
        state: "unavailable",
        candidates: [],
        error: {
          state: "unavailable",
          error: {
            code: "unavailable",
            message: "Workspace file search is unavailable",
            retryable: false,
            capability: "host.file-search",
          },
        },
      };
    }
    return {
      state: "ready",
      candidates: [
        {
          id: "file:src/app.ts",
          kind: "file",
          source: "a1.file-search",
          label: "src/app.ts",
          description: "recent file",
          insertText: "@src/app.ts ",
        },
        {
          id: "file:src/application.ts",
          kind: "file",
          source: "a1.file-search",
          label: "src/application.ts",
          description: query.length === 0 ? "project file" : "fuzzy match",
          insertText: "@src/application.ts ",
        },
      ],
    };
  },
};

const githubProvider: MentionProvider = {
  trigger: "#",
  kind: "github",
  source: "a1.github-refs",
  search: async () => [],
  searchTyped: async (query): Promise<TriggerSearchResult> => {
    const trimmed = query.trim();
    const candidates =
      trimmed.length === 0
        ? [
            {
              id: "action:copy-prompt",
              kind: "prompt-action" as const,
              source: "client" as const,
              label: "Copy prompt",
              description: "local action",
              insertText: "",
              metadata: { action: "copy-prompt" },
            },
          ]
        : [
            {
              id: "github:omp-app:pr:123",
              kind: "github" as const,
              source: "a1.github-refs" as const,
              label: ["pr", ["#", "123"].join("")].join(" "),
              description: "Fix completion · open",
              insertText: ["pr://", "123", " "].join(""),
            },
            {
              id: "github:omp-app:issue:123",
              kind: "github" as const,
              source: "a1.github-refs" as const,
              label: ["issue", ["#", "123"].join("")].join(" "),
              description: "Bug report · closed",
              insertText: ["issue://", "123", " "].join(""),
            },
          ];
    return { state: "ready", candidates };
  },
};

function Playground() {
  const [selected, setSelected] = useState("No mention selected");
  const [submitted, setSubmitted] = useState("Draft ready");
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
        data-testid="d2-mentions-playground"
      >
        <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">D2.4 Mentions</h1>
            <p className="text-muted-foreground text-sm">
              @ files, {"#"} actions, and GitHub references in the real U2 composer
            </p>
          </div>
          <span className="text-muted-foreground text-xs" data-testid="mention-status">
            {submitted}
          </span>
        </header>
        <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
          <div className="border-border bg-card rounded-xl border p-4 text-sm">
            <p className="font-medium">Try a trigger</p>
            <p className="text-muted-foreground mt-1">
              Type <code>@src</code> for files or <code>{"#"}</code>123 for a GitHub issue. Arrow
              keys, Enter, Tab, and Escape work in the popover.
            </p>
            <p className="text-muted-foreground mt-3" data-testid="mention-selection">
              {selected}
            </p>
          </div>
          <MentionTriggerSlot
            providers={[fileProvider, githubProvider]}
            onSelect={(candidate) => {
              setSelected(candidate.label);
            }}
            notify={setSelected}
            fail={setSelected}
          >
            <ComposerSurface
              submitPrompt={async () => {
                setSubmitted("Submitted");
              }}
              cancel={() => undefined}
            />
          </MentionTriggerSlot>
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("d2-mentions-playground-root");
if (!root) throw new Error("D2.4 mention playground root is missing.");
createRoot(root).render(<Playground />);
