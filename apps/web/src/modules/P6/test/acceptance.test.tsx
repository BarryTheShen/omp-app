import type { AppendMessage } from "@assistant-ui/react";
import type {
  CapabilityMap,
  OmpWire,
  RpcSessionEvent,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { createQueueController } from "../../R0/actions/actions";
import { OmpRuntimeStore } from "../../R0/store/store";
import { queueSubmitPolicy } from "../composer";
import { createQueueAdapter, P6_QUEUE_CAPABILITIES } from "../contract";
import { P6_DESCRIPTORS } from "../descriptors";
import {
  P6_FIXTURE_COVERAGE,
  P6_GET_STATE_AFTER_YIELD,
  P6_GET_STATE_CLEARED,
  P6_GET_STATE_DUPLICATE_TEXT,
  P6_GET_STATE_RECONNECTED,
  P6_GET_STATE_STREAMING,
  P6_INVENTORY_ROWS,
  P6_MUTATION_FIXTURES,
  P6_PROMPT_RESULT_FIXTURE,
  P6_QUEUE_FIXTURES,
  P6_QUEUE_UPDATE_CLEARED,
  P6_QUEUE_UPDATE_DUPLICATE_TEXT,
  P6_QUEUE_UPDATE_RECONNECTED,
  P6_QUEUE_UPDATE_STREAMING,
  P6_SESSION_SETTLED_FIXTURE,
  type P6GetStateFixture,
} from "../fixtures";
import { QueueModeSelector } from "../modes";

afterEach(cleanup);

const capabilities = {
  [P6_QUEUE_CAPABILITIES.steer]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.followUp]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.remove]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.promote]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.steeringMode]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.followUpMode]: { state: "available", via: "rpc" },
  [P6_QUEUE_CAPABILITIES.interruptMode]: { state: "available", via: "rpc" },
} as const satisfies CapabilityMap;

function appendMessage(text: string): AppendMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  } as unknown as AppendMessage;
}

function draft(text: string) {
  return { text, images: [], attachmentRefs: [] };
}

function harness(state: P6GetStateFixture = P6_GET_STATE_STREAMING) {
  const store = new OmpRuntimeStore({ threadId: state.sessionId as ThreadId });
  store.applySessionState(state);
  const commands: unknown[] = [];
  const send: RpcSessionSend = async ({ command }) => {
    commands.push(command);
    if (command.type === "remove_queued_message") {
      return { removed: true } as never;
    }
    if (command.type === "promote_queued_message") {
      return { promoted: true } as never;
    }
    return undefined as never;
  };
  const port = createQueueController({ store, send, capabilities });
  const adapter = createQueueAdapter(port);
  const ingestQueue = (event: OmpWire.QueueUpdateEvent, seq: number): void => {
    store.ingest({ kind: "omp", event } as RpcSessionEvent, seq);
  };
  return { store, port, adapter, commands, ingestQueue };
}

