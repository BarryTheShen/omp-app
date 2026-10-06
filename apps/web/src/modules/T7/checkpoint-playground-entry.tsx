import { createRoot } from "react-dom/client";
import "../../index.css";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { CheckpointCard, RewindCard } from "./checkpoint";

function props(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const report = [
  "Cache misses come from the key builder, not the eviction policy.",
  "",
  "- `buildKey` drops the locale, so every locale shares one entry.",
  "- The fix belongs in `src/cache/key.ts`; eviction can stay as it is.",
].join("\n");

function CheckpointPlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t7-checkpoint-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-4xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">Checkpoint and rewind cards</h1>
        <p className="text-muted-foreground text-sm">
          A checkpoint, a rewind with its report and a checkpoint in progress
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-4xl flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6">
        <CheckpointCard
          rendererProps={props(
            "checkpoint-done",
            "checkpoint",
            { goal: "find why the cache misses after deploys" },
            {
              content: [
                {
                  type: "text",
                  text: "Checkpoint: find why the cache misses after deploys\nFinish exploration and formulate findings.",
                },
              ],
              details: {
                goal: "find why the cache misses after deploys",
                startedAt: "2026-10-05T12:00:00.000Z",
              },
            },
          )}
        />
        <RewindCard
          rendererProps={props(
            "rewind-report",
            "rewind",
            { report },
            {
              content: [
                {
                  type: "text",
                  text: "Rewind requested.\nReport captured for context replacement.",
                },
              ],
              details: { report, rewound: true },
            },
          )}
        />
        <CheckpointCard
          rendererProps={props(
            "checkpoint-running",
            "checkpoint",
            { goal: "try the streaming parser" },
            undefined,
            { type: "running" },
          )}
        />
      </section>
    </main>
  );
}

const root = document.getElementById("t7-checkpoint-playground-root");
if (!root) throw new Error("The checkpoint playground root is missing.");
createRoot(root).render(<CheckpointPlayground />);
