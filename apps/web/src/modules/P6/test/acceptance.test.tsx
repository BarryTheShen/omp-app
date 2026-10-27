import type { AppendMessage } from "@assistant-ui/react";
import type { CapabilityMap, ChatSessionRequest, OmpWire, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { createQueueController } from "../../R0/actions/actions";
import { ompEvent } from "../../R0/store/session-events";
import { OmpRuntimeStore } from "../../R0/store/store";
import { QueueLaneBar } from "../bar";
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

const EXPECTED_FIXTURE_LABELS = {
  "P5.promote-queued-message": ["queue-mutations", "promote-result"],
  "P5.queue": ["queue-composer", "local-queue-command"],
  "P5.remove-queued-message": ["queue-mutations", "remove-result"],
  "P5.follow-up-queue-mode": ["queue-modes", "all-and-one-at-a-time"],
  "P5.interrupt-mode": ["queue-modes", "immediate-and-wait"],
  "P5.steering-queue-mode": ["queue-modes", "all-and-one-at-a-time"],
  "P5.queue-mode-selector-component": ["queue-modes", "session-scoped-selector"],
  "P5.dequeue-queued-message": ["queue-composer", "restore-draft"],
  "P5.follow-up-on-ctrl-enter-ctrl-q": ["queue-composer", "follow-up-chords"],
  "P5.queue-shorthand-and-queued-lists": ["queue-composer", "shorthand-and-sequential-list"],
  "P5.steer-on-enter-while-streaming": ["queue-composer", "streaming-enter-steer"],
  "P5.app-message-dequeue": ["queue-composer", "alt-up-descriptor"],
  "P5.app-message-followup": ["queue-composer", "ctrl-enter-descriptor"],
  "P5.queued-steering-follow-up-bar": ["queue-bar", "two-lane-authoritative-snapshot"],
} as const;
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

function harness(state: P6GetStateFixture = P6_GET_STATE_STREAMING, removeAccepted = true) {
  const store = new OmpRuntimeStore({ threadId: state.sessionId as ThreadId });
  store.applySessionState(state);
  const commands: unknown[] = [];
  const send: ChatSessionRequest = async ({ method, params }) => {
    commands.push({ method, params });
    if (method === "remove_queued_message") {
      return { removed: removeAccepted } as never;
    }
    if (method === "promote_queued_message") {
      return { promoted: true } as never;
    }
    return undefined as never;
  };
  const port = createQueueController({ store, send, capabilities });
  const adapter = createQueueAdapter(port);
  const ingestQueue = (event: OmpWire.QueueUpdateEvent, seq: number): void => {
    store.ingest(ompEvent(event), seq);
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
    expect(Object.keys(EXPECTED_FIXTURE_LABELS).sort()).toEqual([...P6_INVENTORY_ROWS].sort());
    for (const fixture of P6_FIXTURE_COVERAGE) {
      expect([fixture.scenario, fixture.proof]).toEqual(
        EXPECTED_FIXTURE_LABELS[fixture.inventoryId as keyof typeof EXPECTED_FIXTURE_LABELS],
      );
    }

    for (const fixture of Object.values(P6_QUEUE_FIXTURES)) {
      expect(fixture.getState.queuedMessages).toMatchObject({
        steering: expect.any(Array),
        followUp: expect.any(Array),
      });
      expect(fixture.getState.queuedMessages?.liveSteered ?? 0).toEqual(expect.any(Number));
      for (const event of fixture.queueUpdates) {
        expect(event.type).toBe("queue_update");
        expect(event.steering).toEqual(expect.any(Array));
        expect(event.followUp).toEqual(expect.any(Array));
      }
    }
    expect(P6_GET_STATE_STREAMING.queuedMessages).toEqual({
      steering: P6_QUEUE_UPDATE_STREAMING.steering,
      followUp: P6_QUEUE_UPDATE_STREAMING.followUp,
      liveSteered: P6_QUEUE_UPDATE_STREAMING.liveSteered,
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
        { method: "steer", params: { text: "steer this" } },
        { method: "follow_up", params: { text: "follow after yield" } },
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
        { method: "set_steering_mode", params: { mode: "one-at-a-time" } },
        { method: "set_follow_up_mode", params: { mode: "all" } },
        { method: "set_interrupt_mode", params: { mode: "wait" } },
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
        method: "remove_queued_message",
        params: { message: "summarize after yield", queue: "followUp" },
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

  test("marks live-steered chips as sent and leaves Remove on the remaining steering items", async () => {
    const state = harness();
    state.ingestQueue(
      {
        ...P6_QUEUE_UPDATE_STREAMING,
        steering: [...P6_QUEUE_UPDATE_STREAMING.steering, "steer the next tool"],
        liveSteered: 1,
      },
      1,
    );
    render(<QueueLaneBar controller={state.adapter} />);

    const sent = screen.getByText("steer the running turn").closest("li");
    expect(sent?.getAttribute("data-queue-status")).toBe("sent");
    expect(
      screen.queryByRole("button", {
        name: "Remove steering message: steer the running turn",
      }),
    ).toBeNull();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove steering message: steer the next tool" }),
    ).toBeTruthy();
    expect(
      state.adapter
        .getSnapshot()
        .steerItems.map(({ prompt, status, canRemove }) => [prompt, status, canRemove]),
    ).toEqual([
      ["steer the running turn", "sent", false],
      ["steer the next tool", "queued", true],
    ]);
    const liveItem = state.adapter.getSnapshot().steerItems[0];
    if (!liveItem) throw new Error("missing live-steered message");
    state.adapter.adapter.remove(liveItem.id);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "omp already sent this steering message into the reply.",
    );
    expect(state.commands).not.toContainEqual(
      expect.objectContaining({ method: "remove_queued_message" }),
    );
    state.adapter.dispose();
  });

  test("a refused removal keeps the message queued and reports the refusal", async () => {
    const state = harness(P6_GET_STATE_STREAMING, false);
    render(<QueueLaneBar controller={state.adapter} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove follow-up message: summarize after yield" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "omp did not remove this message. It may already be part of the reply.",
    );
    expect(state.adapter.getSnapshot().items.map(({ prompt }) => prompt)).toEqual([
      "summarize after yield",
    ]);
    expect(state.commands).toContainEqual({
      method: "remove_queued_message",
      params: { message: "summarize after yield", queue: "followUp" },
    });
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
