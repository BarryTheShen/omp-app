import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  createQueueAdapter,
  P6_QUEUE_CAPABILITIES,
  type QueuePort,
  type QueueSnapshot,
} from "../contract";
import { QueueLaneBar, useQueueOpen } from "./bar";

afterEach(cleanup);

const snapshot: QueueSnapshot = {
  steering: ["fix the failing test"],
  followUp: ["summarize after yield"],
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "wait",
  isStreaming: true,
};

function fixture(next: QueueSnapshot = snapshot) {
  let current = next;
  const listeners = new Set<(value: QueueSnapshot) => void>();
  const calls: Array<{ kind: string; message?: string }> = [];
  const port = {
    getSnapshot: () => current,
    getCapabilities: () => ({
      [P6_QUEUE_CAPABILITIES.remove]: { state: "available" as const, via: "rpc" as const },
      [P6_QUEUE_CAPABILITIES.promote]: { state: "available" as const, via: "rpc" as const },
    }),
    subscribe: (listener: (value: QueueSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: async () => undefined,
    remove: async ({ message }: { message: string }) => {
      calls.push({ kind: "remove", message });
      return { changed: true };
    },
    promote: async (message: string) => {
      calls.push({ kind: "promote", message });
      return { changed: true };
    },
    setModes: async () => undefined,
    answerDialog: async () => undefined,
    answerHostTool: async () => undefined,
    updateHostTool: async () => true,
    answerHostUri: async () => undefined,
    onAddToolResult: async () => undefined,
  } as unknown as QueuePort;
  return {
    controller: createQueueAdapter(port),
    calls,
    replace(value: QueueSnapshot) {
      current = value;
      for (const listener of listeners) listener(value);
    },
  };
}

describe("QueueLaneBar", () => {
  test("renders the steering and after-yield lanes from the adapter snapshot", () => {
    const state = fixture();
    render(<QueueLaneBar controller={state.controller} />);

    expect(screen.getByRole("complementary", { name: "Queued messages" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Steering" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "After this turn" })).toBeTruthy();
    expect(screen.getByText("fix the failing test")).toBeTruthy();
    expect(screen.getByText("summarize after yield")).toBeTruthy();
  });

  test("shows a queue that filled between the first render and the subscription", () => {
    const full = fixture().controller;
    const empty = fixture({ ...snapshot, steering: [], followUp: [] }).controller.getSnapshot();
    let reads = 0;
    // The first read is the first render, which sees an empty queue; the queue fills before the bar subscribes.
    const controller = {
      ...full,
      getSnapshot: () => {
        reads += 1;
        return reads === 1 ? empty : full.getSnapshot();
      },
    };
    render(<QueueLaneBar controller={controller} />);
    expect(screen.getByText("fix the failing test")).toBeTruthy();
  });

  test("remove and promote call the adapter exactly once", () => {
    const state = fixture();
    render(<QueueLaneBar controller={state.controller} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove steering message: fix the failing test" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Promote queued message: summarize after yield" }),
    );
    expect(state.calls).toEqual([
      { kind: "remove", message: "fix the failing test" },
      { kind: "promote", message: "summarize after yield" },
    ]);
  });

  test("disconnect keeps queued items visible and disables actions with a reason", () => {
    const state = fixture();
    render(
      <QueueLaneBar
        connection={{ state: "reconnecting", reason: "Waiting for the server" }}
        controller={state.controller}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Waiting for the server");
    expect(
      (
        screen.getByRole("button", {
          name: "Remove steering message: fix the failing test",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Promote queued message: summarize after yield",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("fix the failing test")).toBeTruthy();
  });

  test("collapses when both lanes are empty", () => {
    const state = fixture({ ...snapshot, steering: [], followUp: [] });
    render(<QueueLaneBar controller={state.controller} />);
    expect(screen.queryByRole("complementary", { name: "Queued messages" })).toBeNull();
  });

  test("the queue's row is open only while a message waits, and follows the queue as it fills and empties", () => {
    const state = fixture({ ...snapshot, steering: [], followUp: [] });
    const { result } = renderHook(() => useQueueOpen(state.controller));
    expect(result.current).toBe(false);
    act(() => state.replace(snapshot));
    expect(result.current).toBe(true);
    act(() => state.replace({ ...snapshot, steering: [], followUp: [] }));
    expect(result.current).toBe(false);
  });
});
