import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { TodoSnapshot } from "../contract";
import { projectTodoSnapshot } from "../model";
import { TodoBoard, type TodoViewPreferenceStore } from "./board";

const snapshot: TodoSnapshot = {
  threadId: ThreadId.parse("u5-board"),
  phases: [
    { name: "Build", tasks: [{ content: "compile", status: "completed" }] },
    { name: "Review", tasks: [{ content: "approve", status: "pending" }] },
  ],
  source: "state",
  sequence: 1,
  updatedAt: "2026-10-05T00:00:00.000Z",
  reminder: null,
  error: null,
};

afterEach(() => cleanup());

test("toggles list/board and remembers the mode per thread", () => {
  const values = new Map<string, "list" | "board">();
  const preferences: TodoViewPreferenceStore = {
    get: (threadId) => values.get(threadId),
    set: (threadId, mode) => values.set(threadId, mode),
  };
  const model = projectTodoSnapshot(snapshot);
  const first = render(<TodoBoard model={model} preferences={preferences} />);
  expect(screen.getByTestId("todo-checklist")).toBeTruthy();
  fireEvent.click(screen.getByTestId("todo-mode-board"));
  expect(screen.getByTestId("todo-board-columns")).toBeTruthy();
  expect(values.get("u5-board")).toBe("board");
  first.unmount();
  render(<TodoBoard model={model} preferences={preferences} />);
  expect(screen.getByTestId("todo-board-columns")).toBeTruthy();
});
test("uses the same status icon and accessible label mapping as the checklist", () => {
  const model = projectTodoSnapshot(snapshot);
  render(<TodoBoard model={model} preferences={memoryPreferences()} />);
  const listTask = screen.getByText("approve").closest("li");
  expect(listTask?.querySelector("span.rounded-full")).toBeTruthy();
  expect(screen.getByText("Pending")).toBeTruthy();
  fireEvent.click(screen.getByTestId("todo-mode-board"));
  const boardTask = screen
    .getByTestId("todo-board-columns")
    .querySelector('[data-status="pending"]');
  expect(boardTask?.querySelector("span.rounded-full")).toBeTruthy();
  expect(screen.getAllByText("Pending")).toHaveLength(1);
});
function memoryPreferences(): TodoViewPreferenceStore {
  return { get: () => undefined, set: () => undefined };
}
