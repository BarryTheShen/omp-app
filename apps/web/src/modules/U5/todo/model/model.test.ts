import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { TodoSnapshot } from "../contract";
import { normalizeTodoPhases, projectTodoPhases, projectTodoSnapshot } from "./model";

const threadId = ThreadId.parse("u5-todo-model");

function snapshot(phases: TodoSnapshot["phases"]): TodoSnapshot {
  return {
    threadId,
    phases,
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
}

describe("todo projection model", () => {
  test("derives phase and aggregate progress and selects the active task", () => {
    const model = projectTodoSnapshot(
      snapshot([
        {
          name: "Build",
          tasks: [
            { content: "done", status: "completed" },
            { content: "active", status: "in_progress" },
            { content: "abandoned", status: "abandoned" },
          ],
        },
        { name: "Review", tasks: [{ content: "later", status: "pending" }] },
      ]),
    );

    expect(model.phases[0]?.progress).toEqual({ done: 2, total: 3 });
    expect(model.phases[1]?.progress).toEqual({ done: 0, total: 1 });
    expect(model.progress).toEqual({ done: 2, total: 4 });
    expect(model.currentTask).toMatchObject({ content: "active", status: "in_progress" });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.phases[0])).toBe(true);
  });

  test("keeps stable ids and phase identity while only changed tasks are replaced", () => {
    const initial = projectTodoSnapshot(
      snapshot([
        {
          name: "Build",
          tasks: [
            { content: "compile", status: "pending" },
            { content: "test", status: "pending" },
          ],
        },
        { name: "Review", tasks: [{ content: "approve", status: "pending" }] },
      ]),
    );
    const updated = projectTodoSnapshot(
      snapshot([
        {
          name: "Build",
          tasks: [
            { content: "compile", status: "completed" },
            { content: "test", status: "pending" },
          ],
        },
        { name: "Review", tasks: [{ content: "approve", status: "pending" }] },
      ]),
      initial,
    );

    expect(updated.phases[0]?.id).toBe(initial.phases[0]?.id);
    expect(updated.phases[0]?.tasks[0]?.id).toBe(initial.phases[0]?.tasks[0]?.id);
    expect(updated.phases[0]?.tasks[0]).not.toBe(initial.phases[0]?.tasks[0]);
    expect(updated.phases[0]?.tasks[1]).toBe(initial.phases[0]?.tasks[1]);
    expect(updated.phases[1]).toBe(initial.phases[1]);
  });

  test("normalizes malformed phases without throwing or inventing state", () => {
    const phases = normalizeTodoPhases([
      { name: "valid", tasks: [] },
      { name: "malformed", tasks: [{ content: "bad", status: "started" }] },
      { name: "extra", tasks: [], unexpected: true },
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.name).toBe("valid");
    expect(projectTodoPhases({ malformed: true })).toEqual([]);
  });
});