describe("P6 CC2/CC6 acceptance gate", () => {
  test("describes every owned inventory row and types fixtures as omp queue snapshots", () => {
    const descriptorRows = P6_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(descriptorRows).toHaveLength(P6_INVENTORY_ROWS.length);
    expect(new Set(descriptorRows).size).toBe(P6_INVENTORY_ROWS.length);
    expect([...descriptorRows].sort()).toEqual([...P6_INVENTORY_ROWS].sort());

    const fixtureRows = P6_FIXTURE_COVERAGE.map(({ inventoryId }) => inventoryId);
    expect(fixtureRows).toHaveLength(P6_INVENTORY_ROWS.length);
    expect(new Set(fixtureRows).size).toBe(P6_INVENTORY_ROWS.length);
    expect([...fixtureRows].sort()).toEqual([...P6_INVENTORY_ROWS].sort());

    for (const fixture of Object.values(P6_QUEUE_FIXTURES)) {
      expect(fixture.getState.queuedMessages).toEqual({
        steering: expect.any(Array),
        followUp: expect.any(Array),
      });
      for (const event of fixture.queueUpdates) {
        expect(event.type).toBe("queue_update");
        expect(event.steering).toEqual(expect.any(Array));
        expect(event.followUp).toEqual(expect.any(Array));
      }
    }
    expect(P6_GET_STATE_STREAMING.queuedMessages).toEqual({
      steering: P6_QUEUE_UPDATE_STREAMING.steering,
      followUp: P6_QUEUE_UPDATE_STREAMING.followUp,
    });
    expect(P6_MUTATION_FIXTURES).toMatchObject({
      removeAccepted: { removed: true },
      removeStale: { removed: false },
      promoteAccepted: { promoted: true },
      promoteStale: { promoted: false },
    });
  });

  test("routes streaming Enter to steering and Ctrl+Enter to the distinct follow-up lane", async () => {
    expect(
      queueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("steer this") }),
    ).toEqual({ delivery: "steer" });
    expect(
      queueSubmitPolicy({
        isStreaming: true,
        keyChord: "ctrlEnter",
        draft: draft("follow after yield"),
      }),
    ).toEqual({ delivery: "followUp" });

    const state = harness();
    state.adapter.adapter.steer(appendMessage("steer this"));
    state.adapter.adapter.enqueue(appendMessage("follow after yield"));
    await waitFor(() =>
      expect(state.commands).toEqual([
        { type: "steer", message: "steer this" },
        { type: "follow_up", message: "follow after yield" },
      ]),
    );

    state.ingestQueue(
      {
        type: "queue_update",
        steering: [...P6_QUEUE_UPDATE_STREAMING.steering, "steer this"],
        followUp: [...P6_QUEUE_UPDATE_STREAMING.followUp, "follow after yield"],
      },
      1,
    );
    expect(state.adapter.getSnapshot().steerItems.map(({ prompt }) => prompt)).toEqual([
      "steer the running turn",
      "steer this",
    ]);
    expect(state.adapter.getSnapshot().items.map(({ prompt }) => prompt)).toEqual([
      "summarize after yield",
      "follow after yield",
    ]);
    state.adapter.dispose();
  });

  test("saves session-scoped steering, follow-up, and interrupt modes through R0", async () => {
    const state = harness();
    render(<QueueModeSelector open onOpenChange={() => undefined} port={state.port} />);

    fireEvent.click(
      within(screen.getByRole("group", { name: "Steering mode" })).getByRole("button", {
        name: "One at a time",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "After this turn mode" })).getByRole("button", {
        name: "All",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Interrupt mode" })).getByRole("button", {
        name: "Wait",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save modes" }));

    await waitFor(() =>
      expect(state.commands).toEqual([
        { type: "set_steering_mode", mode: "one-at-a-time" },
        { type: "set_follow_up_mode", mode: "all" },
        { type: "set_interrupt_mode", mode: "wait" },
      ]),
    );
    expect(P6_GET_STATE_STREAMING.interruptMode).toBe("immediate");
    state.store.applySessionState(P6_GET_STATE_AFTER_YIELD);
    expect(state.adapter.getSnapshot()).toMatchObject({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
      isStreaming: false,
    });
    state.adapter.dispose();
  });

  test("confirms removal without optimism, then projects a real queue clear", async () => {
    const state = harness();
    const item = state.adapter
      .getSnapshot()
      .items.find(({ prompt }) => prompt === "summarize after yield");
    expect(item).toBeDefined();
    state.adapter.adapter.remove(item?.id ?? "");

    await waitFor(() =>
      expect(state.commands).toContainEqual({
        type: "remove_queued_message",
        message: "summarize after yield",
        queue: "followUp",
      }),
    );
    expect(state.adapter.getSnapshot().items.map(({ prompt }) => prompt)).toEqual([
      "summarize after yield",
    ]);

    state.ingestQueue(
      {
        type: "queue_update",
        steering: P6_QUEUE_UPDATE_STREAMING.steering,
        followUp: [],
      },
      1,
    );
    expect(state.adapter.getSnapshot().items).toEqual([]);

    state.ingestQueue(P6_QUEUE_UPDATE_CLEARED, 2);
    state.store.applySessionState(P6_GET_STATE_CLEARED);
    expect(state.adapter.getSnapshot()).toMatchObject({ items: [], steerItems: [] });
    state.adapter.dispose();
  });

  test("deduplicates repeated events, retains duplicate-text chips, and refetches after reconnect", () => {
    const state = harness(P6_GET_STATE_DUPLICATE_TEXT);
    state.ingestQueue(P6_QUEUE_UPDATE_DUPLICATE_TEXT, 1);
    state.ingestQueue(P6_QUEUE_UPDATE_DUPLICATE_TEXT, 2);
    const duplicateItems = state.adapter.getSnapshot().steerItems;
    expect(duplicateItems.map(({ prompt }) => prompt)).toEqual(["same text", "same text"]);
    expect(new Set(duplicateItems.map(({ id }) => id)).size).toBe(2);

    state.ingestQueue(P6_QUEUE_UPDATE_DUPLICATE_TEXT, 2);
    expect(state.adapter.getSnapshot().steerItems.map(({ id }) => id)).toEqual(
      duplicateItems.map(({ id }) => id),
    );

    state.store.applySessionState(P6_GET_STATE_RECONNECTED);
    state.store.resetSequence(2);
    state.ingestQueue(P6_QUEUE_UPDATE_RECONNECTED, 3);
    expect(state.adapter.getSnapshot()).toMatchObject({
      steerItems: [expect.objectContaining({ prompt: "authoritative after reconnect" })],
      items: [],
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      interruptMode: "wait",
    });

    state.store.ingest(P6_PROMPT_RESULT_FIXTURE, 4);
    expect(state.store.getSnapshot().prompt.promptResult?.sessionSettled).toBe(false);
    state.store.ingest(P6_SESSION_SETTLED_FIXTURE, 5);
    expect(state.store.getSnapshot().prompt.sessionSettled).toBe(true);
    expect(state.adapter.getSnapshot().steerItems[0]?.prompt).toBe("authoritative after reconnect");
    state.adapter.dispose();
  });
});
