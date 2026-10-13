import type { AppClient } from "@omp-app/client";
import { OmpCommandGateway, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { watchSavedCompactions } from "./compaction-watch";

const threadId = ThreadId.parse("thread-compaction-watch");

interface Opened {
  readonly port: unknown;
  readonly event: string;
  readonly scope: string | undefined;
  listener?: (payload: unknown) => void;
  unsubscribed: number;
}

/** A client that records each subscription it opens and lets the test send the typed events. */
function fakeClient(opened: Opened[]): Pick<AppClient, "subscribe"> {
  return {
    subscribe: (port: unknown, event: string, options?: { readonly scope?: string }) => {
      const record: Opened = { port, event, scope: options?.scope, unsubscribed: 0 };
      opened.push(record);
      return Promise.resolve({
        onEvent: (listener: (payload: unknown) => void) => {
          record.listener = listener;
          return () => {
            record.listener = undefined;
          };
        },
        unsubscribe: async () => {
          record.unsubscribed += 1;
        },
      });
    },
  } as unknown as Pick<AppClient, "subscribe">;
}

/** Lets the subscription's open promise settle, by yielding to the microtask queue. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

describe("watching a background /compact's saved outcome", () => {
  test("listens to this thread's compaction events, and calls back once per saved compaction only", async () => {
    const opened: Opened[] = [];
    const onSaved = vi.fn();
    const stop = watchSavedCompactions(fakeClient(opened), threadId, onSaved);
    await settle();

    expect(opened).toMatchObject([
      { port: OmpCommandGateway, event: "compaction", scope: threadId },
    ]);
    opened[0]?.listener?.({ threadId, outcome: "failed" });
    expect(onSaved).not.toHaveBeenCalled();
    opened[0]?.listener?.({ threadId, outcome: "saved" });
    expect(onSaved).toHaveBeenCalledTimes(1);

    stop();
    await settle();
    expect(opened[0]?.unsubscribed).toBe(1);
    opened[0]?.listener?.({ threadId, outcome: "saved" });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("stopping before the subscription opens closes it as soon as it opens, and nothing is called", async () => {
    const opened: Opened[] = [];
    const onSaved = vi.fn();
    const stop = watchSavedCompactions(fakeClient(opened), threadId, onSaved);
    stop();
    await settle();

    expect(opened[0]?.unsubscribed).toBe(1);
    expect(opened[0]?.listener).toBeUndefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test("a subscription that fails leaves the transcript as it was, and does not throw", async () => {
    const failing = {
      subscribe: () => Promise.reject(new Error("the command gateway is not available")),
    } as unknown as Pick<AppClient, "subscribe">;
    const onSaved = vi.fn();
    const stop = watchSavedCompactions(failing, threadId, onSaved);
    await settle();

    expect(onSaved).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
