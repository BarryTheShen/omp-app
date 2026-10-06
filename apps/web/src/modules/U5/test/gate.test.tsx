import type { ToolCallId } from "@omp-app/contracts";
import {
  Descriptor,
  type Descriptor as DescriptorValue,
  INVENTORY,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import type { ToolRendererProps } from "@/modules/U3/tool-card/contract";
import { U5Descriptors } from "../descriptors";
import {
  cloneTodoFixturePhases,
  TODO_FIXTURE_EVENTS,
  TODO_FIXTURE_GET_STATE,
  TODO_FIXTURE_PHASES,
  TODO_FIXTURE_REMINDER,
  TODO_FIXTURE_SET_TODOS_REQUEST,
  TODO_FIXTURE_SET_TODOS_RESPONSE,
  TODO_FIXTURE_TOOL_ARGS,
  TODO_FIXTURE_TOOL_CALL_ID,
  TODO_FIXTURE_TOOL_PHASES,
  TODO_FIXTURE_TOOL_RESULT,
  U5_FIXTURE_COVERAGE,
  U5_INVENTORY_ROWS,
} from "../fixtures";
import {
  canTransitionPanelLifecycle,
  PANEL_KIND_RULES,
  PANEL_LIFECYCLE_TRANSITIONS,
} from "../panel/rules";
import { PanelShell } from "../panel/shell";
import { TodoChecklist } from "../todo/checklist/checklist";
import { projectTodoSnapshot } from "../todo/model";
import { TodoReminderNotice } from "../todo/reminder/notice";
import { TodoReminderController, type TodoReminderTimer } from "../todo/reminder/reminder";
import { TodoStoreAdapter } from "../todo/store/store";
import { TodoToolRenderer, todoToolDescriptor } from "../todo/tool-card/tool-card";

const threadId = ThreadId.parse("u5-acceptance");
const fixtureToolCallId = TODO_FIXTURE_TOOL_CALL_ID as ToolCallId;

function withoutRenderer(descriptor: typeof todoToolDescriptor): DescriptorValue {
  const { renderer: _renderer, ...base } = descriptor;
  return base;
}

function toolProps(
  result: unknown,
  status: "running" | "complete" = "complete",
): ToolRendererProps {
  return {
    toolCallId: TODO_FIXTURE_TOOL_CALL_ID as ToolCallId,
    toolName: "todo",
    args: TODO_FIXTURE_TOOL_ARGS,
    argsText: JSON.stringify(TODO_FIXTURE_TOOL_ARGS),
    result,
    status: status === "running" ? { type: "running" } : { type: "complete" },
  } as unknown as ToolRendererProps;
}

function fixtureEvent(index: number) {
  const event = TODO_FIXTURE_EVENTS[index];
  if (event === undefined) throw new Error(`Todo fixture event ${index} is missing.`);
  return event;
}

afterEach(() => cleanup());

describe("U5 descriptor and panel-kind gate", () => {
  test("covers each U5 E3 inventory row exactly once and validates with C0", () => {
    expect(U5Descriptors).toHaveLength(2);
    expect(U5Descriptors.map((descriptor) => descriptor.kind)).toEqual(["command", "panel"]);
    const descriptors: readonly DescriptorValue[] = [
      ...U5Descriptors,
      withoutRenderer(todoToolDescriptor),
    ];
    const covered = descriptors.flatMap((descriptor) => descriptor.covers);
    const expected = U5_INVENTORY_ROWS;
    const e3Rows = INVENTORY.filter((item) => item.group === "E3").map((item) => item.id);
    expect([...expected].sort()).toEqual([...e3Rows].sort());

    expect(Descriptor.array().parse(descriptors)).toHaveLength(descriptors.length);
    expect(validateRegistry(descriptors)).toEqual([]);
    expect([...covered].sort()).toEqual([...expected].sort());
    expect(new Set(covered).size).toBe(expected.length);
    const fixtureRows = U5_FIXTURE_COVERAGE.map((coverage) => coverage.inventoryId);
    expect([...fixtureRows].sort()).toEqual([...expected].sort());
    expect(new Set(fixtureRows).size).toBe(fixtureRows.length);
    for (const row of expected) {
      const coverage = U5_FIXTURE_COVERAGE.find((item) => item.inventoryId === row);
      expect(coverage?.scenario).toBeDefined();
      expect(coverage?.proof).toBeTruthy();
    }

    expect(U5Descriptors.find((descriptor) => descriptor.kind === "command")).toMatchObject({
      id: "U5.todoCommand",
      slash: { name: "todo", source: "builtin" },
      requires: ["omp.ui"],
    });
    expect(U5Descriptors.find((descriptor) => descriptor.kind === "panel")).toMatchObject({
      id: "U5.todo",
      covers: ["E3.todo-checklist-panel", "E3.todo-reminder-panel"],
    });
    expect(todoToolDescriptor.id).toBe("U5.todoTool");
  });

  test("keeps the panel non-modal and requires every lifecycle state", () => {
    expect(PANEL_KIND_RULES).toMatchObject({
      kind: "panel",
      modal: false,
      u4OwnsModalDialogs: true,
      u0OwnsFocusAndTokens: true,
      passiveUpdatesStealFocus: false,
      secondTodoStore: false,
    });
    expect(PANEL_KIND_RULES.lifecycleStates).toEqual([
      "closed",
      "loading",
      "empty",
      "populated",
      "updating",
      "unavailable",
      "error",
    ]);
    for (const state of PANEL_KIND_RULES.lifecycleStates) {
      expect(PANEL_LIFECYCLE_TRANSITIONS[state]).toContain(state);
    }
    expect(canTransitionPanelLifecycle("closed", "updating")).toBe(false);
    expect(canTransitionPanelLifecycle("populated", "updating")).toBe(true);
  });
});

describe("U5 W3 live todo fixture", () => {
  test("reconciles get_state, todo tool results, reminders, and auto-clear through one store", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    runtime.applySessionState({
      ...TODO_FIXTURE_GET_STATE,
      todoPhases: cloneTodoFixturePhases(),
    });
    const adapter = new TodoStoreAdapter({
      store: runtime,
      now: () => new Date("2026-10-05T00:00:00.000Z"),
    });
    let expiry: (() => void) | undefined;
    const timer: TodoReminderTimer = {
      setTimeout: (callback) => {
        expiry = callback;
        return "todo-expiry";
      },
      clearTimeout: vi.fn(),
    };
    const reminders = new TodoReminderController({ store: adapter, timer, retentionMs: 1 });

    try {
      const canonicalBeforeTool = adapter.getSnapshot().phases;
      expect(canonicalBeforeTool).toEqual(TODO_FIXTURE_PHASES);
      expect(adapter.getSnapshot().source).toBe("state");

      render(<TodoChecklist model={projectTodoSnapshot(adapter.getSnapshot())} />);
      expect(screen.getByText("The tool result is authoritative.")).toBeTruthy();
      expect(screen.getByText("Blocked by: fake provider")).toBeTruthy();
      cleanup();

      runtime.ingest(fixtureEvent(0), 1);
      expect(runtime.getSnapshot().tools[fixtureToolCallId]?.status).toBe("running");
      runtime.ingest(fixtureEvent(1), 2);
      expect(runtime.getSnapshot().tools[fixtureToolCallId]?.status).toBe("success");
      expect(runtime.getSnapshot().todoPhases).toEqual(TODO_FIXTURE_TOOL_PHASES);
      expect(adapter.getSnapshot().source).toBe("tool");
      const canonicalAfterTool = adapter.getSnapshot().phases;
      expect(canonicalAfterTool).not.toBe(canonicalBeforeTool);
      expect(canonicalAfterTool).toEqual(TODO_FIXTURE_TOOL_PHASES);

      const model = projectTodoSnapshot(adapter.getSnapshot());
      expect(model.progress).toEqual({ done: 3, total: 6 });
      render(<TodoChecklist model={model} />);
      expect(screen.getByTestId("todo-progress").textContent).toBe("3 of 6 done");
      expect(screen.getByText("Wire the todo panel")).toBeTruthy();
      expect(screen.getByText("Blocked by: fake provider")).toBeTruthy();
      cleanup();

      render(<TodoToolRenderer {...toolProps(TODO_FIXTURE_TOOL_RESULT)} />);
      expect(screen.getByText("Updated todos: 3 of 6 done")).toBeTruthy();
      cleanup();

      runtime.ingest(fixtureEvent(2), 3);
      expect(adapter.getSnapshot().source).toBe("reminder");
      expect(adapter.getSnapshot().phases).toBe(canonicalAfterTool);
      expect(adapter.getSnapshot().reminder).toMatchObject({
        todos: TODO_FIXTURE_REMINDER.todos,
        attempt: 2,
        maxAttempts: 4,
      });
      expect(reminders.getSnapshot()).toMatchObject({ badgeCount: 3, reminder: { attempt: 2 } });
      render(<TodoReminderNotice snapshot={reminders.getSnapshot()} />);
      expect(screen.getByText("3 incomplete todos — reminder 2/4")).toBeTruthy();
      cleanup();

      runtime.ingest(fixtureEvent(3), 4);
      expect(adapter.getSnapshot().phases).toEqual([]);
      expect(reminders.getSnapshot()).toMatchObject({
        cleared: true,
        previousPhases: canonicalAfterTool,
      });
      render(<TodoReminderNotice snapshot={reminders.getSnapshot()} />);
      expect(screen.getByText("Todos cleared")).toBeTruthy();
      cleanup();
      expiry?.();
      expect(reminders.getSnapshot()).toMatchObject({ cleared: false, previousPhases: null });
    } finally {
      reminders.dispose();
      adapter.dispose();
    }
  });

  test("accepts only R0's canonical set_todos response and gates missing capability", async () => {
    const requested = TODO_FIXTURE_SET_TODOS_REQUEST;
    const canonical = TODO_FIXTURE_SET_TODOS_RESPONSE;
    const calls: unknown[] = [];
    const runtime = new OmpRuntimeStore({
      threadId,
      transport: {
        send: async (request) => {
          calls.push(request);
          expect(runtime.getSnapshot().todoPhases).toEqual([]);
          return {
            todoPhases: canonical.map((phase) => ({
              name: phase.name,
              tasks: phase.tasks.map((task) => ({ ...task })),
            })),
          };
        },
      },
    });
    const adapter = new TodoStoreAdapter({ store: runtime });

    await expect(adapter.setTodos(requested)).resolves.toEqual(canonical);
    expect(calls).toMatchObject([{ command: { type: "set_todos", phases: requested } }]);
    expect(adapter.getSnapshot().source).toBe("set_todos");
    expect(adapter.getSnapshot().phases).toEqual(canonical);
    expect(adapter.getSnapshot().phases).not.toEqual(requested);
    adapter.dispose();

    const unavailable = new TodoStoreAdapter({
      store: new OmpRuntimeStore({ threadId }),
    });
    await expect(unavailable.setTodos(requested)).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.set_todos" },
    });
    unavailable.dispose();
  });
});

describe("U5 panel shell acceptance", () => {
  test("keeps the lifecycle region and retry action visible for the error state", () => {
    render(
      <PanelShell
        state={{
          open: true,
          lifecycle: "error",
          position: "right",
          title: "Todo panel",
          description: "Current todos",
          error: { code: "internal", message: "Replay failed", retryable: true },
          readOnly: true,
          pendingUpdates: 1,
        }}
        body={<p>Historical todo data</p>}
        onOpenChange={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Todo panel" }).getAttribute("data-panel-lifecycle"),
    ).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("Replay failed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("Historical todo data")).toBeTruthy();
  });
});
