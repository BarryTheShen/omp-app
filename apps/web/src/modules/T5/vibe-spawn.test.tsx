import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T5_VIBE_REAL_RESULTS } from "./fixtures/vibe-real-results";
import { VibeSpawnRenderer } from "./vibe-spawn";

afterEach(cleanup);

function callProps(sample: {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly isError: boolean;
}): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "t5-vibe-spawn",
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: sample.result,
    isError: sample.isError,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("VibeSpawnRenderer", () => {
  test("a call omp skipped shows its reason once, calmly, and names no worker", () => {
    const skipped = T5_VIBE_REAL_RESULTS[0];
    if (skipped === undefined) throw new Error("no recorded vibe_spawn result");
    render(<VibeSpawnRenderer {...callProps(skipped)} />);
    expandToolCards();
    expect(screen.getByText("Vibe worker not started")).toBeTruthy();
    const reason = "Skipped due to queued user message";
    // omp skipped the call before it started (#721): the card reads Skipped and shows omp's own sentence once in its
    // calm box, not as an error alert. The collapsed raw details keep omp's raw text and are not counted.
    expect(screen.getByTestId("u3-tool-card-interruption").textContent).toContain(reason);
    const shown = screen
      .getAllByText(new RegExp(reason))
      .filter((element) => element.closest("[data-slot='u3-tool-card-raw']") === null);
    expect(shown).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a spawn names the new session, its CLI and its turn job from omp's spawn details", () => {
    // Shape from omp v18.6.1 `tools/vibe.ts` (`VibeSpawnTool.execute`). No recorded spawn result
    // is in the session files yet, so this case follows that source.
    render(
      <VibeSpawnRenderer
        {...callProps({
          toolName: "vibe_spawn",
          args: { cli: "fast", prompt: "Check the build" },
          result: {
            content: [
              {
                type: "text",
                text: "Spawned fast session `fast-1` (turn job `job-1`). The turn result will be delivered when it finishes.",
              },
            ],
            details: {
              op: "spawn",
              screens: [],
              spawned: { id: "fast-1", cli: "fast", jobId: "job-1" },
            },
          },
          isError: false,
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Vibe worker fast-1")).toBeTruthy();
    expect(screen.getByText("CLI: fast")).toBeTruthy();
    expect(screen.getByText("Turn job: job-1")).toBeTruthy();
  });
});
