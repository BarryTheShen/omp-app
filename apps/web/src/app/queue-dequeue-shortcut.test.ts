import { describe, expect, test, vi } from "vitest";
import {
  createQueueAdapter,
  P6_QUEUE_CAPABILITIES,
  type QueuePort,
  type QueueSnapshot,
} from "@/modules/P6/contract";
import { P6_SHORTCUT_DESCRIPTORS } from "@/modules/P6/shortcuts/descriptors";
import { MemoryPreferenceStore, ShortcutRegistry } from "@/shortcuts/registry";
import { QUEUE_DEQUEUE_MESSAGES, registerQueueDequeueShortcut } from "./queue-dequeue-shortcut";

/** A queue whose remove calls are recorded, so a test can see what left the queue. */
function queueOf(queued: Partial<QueueSnapshot>) {
  const removed: string[] = [];
  const snapshot: QueueSnapshot = {
    steering: [],
    followUp: [],
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "wait",
    isStreaming: true,
    ...queued,
  };
  const port = {
    getSnapshot: () => snapshot,
    getCapabilities: () => ({
      [P6_QUEUE_CAPABILITIES.remove]: { state: "available" as const, via: "rpc" as const },
      [P6_QUEUE_CAPABILITIES.followUp]: { state: "available" as const, via: "rpc" as const },
    }),
    subscribe: () => () => undefined,
    remove: async ({ message }: { message: string }) => {
      removed.push(message);
      return { changed: true };
    },
  } as unknown as QueuePort;
  return { controller: createQueueAdapter(port), removed };
}

/** Registers the action on a registry that holds the real P6 descriptors, and returns a press of Alt+Up. */
function setup(queued: Partial<QueueSnapshot>, boxText = "") {
  const { controller, removed } = queueOf(queued);
  const restored: string[] = [];
  const notify = vi.fn();
  const fail = vi.fn();
  const registry = new ShortcutRegistry([...P6_SHORTCUT_DESCRIPTORS], {
    preferenceStore: new MemoryPreferenceStore(),
  });
  registerQueueDequeueShortcut({
    registry,
    queue: controller,
    draft: () => ({ text: boxText, attachmentRefs: [] }),
    restore: (request) => {
      restored.push(request.text);
    },
    notify,
    fail,
  });
  const press = () =>
    registry.dispatch(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }), "composer");
  return { press, restored, removed, notify, fail };
}

describe("Alt+Up brings the last queued message back into the box", () => {
  test("takes the most recent steering message before a follow-up, and removes it from the queue", async () => {
    const { press, restored, removed, notify } = setup({
      steering: ["steer first", "steer last"],
      followUp: ["follow up"],
    });
    expect(press().handled).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(QUEUE_DEQUEUE_MESSAGES.restored));
    expect(restored).toEqual(["steer last"]);
    expect(removed).toEqual(["steer last"]);
  });

  test("with nothing queued, says so and changes nothing", () => {
    const { press, restored, removed, notify } = setup({});
    press();
    expect(notify).toHaveBeenCalledWith(QUEUE_DEQUEUE_MESSAGES.nothingQueued);
    expect(restored).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("with text already in the box, says to clear it and leaves the queue alone", () => {
    const { press, restored, removed, fail } = setup({ followUp: ["follow up"] }, "typed");
    press();
    expect(fail).toHaveBeenCalledWith(QUEUE_DEQUEUE_MESSAGES.boxHasText);
    expect(restored).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("skips a steering message omp already sent into the reply, and takes the follow-up", async () => {
    const { press, restored, removed, notify } = setup({
      steering: ["already sent"],
      followUp: ["follow up"],
      liveSteered: 1,
    });
    press();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(QUEUE_DEQUEUE_MESSAGES.restored));
    expect(restored).toEqual(["follow up"]);
    expect(removed).toEqual(["follow up"]);
  });

  test("when every queued message is already in the reply, says so in plain words and removes nothing", () => {
    const { press, restored, removed, notify } = setup({
      steering: ["already sent"],
      liveSteered: 1,
    });
    press();
    expect(notify).toHaveBeenCalledWith(QUEUE_DEQUEUE_MESSAGES.alreadySent);
    expect(restored).toEqual([]);
    expect(removed).toEqual([]);
  });
});
