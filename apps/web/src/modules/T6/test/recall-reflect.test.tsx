import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
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
    expandToolCards();
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
    expandToolCards();
    expect(screen.getByText("No memories found.")).toBeTruthy();
  });

  test("keeps the recall header outside the eight memory rows and reports the omitted count", () => {
    const memories = Array.from({ length: 12 }, (_, index) => `Scrubbed memory ${index + 1}.`);
    const header = "Found 12 relevant memories (as of 2026-10-07 21:44 UTC):";
    const result = {
      content: [
        { type: "text", text: `${header}\n\n${memories.map((line) => `- ${line}`).join("\n\n")}` },
      ],
      details: { count: 12 },
    };
    const { container } = render(<RecallRenderer {...props("recall", {}, result)} />);
    expandToolCards();
    const card = container.querySelector('[data-t6-tool="recall"]');
    expect(card).not.toBeNull();
    const headerElement = screen.getByText(header, { exact: true });
    expect(headerElement.tagName).toBe("P");
    expect(headerElement.closest("ul")).toBeNull();
    expect(card?.querySelectorAll("ul > li")).toHaveLength(8);
    expect(screen.getByText("Showing 8 of 12 memories.")).toBeTruthy();
  });
  test("caps headerless recall results at eight rows and reports the omitted count", () => {
    const memories = Array.from({ length: 12 }, (_, index) => `Headerless memory ${index + 1}.`);
    const result = {
      content: [{ type: "text", text: memories.join("\n") }],
      details: { count: 12 },
    };
    const { container } = render(<RecallRenderer {...props("recall", {}, result)} />);
    expandToolCards();
    expect(container.querySelectorAll('[data-t6-tool="recall"] ul > li')).toHaveLength(8);
    expect(screen.getByText("Showing 8 of 12 memories.")).toBeTruthy();
  });

  test("does not report hidden recall rows when the count matches the result", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "Found 2 relevant memories (as of 2026-10-07 21:44 UTC):\n\n- First memory.\n\n- Second memory.",
        },
      ],
      details: { count: 2 },
    };
    render(<RecallRenderer {...props("recall", {}, result)} />);
    expandToolCards();
    expect(screen.queryByText(/Showing /)).toBeNull();
  });

  test("pins the empty recall branch", () => {
    render(<RecallRenderer {...props("recall", {}, undefined)} />);
    expandToolCards();
    expect(screen.getByText("No memory text returned.")).toBeTruthy();
    expect(screen.getByText("No result recorded")).toBeTruthy();
  });

  test("uses the plain no-match recall heading", () => {
    render(
      <RecallRenderer
        {...props(
          "recall",
          {},
          {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0, noMatch: true },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("No memories found", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Memory results")).toBeNull();
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
    expandToolCards();
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
    expandToolCards();
    expect(screen.getByText("No relevant information found.")).toBeTruthy();
  });
});
