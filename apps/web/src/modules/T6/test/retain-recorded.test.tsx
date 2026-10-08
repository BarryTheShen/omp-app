import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { T6_REAL_RESULTS } from "../fixtures/real-results";
import { RetainRenderer } from "../retain";

afterEach(cleanup);

/** Renders a recorded retain-family result and returns it, so each check reads what the fixture shows. */
function renderRecorded(name: string) {
  const sample = T6_REAL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`no recorded sample named ${name}`);
  render(
    <RetainRenderer
      {...({
        type: "tool-call",
        toolCallId: "t6-retain-recorded",
        toolName: sample.toolName,
        args: sample.args,
        argsText: JSON.stringify(sample.args),
        result: sample.result,
        isError: sample.isError,
        status: { type: "complete" },
      } as unknown as ToolRendererProps)}
    />,
  );
  return sample;
}

describe("T6 retain renderer on recorded calls", () => {
  test("a call that queued one memory shows omp's words and the memory it named", () => {
    const sample = renderRecorded("retain: a call that queued 1 memory");
    expect(screen.getByText(sample.shows[0] ?? "")).toBeTruthy();
    expect(screen.getByText(sample.shows[1] ?? "")).toBeTruthy();
    expect(screen.queryByText(/malformed/i)).toBeNull();
  });

  test("a failed call shows omp's message, not a count and not a memory list", () => {
    renderRecorded("xd__retain: the name is not a tool, and omp says so");
    expect(screen.getByText("Retain failed")).toBeTruthy();
    expect(screen.getByText("Tool xd__retain not found. Did you mean retain?")).toBeTruthy();
    expect(screen.queryByText("No memory items returned.")).toBeNull();
    expect(screen.queryByText(/malformed/i)).toBeNull();
  });
});
