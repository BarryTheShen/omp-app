import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import type { RealToolResult } from "../U3/tool-card/real-result";
import { T5_VIBE_SOURCE_RESULTS } from "./fixtures/vibe-source-results";
import { VibeKillRenderer, VibeListRenderer, VibeSendRenderer, VibeWaitRenderer } from "./vibe";

const RENDERERS = {
  vibe_send: VibeSendRenderer,
  vibe_list: VibeListRenderer,
  vibe_wait: VibeWaitRenderer,
  vibe_kill: VibeKillRenderer,
} as const;

/** The props a card gets for one source-derived call, as a transcript passes them. */
function propsFor(sample: RealToolResult): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `t5-4-${sample.name}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: sample.result,
    isError: sample.isError,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

function VibePlayground() {
  return (
    <main
      className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8"
      data-testid="t5-vibe-playground"
    >
      <header className="border-border bg-card mx-auto w-full max-w-5xl rounded-xl border p-4 shadow-xs">
        <h1 className="text-lg font-semibold tracking-tight">T5.4 Vibe worker cards</h1>
        <p className="text-muted-foreground text-sm">
          Source-derived from omp v18.8.9, not recorded: vibe mode is terminal-only, so no session
          file holds these results.
        </p>
      </header>
      <section className="border-border bg-card mx-auto mt-6 flex w-full max-w-5xl flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-6">
        {T5_VIBE_SOURCE_RESULTS.map((sample) => {
          const Renderer = RENDERERS[sample.toolName as keyof typeof RENDERERS];
          return <Renderer key={sample.name} {...propsFor(sample)} />;
        })}
      </section>
    </main>
  );
}

const root = document.getElementById("t5-4-vibe-playground-root");
if (!root) throw new Error("T5.4 vibe playground root is missing.");
createRoot(root).render(<VibePlayground />);
