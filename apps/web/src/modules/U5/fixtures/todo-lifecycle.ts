import type { RpcSessionEvent } from "@omp-app/contracts";
import type { TodoPhase, TodoTask } from "../todo/contract";

/**
 * Scrubbed examples follow omp 18.6.1's TodoItem/TodoPhase and RPC event shapes:
 * `packages/contracts/src/omp-wire/rpc-wire.generated.ts:397-409,733-762,855-864`.
 * The real todo tool returns `{ content: [{ type: "text", text }], details: { op, phases, storage }`
 * (`packages/coding-agent/src/tools/todo.ts:741-768`); `start` selects one active task
 * (`packages/coding-agent/src/tools/todo.ts:399-418`). `set_todos` drops details and notes
 * (`docs/rpc.md:596-602`). R0 extracts only successful non-view todo results (`store.ts:515-527`)
 * and clears phases for `todo_auto_clear` (`store.ts:1224-1239`).
 */

/** The complete E3 inventory slice owned by U5; N1 and S3 rows remain outside this module. */
export const U5_INVENTORY_ROWS = [
  "E3.todo-command",
  "E3.todo-append",
  "E3.todo-copy",
  "E3.todo-done",
  "E3.todo-drop",
  "E3.todo-edit",
  "E3.todo-export",
  "E3.todo-import",
  "E3.todo-rm",
  "E3.todo-start",
  "E3.todo-tool-renderer",
  "E3.todo-checklist-panel",
  "E3.todo-reminder-panel",
] as const;

export type U5InventoryId = (typeof U5_INVENTORY_ROWS)[number];
type U5FixtureScenario = "descriptor-audit" | "todo-actions" | "todo-editor" | "todo-lifecycle-w3";

/** Every U5 row points to the fixture or focused test that proves its behavior. */
export const U5_FIXTURE_COVERAGE = [
  {
    inventoryId: "E3.todo-command",
    scenario: "descriptor-audit",
    proof: "todo-command-descriptor",
  },
  { inventoryId: "E3.todo-append", scenario: "todo-actions", proof: "structured-append" },
  { inventoryId: "E3.todo-copy", scenario: "todo-actions", proof: "markdown-copy" },
  { inventoryId: "E3.todo-done", scenario: "todo-actions", proof: "structured-done" },
  { inventoryId: "E3.todo-drop", scenario: "todo-actions", proof: "structured-drop" },
  { inventoryId: "E3.todo-edit", scenario: "todo-editor", proof: "u4-editor-confirmation" },
  { inventoryId: "E3.todo-export", scenario: "todo-actions", proof: "markdown-export" },
  { inventoryId: "E3.todo-import", scenario: "todo-actions", proof: "markdown-import" },
  { inventoryId: "E3.todo-rm", scenario: "todo-actions", proof: "structured-remove" },
  { inventoryId: "E3.todo-start", scenario: "todo-actions", proof: "structured-start" },
  {
    inventoryId: "E3.todo-tool-renderer",
    scenario: "todo-lifecycle-w3",
    proof: "todo-tool-lifecycle",
  },
  {
    inventoryId: "E3.todo-checklist-panel",
    scenario: "todo-lifecycle-w3",
    proof: "checklist-panel",
  },
  {
    inventoryId: "E3.todo-reminder-panel",
    scenario: "todo-lifecycle-w3",
    proof: "reminder-auto-clear",
  },
] as const satisfies ReadonlyArray<{
  readonly inventoryId: U5InventoryId;
  readonly scenario: U5FixtureScenario;
  readonly proof: string;
}>;
export const TODO_FIXTURE_PHASES: readonly TodoPhase[] = [
  {
    name: "Prepare",
    tasks: [
      {
        content: "Read the runtime contract",
        status: "completed",
        notes: ["Use the canonical R0 snapshot."],
      },
      { content: "Record a scrubbed fixture", status: "completed" },
    ],
  },
  {
    name: "Build",
    tasks: [
      {
        content: "Exercise the live todo events",
        status: "in_progress",
        details: "The tool result is authoritative.",
      },
      { content: "Wire the todo panel", status: "pending" },
      { content: "Replay the provider response", status: "blocked", blocker: "fake provider" },
    ],
  },
  {
    name: "Cleanup",
    tasks: [{ content: "Discard the superseded draft", status: "abandoned" }],
  },
];

