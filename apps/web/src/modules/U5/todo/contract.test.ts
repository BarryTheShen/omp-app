import { AppError, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  TodoActionFailure,
  TodoActionResult,
  TodoPhaseSchema,
  TodoSnapshot,
  TodoSnapshotSource,
  TodoStatus,
  TodoTaskSchema,
} from "./contract";

const threadId = ThreadId.parse("todo-thread");
const phases = [
  {
    name: "Plan",
    tasks: [
      {
        content: "Implement contract",
        status: "in_progress" as const,
        details: "Keep R0 canonical",
      },
      { content: "Review contract", status: "blocked" as const, blocker: "waiting" },
    ],
  },
];

describe("U5 todo contract", () => {
  test("accepts omp-shaped phases/tasks and rejects malformed status or extra fields", () => {
    expect(TodoTaskSchema.parse(phases[0]?.tasks[0])).toMatchObject({
      content: "Implement contract",
      status: "in_progress",
    });
    expect(TodoPhaseSchema.parse(phases[0])).toMatchObject({ name: "Plan" });
    expect(TodoStatus.safeParse("completed").success).toBe(true);
    expect(TodoStatus.safeParse("started").success).toBe(false);
    expect(
      TodoTaskSchema.safeParse({ content: "bad", status: "pending", extra: true }).success,
    ).toBe(false);
  });

  test("keeps one immutable snapshot source and reminder metadata", () => {
    const snapshot = TodoSnapshot.parse({
      threadId,
      phases,
      source: "state",
      sequence: 4,
      updatedAt: "2026-10-05T00:00:00.000Z",
      reminder: {
        todos: [phases[0]?.tasks[1]],
        attempt: 1,
        maxAttempts: 3,
        afterMessage: null,
      },
      error: null,
    });
    expect(snapshot).toMatchObject({ threadId, source: "state", sequence: 4 });
    expect(TodoSnapshotSource.safeParse("set_todos").success).toBe(true);
    expect(TodoSnapshotSource.safeParse("browser").success).toBe(false);
    expect(
      TodoSnapshot.safeParse({ ...snapshot, phases: [{ name: "bad", tasks: [] }], extra: true })
        .success,
    ).toBe(false);
  });

  test("accepts canonical R0 setTodos results and explicit non-mutating failures", () => {
    expect(TodoActionResult.parse({ phases, source: "set_todos" })).toMatchObject({
      source: "set_todos",
    });
    expect(
      TodoActionFailure.parse({
        error: AppError.parse({
          code: "unavailable",
          message: "setTodos unavailable",
          retryable: false,
        }),
        mutated: false,
      }),
    ).toMatchObject({ mutated: false });
    expect(TodoActionResult.safeParse({ phases, source: "tool" }).success).toBe(false);
  });
});
