import { z } from "zod";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRegistryDescriptor, ToolRenderer } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";

/**
 * omp's `vibe_spawn` result names the new session under `spawned` (omp v18.6.1 `tools/vibe.ts`).
 * A call omp skipped or failed before it started a worker has no `spawned`.
 */
const VibeSpawnDetailsSchema = z.looseObject({
  spawned: z
    .looseObject({
      id: z.string().optional(),
      cli: z.string().optional(),
      jobId: z.string().optional(),
    })
    .optional(),
});

/** Read-only summary of a spawn. The card never starts or controls a worker. */
export const VibeSpawnRenderer: ToolRenderer = (props) => {
  const state = normalizeToolRendererProps(props);
  const split = splitToolResult(props.result ?? state.result ?? state.partialResult);
  const parsed = VibeSpawnDetailsSchema.safeParse(split.details);
  const spawned = parsed.success ? parsed.data.spawned : undefined;
  let summary = "Vibe worker";
  if (spawned?.id !== undefined) summary = `Vibe worker ${spawned.id}`;
  else if (state.phase === "error") summary = "Vibe worker not started";
  return (
    <div data-slot="t5-vibe-spawn-card" data-testid="t5-vibe-spawn-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        rawResult={split.text}
        state={state}
        summary={summary}
      />
      <section className="border-border/70 ms-2 flex min-w-0 flex-col gap-2 border-s-2 py-2 ps-4">
        {spawned !== undefined && (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {spawned.cli !== undefined && <span>CLI: {spawned.cli}</span>}
            {spawned.jobId !== undefined && <span>Turn job: {spawned.jobId}</span>}
          </div>
        )}
        {state.phase !== "error" && split.text.trim().length > 0 && (
          <TextOutput text={split.text} testId="t5-vibe-spawn-text" />
        )}
      </section>
    </div>
  );
};

export const VIBE_SPAWN_DESCRIPTOR = {
  kind: "tool",
  id: "T5.vibeSpawn",
  owner: "T5",
  title: "Spawn vibe worker",
  covers: ["T5.vibe-spawn"],
  requires: [],
  match: { by: "name", name: "vibe_spawn" },
  renderer: VibeSpawnRenderer,
} as const satisfies ToolRegistryDescriptor;