export const TODO_FIXTURE_GET_STATE = {
  todoPhases: TODO_FIXTURE_PHASES,
  isStreaming: false,
  isSettled: true,
} as const;

export const TODO_FIXTURE_TOOL_CALL_ID = "todo-fixture-call";

export const TODO_FIXTURE_TOOL_ARGS = {
  op: "start",
  task: "Wire the todo panel",
} as const;

/** The tool's committed result drops UI-only details/notes and starts the requested task. */
export const TODO_FIXTURE_TOOL_PHASES: readonly TodoPhase[] = [
  {
    name: "Prepare",
    tasks: [
      { content: "Read the runtime contract", status: "completed" },
      { content: "Record a scrubbed fixture", status: "completed" },
    ],
  },
  {
    name: "Build",
    tasks: [
      { content: "Exercise the live todo events", status: "pending" },
      { content: "Wire the todo panel", status: "in_progress" },
      { content: "Replay the provider response", status: "blocked", blocker: "fake provider" },
    ],
  },
  {
    name: "Cleanup",
    tasks: [{ content: "Discard the superseded draft", status: "abandoned" }],
  },
];

export const TODO_FIXTURE_TOOL_RESULT = {
  content: [
    {
      type: "text",
      text: [
        "Remaining items (2):",
        "  - Exercise the live todo events [pending] (Build)",
        "  - Wire the todo panel [in_progress] (Build)",
        "Overall: 3/6 done, 2 open, 1 blocked.",
        'Active phase 2/3 "Build" (0/3) — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).',
        "  Prepare:",
        "    - [X] Read the runtime contract",
        "    - [X] Record a scrubbed fixture",
        "  Build:",
        "    - [ ] Exercise the live todo events",
        "    - [ ] Wire the todo panel (in progress)",
        "    - [ ] Replay the provider response (blocked: fake provider)",
        "  Cleanup:",
        "    - [ ] Discard the superseded draft (dropped)",
      ].join("\n"),
    },
  ],
  details: { op: "start", phases: TODO_FIXTURE_TOOL_PHASES, storage: "session" },
};

/** omp's set_todos response is canonical and omits request-only task metadata. */
export const TODO_FIXTURE_SET_TODOS_REQUEST: readonly TodoPhase[] = [
  {
    name: "Persisted",
    tasks: [
      {
        content: "Save canonical todo state",
        status: "pending",
        details: "The server owns the returned state.",
        notes: ["metadata is not retained by omp"],
      },
    ],
  },
];

export const TODO_FIXTURE_SET_TODOS_RESPONSE: readonly TodoPhase[] = [
  { name: "Persisted", tasks: [{ content: "Save canonical todo state", status: "pending" }] },
];

export const TODO_FIXTURE_REMINDER = {
  type: "todo_reminder" as const,
  todos: [
    { content: "Exercise the live todo events", status: "pending" as const },
    { content: "Wire the todo panel", status: "in_progress" as const },
    {
      content: "Replay the provider response",
      status: "blocked" as const,
      blocker: "fake provider",
    },
  ],
  attempt: 2,
  maxAttempts: 4,
};

/**
 * These are the typed events delivered by A0/R0: start and successful completion, followed by
 * omp's committed reminder and payload-free auto-clear notification.
 */
export const TODO_FIXTURE_EVENTS = [
  {
    kind: "omp",
    event: {
      type: "tool_execution_start",
      toolCallId: TODO_FIXTURE_TOOL_CALL_ID,
      toolName: "todo",
      args: TODO_FIXTURE_TOOL_ARGS,
    },
  },
  {
    kind: "omp",
    event: {
      type: "tool_execution_end",
      toolCallId: TODO_FIXTURE_TOOL_CALL_ID,
      toolName: "todo",
      result: TODO_FIXTURE_TOOL_RESULT,
      isError: false,
    },
  },
  { kind: "omp", event: TODO_FIXTURE_REMINDER },
  { kind: "omp", event: { type: "todo_auto_clear" } },
] satisfies readonly RpcSessionEvent[];

export function cloneTodoFixturePhases(): TodoPhase[] {
  return TODO_FIXTURE_PHASES.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task: TodoTask) => ({
      ...task,
      ...(task.notes === undefined ? {} : { notes: [...task.notes] }),
    })),
  }));
}
