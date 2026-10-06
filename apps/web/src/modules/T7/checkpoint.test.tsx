import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { CheckpointCard, RewindCard } from "./checkpoint";

afterEach(cleanup);

function props(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-1`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

describe("CheckpointCard", () => {
  test("names the goal in the header and adds nothing else", () => {
    render(
      <CheckpointCard
        rendererProps={props(
          "checkpoint",
          { goal: "find why the cache misses" },
          {
            content: [
              {
                type: "text",
                text: "Checkpoint: find why the cache misses\nFinish exploration and formulate findings.",
              },
            ],
            details: { goal: "find why the cache misses", startedAt: "2026-10-05T12:00:00.000Z" },
          },
        )}
      />,
    );
    // The card's label says "checkpoint"; the header adds only the goal.
    expect(screen.getByText("find why the cache misses")).toBeTruthy();
    expect(screen.queryByText(/restored/)).toBeNull();
    expect(screen.queryByText(/unavailable/)).toBeNull();
  });

  test("running state shows the goal from the arguments", () => {
    render(
      <CheckpointCard
        rendererProps={props("checkpoint", { goal: "try the new parser" }, undefined, {
          type: "running",
        })}
      />,
    );
    expect(screen.getByText("try the new parser")).toBeTruthy();
    expect(screen.getByTestId("tool-card-checkpoint-1").getAttribute("data-phase")).toBe("running");
  });

  test("shows one muted line for malformed details", () => {
    render(
      <CheckpointCard
        rendererProps={props("checkpoint", { goal: "x" }, { content: [], details: { goal: 4 } })}
      />,
    );
    expect(screen.getByText("Checkpoint details unavailable.")).toBeTruthy();
  });
});

describe("RewindCard", () => {
  test("puts the report's first line in the header and the full report below as Markdown", () => {
    const report =
      "Cache misses come from the key builder.\n\n- `buildKey` drops the locale\n- fix in `src/cache.ts`";
    render(
      <RewindCard
        rendererProps={props(
          "rewind",
          { report },
          {
            content: [
              { type: "text", text: "Rewind requested.\nReport captured for context replacement." },
            ],
            details: { report, rewound: true },
          },
        )}
      />,
    );
    expect(screen.getByText("Cache misses come from the key builder.")).toBeTruthy();
    expect(screen.getByTestId("t7-rewind-report").textContent).toContain("drops the locale");
    expect(screen.getByText("buildKey")).toBeTruthy();
  });

  test("a one-line report appears only in the header", () => {
    render(
      <RewindCard
        rendererProps={props(
          "rewind",
          { report: "Nothing to change." },
          {
            content: [{ type: "text", text: "Rewind requested." }],
            details: { report: "Nothing to change.", rewound: true },
          },
        )}
      />,
    );
    expect(screen.getByText("Nothing to change.")).toBeTruthy();
    expect(screen.queryByTestId("t7-rewind-report")).toBeNull();
  });

  test("a failed rewind keeps only the error surface", () => {
    render(
      <RewindCard
        rendererProps={props(
          "rewind",
          { report: "Done." },
          { content: [{ type: "text", text: "No active checkpoint." }] },
          { type: "incomplete", reason: "error" },
        )}
      />,
    );
    expect(screen.getByTestId("tool-card-rewind-1").getAttribute("data-phase")).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("No active checkpoint.");
    expect(screen.queryByText("Rewind details unavailable.")).toBeNull();
    expect(screen.queryByText(/host\./)).toBeNull();
  });
});
