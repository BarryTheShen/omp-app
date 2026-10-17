import type { AppendMessage } from "@assistant-ui/react";
import type { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createQueueAdapter,
  P6_QUEUE_CAPABILITIES,
  type QueueAdapterSnapshot,
  type QueuePort,
  type QueueSnapshot,
} from ".";

const available = (capability: string) => ({
  [capability]: { state: "available" as const, via: "rpc" as const },
});

function portFixture(
  initial: QueueSnapshot,
  capabilities = {},
): {
  port: QueuePort;
  calls: { readonly kind: string; readonly value: unknown }[];
  replace(snapshot: QueueSnapshot): void;
  listenerCount(): number;
} {
  let snapshot = initial;
  const listeners = new Set<(next: QueueSnapshot) => void>();
  const calls: { kind: string; value: unknown }[] = [];
  const port = {
    getSnapshot: () => snapshot,
    getCapabilities: () => capabilities,
    subscribe: (listener: (next: QueueSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: async (intent: unknown) => {
      calls.push({ kind: "submit", value: intent });
    },
    remove: async (item: unknown) => {
      calls.push({ kind: "remove", value: item });
      return { changed: true };
    },
    promote: async (message: string) => {
      calls.push({ kind: "promote", value: message });
      return { changed: true };
    },
    setModes: async (changes: unknown) => {
      calls.push({ kind: "setModes", value: changes });
    },
    answerExtensionUi: async () => undefined,
    answerHostTool: async () => undefined,
    answerHostUri: async () => undefined,
    onAddToolResult: async () => undefined,
  } as unknown as QueuePort;
  return {
    port,
    calls,
    replace(next) {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

const idleSnapshot: QueueSnapshot = {
  steering: ["same", "same"],
  followUp: ["later"],
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "wait",
  isStreaming: true,
};

describe("P6 QueuePort adapter", () => {
  test("projects the latest R0 snapshot into stable lane items and modes", () => {
    const fixture = portFixture(idleSnapshot, {
      ...available(P6_QUEUE_CAPABILITIES.remove),
      ...available(P6_QUEUE_CAPABILITIES.promote),
    });
    const controller = createQueueAdapter(fixture.port);
    const snapshot = controller.getSnapshot();

    expect(snapshot).toMatchObject<Partial<QueueAdapterSnapshot>>({
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      interruptMode: "wait",
      isStreaming: true,
    });
    expect(snapshot.steerItems.map((item) => item.prompt)).toEqual(["same", "same"]);
    expect(new Set(snapshot.steerItems.map((item) => item.id)).size).toBe(2);
    expect(snapshot.items[0]).toMatchObject({
      prompt: "later",
      lane: "followUp",
      status: "queued",
      canRemove: true,
      canPromote: true,
    });
    expect(controller.adapter.items).toHaveLength(1);
    controller.dispose();
  });
  test("keeps steering messages already sent into the reply non-removable", () => {
    const fixture = portFixture(
      { ...idleSnapshot, liveSteered: 1 },
      { ...available(P6_QUEUE_CAPABILITIES.remove) },
    );
    const controller = createQueueAdapter(fixture.port);
    expect(controller.getSnapshot().steerItems.map((item) => item.canRemove)).toEqual([
      false,
      true,
    ]);
    controller.dispose();
  });

  test("delegates enqueue and steer through R0 admission with text and images", async () => {
    const fixture = portFixture(
      { ...idleSnapshot, steering: [], followUp: [] },
      {
        ...available(P6_QUEUE_CAPABILITIES.steer),
        ...available(P6_QUEUE_CAPABILITIES.followUp),
      },
    );
    const controller = createQueueAdapter(fixture.port);
    const message = {
      role: "user",
      content: [
        { type: "text", text: "queued text" },
        { type: "image", image: "data:image/png;base64,abc" },
      ],
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } as unknown as AppendMessage;

    controller.adapter.enqueue(message);
    controller.adapter.steer(message);
    await Promise.resolve();
    expect(fixture.calls.map((call) => call.value)).toEqual([
      {
        text: "queued text",
        delivery: "followUp",
        images: [
          {
            type: "image",
            data: "data:image/png;base64,abc",
            mimeType: "image/*",
            url: "data:image/png;base64,abc",
          },
        ],
      },
      {
        text: "queued text",
        delivery: "steer",
        images: [
          {
            type: "image",
            data: "data:image/png;base64,abc",
            mimeType: "image/*",
            url: "data:image/png;base64,abc",
          },
        ],
      },
    ]);
    controller.dispose();
  });

  test("maps remove and follow-up promotion without optimistic queue state", async () => {
    const fixture = portFixture(idleSnapshot, {
      ...available(P6_QUEUE_CAPABILITIES.remove),
      ...available(P6_QUEUE_CAPABILITIES.promote),
    });
    const controller = createQueueAdapter(fixture.port);
    const followUpId = controller.getSnapshot().items[0]?.id;
    const steerId = controller.getSnapshot().steerItems[0]?.id;
    if (!followUpId || !steerId) throw new Error("queue fixture did not produce item ids");

    controller.adapter.remove(steerId);
    controller.adapter.move(followUpId, { lane: "steer" });
    await Promise.resolve();
    expect(fixture.calls).toEqual([
      { kind: "remove", value: { lane: "steering", message: "same" } },
      { kind: "promote", value: "later" },
    ]);
    expect(controller.getSnapshot().items).toHaveLength(1);
    controller.dispose();
  });

  test("returns typed capability errors for unsupported edit and reorder", async () => {
    const errors: AppFailure[] = [];
    const fixture = portFixture(idleSnapshot, {});
    const controller = createQueueAdapter(fixture.port, { onError: (error) => errors.push(error) });
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("queue fixture did not produce an item id");

    controller.adapter.edit(id, {
      role: "user",
      content: "edited",
      metadata: { custom: {} },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    } as unknown as AppendMessage);
    controller.adapter.move(id, { lane: "queue", insertBefore: "another" });
    await Promise.resolve();
    expect(errors).toMatchObject([
      { appError: { code: "unavailable", capability: "upstream.queue-edit" } },
      { appError: { code: "unavailable", capability: "upstream.queue-reorder" } },
    ]);
    expect(controller.getSnapshot().lastError).toMatchObject({
      appError: { capability: "upstream.queue-reorder" },
    });
    controller.dispose();
  });

  test("reprojects after R0 publishes a queue snapshot without owning queue arrays", () => {
    const fixture = portFixture(idleSnapshot);
    const controller = createQueueAdapter(fixture.port);
    const updates: QueueAdapterSnapshot[] = [];
    const unsubscribe = controller.subscribe((snapshot) => updates.push(snapshot));
    fixture.replace({ ...idleSnapshot, steering: [], followUp: ["new item"], isStreaming: false });

    expect(updates.at(-1)?.items.map((item) => item.prompt)).toEqual(["new item"]);
    expect(controller.adapter.items.map((item) => item.prompt)).toEqual(["new item"]);
    unsubscribe();
    controller.dispose();
  });

  test("listens to R0 only while a listener is subscribed, and keeps updating after dispose", () => {
    const fixture = portFixture(idleSnapshot);
    const controller = createQueueAdapter(fixture.port);
    const unsubscribeFirst = controller.subscribe(() => undefined);
    expect(fixture.listenerCount()).toBe(1);
    unsubscribeFirst();
    expect(fixture.listenerCount()).toBe(0);
    // React StrictMode runs an effect's cleanup and then its setup again: dispose, then subscribe.
    controller.dispose();
    const updates: QueueAdapterSnapshot[] = [];
    const unsubscribe = controller.subscribe((snapshot) => updates.push(snapshot));
    expect(fixture.listenerCount()).toBe(1);
    fixture.replace({ ...idleSnapshot, steering: [], followUp: ["after strict mode"] });
    expect(updates.at(-1)?.items.map((item) => item.prompt)).toEqual(["after strict mode"]);
    unsubscribe();
    controller.dispose();
  });
});
