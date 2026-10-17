import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EffortLevel, ModelCatalogPort, ModelCatalogSnapshot } from "@/modules/D1/contract";
import { ExecutionTierSlider } from "./view";

const THREE_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];
const SIX_LEVELS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function catalogFor(efforts: readonly EffortLevel[]): ModelCatalogPort {
  const snapshot: ModelCatalogSnapshot = {
    loadState: "ready",
    models: [
      {
        provider: "fake",
        id: "reasoning",
        name: "Reasoning",
        api: "chat-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingEfforts: [...efforts],
        availability: "available",
      },
    ],
    current: { provider: "fake", modelId: "reasoning" },
    capabilities: {},
    error: null,
  };
  return {
    getSnapshot: () => snapshot,
    refresh: async () => ({}) as never,
    apply: async () => ({}) as never,
    subscribe: () => () => undefined,
  };
}

type SceneProps = {
  readonly title: string;
  readonly efforts: readonly EffortLevel[];
  readonly initial: EffortLevel;
  readonly error?: string;
};

function Scene({ title, efforts, initial, error }: SceneProps) {
  const catalog = useMemo(() => catalogFor(efforts), [efforts]);
  const [value, setValue] = useState<EffortLevel>(initial);
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4">
        <ExecutionTierSlider catalog={catalog} error={error} value={value} onChange={setValue} />
      </div>
    </section>
  );
}

function Playground() {
  return (
    <main className="bg-background text-foreground min-h-screen p-6 sm:p-12">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <h1 className="text-lg font-semibold">Plan execution tier</h1>
        <Scene title="Three levels" efforts={THREE_LEVELS} initial="medium" />
        <Scene title="Six levels" efforts={SIX_LEVELS} initial="high" />
        <Scene
          title="A level the model does not offer"
          efforts={THREE_LEVELS}
          initial="xhigh"
          error="Could not save the tier."
        />
      </div>
    </main>
  );
}

const root = document.getElementById("p2-6-slider-playground-root");
if (root === null) throw new Error("Missing P2.6 playground root.");
createRoot(root).render(<Playground />);
