import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
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
    expandToolCards();
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
    expandToolCards();
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
    expandToolCards();
    expect(screen.getByText("Stored 1 of 2 memories")).toBeTruthy();
    expect(screen.getByText("backend rejected item 2")).toBeTruthy();
  });

  test("a call that failed says so and shows omp's message, not a count", () => {
    const failed: ToolRendererProps = {
      ...props(
        { items: '[{"content": "remember this"}]' },
        {
          content: [
            { type: "text", text: "[shaken ~19 tokens — recover: artifact://501 (region 65)]" },
          ],
          details: { isError: true, error: "Tool xd__retain not found. Did you mean retain?" },
        },
      ),
      isError: true,
    };
    render(<RetainRenderer {...failed} />);
    expandToolCards();
    expect(screen.getByText("Retain failed")).toBeTruthy();
    expect(screen.getByText("Tool xd__retain not found. Did you mean retain?")).toBeTruthy();
    expect(screen.queryByText("No memories stored")).toBeNull();
  });
});
