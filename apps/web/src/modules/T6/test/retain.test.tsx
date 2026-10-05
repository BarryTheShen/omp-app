import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { RetainRenderer } from "../retain";

function props(args: unknown, result: unknown): ToolRendererProps {
  return {
    toolCallId: "retain-test" as never,
    toolName: "retain",
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

afterEach(cleanup);

describe("T6 retain renderer", () => {
  test("shows stored count, bounded item list and scopes", () => {
    render(
      <RetainRenderer
        {...props(
          {
            items: [
              { content: "one", scope: "project" },
              { content: "two", scope: "global" },
            ],
          },
          { content: [], details: { count: 2, stored: 2 } },
        )}
      />,
    );
    expect(screen.getByText("Stored 2 memories")).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("(project)")).toBeTruthy();
  });

  test("distinguishes queued and item-level batch failures", () => {
    const { rerender } = render(
      <RetainRenderer
        {...props(
          { items: [{ content: "queued memory" }] },
          { content: [], details: { count: 1, queued: 1 } },
        )}
      />,
    );
    expect(screen.getByText("Queued 1 memory")).toBeTruthy();
    expect(
      screen.getByText("The memory operation is queued; storage is not confirmed yet."),
    ).toBeTruthy();

    rerender(
      <RetainRenderer
        {...props(
          { items: [{ content: "stored memory" }, { content: "failed memory" }] },
          {
            content: [],
            details: { count: 2, stored: 1, failed: [{ reason: "backend rejected item 2" }] },
          },
        )}
      />,
    );
    expect(screen.getByText("Stored 1 of 2 memories")).toBeTruthy();
    expect(screen.getByText("backend rejected item 2")).toBeTruthy();
  });
});
