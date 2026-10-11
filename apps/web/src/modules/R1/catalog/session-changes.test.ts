import type { AppClient } from "@omp-app/client";
import type { SessionFileChanged } from "@omp-app/contracts";
import { FolderPath, SessionFilePath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { watchSessionFileChanges } from "./session-changes";

type FakeSubscriptionHandle = {
  readonly onEvent: (listener: (change: SessionFileChanged) => void) => () => void;
  readonly unsubscribe: () => Promise<void>;
};

interface FakeSubscription {
  readonly subscription: FakeSubscriptionHandle;
  readonly listeners: Set<(change: SessionFileChanged) => void>;
  /** Settles when the subscription is released. */
  readonly released: Promise<void>;
  unsubscribes(): number;
}

function fakeSubscription(): FakeSubscription {
  const listeners = new Set<(change: SessionFileChanged) => void>();
  const released = Promise.withResolvers<void>();
  let unsubscribes = 0;
  return {
    subscription: {
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unsubscribe: async () => {
        unsubscribes += 1;
        released.resolve();
      },
    },
    listeners,
    released: released.promise,
    unsubscribes: () => unsubscribes,
  };
}

function clientWith(subscribed: Promise<FakeSubscriptionHandle>): AppClient {
  return { subscribe: () => subscribed } as unknown as AppClient;
}

const turnStarted: SessionFileChanged = {
  folder: FolderPath.parse("/workspace/project"),
  sessionFile: SessionFilePath.parse("/workspace/project/.omp/chat-a.jsonl"),
  id: ThreadId.parse("chat-a"),
  kind: "updated",
};

describe("watchSessionFileChanges", () => {
  test("delivers the server's change events, and ending the watch removes the listener and releases the subscription", async () => {
    const fake = fakeSubscription();
    const subscribed = Promise.withResolvers<FakeSubscriptionHandle>();
    const received: SessionFileChanged[] = [];
    const stop = watchSessionFileChanges(clientWith(subscribed.promise), (change) =>
      received.push(change),
    );
    subscribed.resolve(fake.subscription);
    await subscribed.promise;

    for (const listener of fake.listeners) listener(turnStarted);
    expect(received).toEqual([turnStarted]);

    stop();
    expect(fake.listeners.size).toBe(0);
    await fake.released;
    expect(fake.unsubscribes()).toBe(1);
  });

  test("a watch that ends before its subscription arrives releases it once, and delivers nothing", async () => {
    const fake = fakeSubscription();
    const subscribed = Promise.withResolvers<FakeSubscriptionHandle>();
    const received: SessionFileChanged[] = [];
    const stop = watchSessionFileChanges(clientWith(subscribed.promise), (change) =>
      received.push(change),
    );
    stop();
    subscribed.resolve(fake.subscription);
    await fake.released;

    expect(fake.unsubscribes()).toBe(1);
    expect(fake.listeners.size).toBe(0);
    expect(received).toEqual([]);
  });

  test("a failed subscription ends quietly: the list keeps what it has and the watch can still be ended", async () => {
    const subscribed = Promise.withResolvers<FakeSubscriptionHandle>();
    const stop = watchSessionFileChanges(clientWith(subscribed.promise), () => {
      throw new Error("no change should be delivered");
    });
    subscribed.reject(new Error("the connection is down"));
    await expect(subscribed.promise).rejects.toThrow("the connection is down");

    expect(() => stop()).not.toThrow();
  });
});
