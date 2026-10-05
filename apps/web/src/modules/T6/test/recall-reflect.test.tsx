import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { RecallRenderer } from "../recall";
import { ReflectRenderer } from "../reflect";

function props(toolName: "recall" | "reflect", args: unknown, result: unknown): ToolRendererProps {
  return {
    toolCallId: `${toolName}-test` as never,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

afterEach(cleanup);

describe("T6 recall and reflect renderers", () => {
  test("shows recall query, bounded snippets and no-match state", () => {
    const { rerender } = render(
      <RecallRenderer
        {...props(
          "recall",
          { query: "prior decision" },
          {
            content: [{ type: "text", text: "First memory\nSecond memory" }],
            details: { count: 2 },
          },
        )}
      />,
    );
    expect(screen.getByText("prior decision")).toBeTruthy();
    expect(screen.getByText("First memory")).toBeTruthy();
    expect(screen.getByText("Second memory")).toBeTruthy();

    rerender(
      <RecallRenderer
        {...props(
          "recall",
          { query: "missing" },
          {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0, noMatch: true },
          },
        )}
      />,
    );
    expect(screen.getByText("No memories found.")).toBeTruthy();
  });

  test("renders reflect Markdown through U1.4 and handles no information", () => {
    const { rerender } = render(
      <ReflectRenderer
        {...props(
          "reflect",
          { query: "what changed?" },
          {
            content: [{ type: "text", text: "# Answer\n\n- One memory" }],
            details: {},
          },
        )}
      />,
    );
    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.getByText("One memory")).toBeTruthy();

    rerender(
      <ReflectRenderer
        {...props(
          "reflect",
          { query: "missing" },
          {
            content: [{ type: "text", text: "No relevant information found to reflect on." }],
            details: {},
          },
        )}
      />,
    );
    expect(screen.getByText("No relevant information found.")).toBeTruthy();
  });
});
