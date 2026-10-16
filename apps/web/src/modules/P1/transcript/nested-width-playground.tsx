import { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentRefSchema,
  type FocusedAgentRuntime,
  SubagentTranscriptPageSchema,
} from "@/modules/P1/contract";
import { NestedAgentTranscript } from "./nested-view";

const THREAD_ID = ThreadId.parse("thread-nested-width-check");

function runtimeFor(name: string, index: number): FocusedAgentRuntime {
  const id = SubagentId.parse(name.replaceAll(".", "-"));
  const sessionFile = SessionFilePath.parse(`/workspace/${id}.jsonl`);
  const agent = AgentRefSchema.parse({
    id,
    index,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: 1_759_600_000_000,
    description: name,
    sessionFile,
    threadId: THREAD_ID,
  });
  return {
    agent,
    read: async ({ fromByte = 0 } = {}) =>
      SubagentTranscriptPageSchema.parse({
        sessionFile,
        fromByte,
        nextByte: fromByte,
        reset: false,
        entries: [],
        messages: [],
      }),
    subscribe: () => () => undefined,
    cancel: async () => ({ cancelled: true }),
    steer: async () => {},
  };
}

function WidthPlayground() {
  const parent = useMemo(() => runtimeFor("NestedParent", 0), []);
  const child = useMemo(() => runtimeFor("NestedParent.NestedChild.NestedParent", 1), []);

  return (
    <main className="mx-auto flex min-h-screen w-full min-w-0 max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-foreground text-lg font-semibold">Nested worker width check</h1>
      <section
        className="border-border bg-background flex min-w-0 flex-col gap-2 rounded-lg border"
        data-testid="depth-one-card"
      >
        <NestedAgentTranscript controls source={parent} />
        <section
          className="border-border bg-background ms-4 flex min-w-0 flex-col rounded-lg border"
          data-testid="depth-two-card"
        >
          <NestedAgentTranscript controls depth={2} source={child} />
        </section>
      </section>
    </main>
  );
}

const root = document.getElementById("nested-width-root");
if (!root) throw new Error("The nested worker width check root is missing.");
createRoot(root).render(<WidthPlayground />);
