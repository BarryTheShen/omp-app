import type { OmpWire } from "@omp-app/contracts";
import { ThinkingSelector } from "./selector";
import { type LiveThinkingState, ThinkingLevelsController } from "./thinking";

const liveState: LiveThinkingState = {
  getSnapshot: () => ({ current: "medium", configured: "auto", reasoning: true }),
  subscribe: () => () => undefined,
};

const source = {
  getAvailableLevels: async () => ["low", "medium", "high"] as OmpWire.ThinkingLevel[],
  setLevel: async (_level: OmpWire.ThinkingLevel) => undefined,
  cycleLevel: async () => ({ level: "high" as OmpWire.Effort }),
};

const controller = new ThinkingLevelsController({
  source,
  live: liveState,
  capabilities: {
    "omp.cmd.get_available_thinking_levels": { state: "available", via: "rpc" },
    "omp.cmd.set_thinking_level": { state: "available", via: "rpc" },
    "omp.cmd.cycle_thinking_level": { state: "available", via: "rpc" },
  },
});

export function ThinkingPlayground() {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-xl">
        <ThinkingSelector controller={controller} />
      </div>
    </main>
  );
}
