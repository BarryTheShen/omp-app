import type { ToolCallId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "@/modules/U3/tool-card/contract";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import { TodoToolRenderer, todoToolDescriptor } from "./tool-card";

const phases = [
  {
    name: "Build",
    tasks: [
      { content: "compile", status: "completed" as const },
      { content: "test", status: "in_progress" as const },
      { content: "ship", status: "pending" as const },
    ],
  },
  {
    name: "Review",
    tasks: [
      { content: "approve", status: "completed" as const },
      { content: "announce", status: "pending" as const },
    ],
  },
];

afterEach(() => cleanup());

function props(result: unknown): ToolRendererProps {
  return {
    toolCallId: "todo-call" as ToolCallId,
    toolName: "todo",
    args: { op: "replace" },
    argsText: '{"op":"replace"}',
    result,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("TodoToolRenderer", () => {
  test("renders through U3's card with the todo summary and checklist details", () => {
    render(<TodoToolRenderer {...props({ content: [], details: { op: "replace", phases } })} />);
    expandToolCards();

    expect(screen.getByText("Updated todos: 2 of 5 done")).toBeTruthy();
    expect(screen.getByTestId("todo-tool-checklist")).toBeTruthy();
    expect(screen.getByText("test")).toBeTruthy();
    expect(screen.getByRole("button", { name: "todo: Complete" })).toBeTruthy();
  });

  test("keeps a safe summary for partial or malformed tool results", () => {
    render(<TodoToolRenderer {...props({ content: [], details: { op: "view" } })} />);
    expandToolCards();
    expect(screen.getByText("No todo phases returned")).toBeTruthy();
    expect(screen.queryByTestId("todo-tool-checklist")).toBeNull();
  });

  test("exports an exact-name U5 descriptor without claiming a capability", () => {
    expect(todoToolDescriptor).toMatchObject({
      id: "U5.todoTool",
      owner: "U5",
      kind: "tool",
      match: { by: "name", name: "todo" },
      requires: [],
      covers: ["E3.todo-tool-renderer"],
    });
    expect(todoToolDescriptor.renderer).toBe(TodoToolRenderer);
  });
});
