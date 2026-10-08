import type { EnrichedPartState } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ToolFallback } from "@/modules/U3/tool-card/fallback";
import { ToolRunActiveContext, ToolSlot } from "./tool-slot";

afterEach(() => cleanup());

type ToolPart = Extract<EnrichedPartState, { type: "tool-call" }>;

/** A call its complete message holds, with no result and no state: the second call of a message, say. */
function queuedCall(): ToolPart {
  return {
    type: "tool-call",
    toolCallId: "second-1",
    toolName: "bash",
    args: { command: "echo second" },
    argsText: '{"command":"echo second"}',
    status: { type: "complete" },
  } as unknown as ToolPart;
}

describe("ToolSlot for a call with no result", () => {
  test("reads Waiting while its run is active, and Finished with No result recorded once the run has ended", () => {
    const renderers = { bash: ToolFallback };
    const { rerender } = render(
      <ToolRunActiveContext.Provider value={true}>
        <ToolSlot part={queuedCall()} renderers={renderers} />
      </ToolRunActiveContext.Provider>,
    );
    expect(screen.getByTestId("tool-state-chip-partial").textContent).toContain("Waiting");
    expect(screen.queryByText("No result recorded")).toBeNull();

    rerender(
      <ToolRunActiveContext.Provider value={false}>
        <ToolSlot part={queuedCall()} renderers={renderers} />
      </ToolRunActiveContext.Provider>,
    );
    expect(screen.getByTestId("tool-state-chip-unrecorded").textContent).toContain("Finished");
    expect(screen.getAllByText("No result recorded").length).toBeGreaterThan(0);
  });
});
