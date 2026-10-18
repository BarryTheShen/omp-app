import type { RealToolResult } from "../../U3/tool-card/real-result";

/** Source-derived spawn result; omp's acknowledgment and details are from tools/vibe.ts:100-103. */
export const T5_VIBE_SPAWN_SOURCE_RESULTS: readonly RealToolResult[] = [
  {
    name: "vibe_spawn: a worker started (source-derived)",
    toolName: "vibe_spawn",
    args: { cli: "fast", name: "worker-3", prompt: "Run the unit tests." },
    result: {
      content: [{ type: "text", text: "Spawned `worker-3` (job `job-8`)." }],
      details: { op: "spawn", spawned: { id: "fast-3", cli: "fast", jobId: "job-8" } },
    },
    isError: false,
    shows: ["worker-3", "job-8"],
  },
];
