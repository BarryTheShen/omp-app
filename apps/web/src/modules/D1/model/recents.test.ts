import { AppFailure, type Revision } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ModelRef } from "../contract";
import { RecentModels, type RecentModelsPort } from "./recents";

const HAIKU = { provider: "anthropic", modelId: "claude-3-haiku" } satisfies ModelRef;
const SONNET = { provider: "anthropic", modelId: "claude-3-sonnet" } satisfies ModelRef;
const HAIKU_KEY = "anthropic/claude-3-haiku";
const SONNET_KEY = "anthropic/claude-3-sonnet";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type MemoryPort = RecentModelsPort & {
  readonly savedKeys: string[];
  readonly writes: string[][];
  readonly revision: () => Revision;
};

function memoryPort(initialKeys: readonly string[] = []): MemoryPort {
  const savedKeys = [...initialKeys];
  const writes: string[][] = [];
  let revisionNumber = 1;
  return {
    savedKeys,
    writes,
    revision: () => `revision-${revisionNumber}` as Revision,
    read: async () => ({
      keys: [...savedKeys],
      revision: `revision-${revisionNumber}` as Revision,
    }),
    write: async (keys) => {
      savedKeys.splice(0, savedKeys.length, ...keys);
      writes.push([...keys]);
      revisionNumber += 1;
      return `revision-${revisionNumber}` as Revision;
    },
  };
}

describe("RecentModels dialog instances", () => {
  test("keeps a successful pick visible through a reopened read and after its save", async () => {
    const port = memoryPort();
    const original = new RecentModels(port);
    await original.read();
    const save = original.record(HAIKU);
    const reopened = new RecentModels(port);
    await reopened.read();
    expect(reopened.getSnapshot().keys).toEqual([HAIKU_KEY]);
    await save;
    expect(reopened.getSnapshot().keys).toEqual([HAIKU_KEY]);
    const openedLater = new RecentModels(port);
    await openedLater.read();
    expect(openedLater.getSnapshot()).toEqual({ keys: [HAIKU_KEY], error: null });
    original.dispose();
    reopened.dispose();
    openedLater.dispose();
  });

  test("keeps a pick ahead of a non-empty saved list while its write is in flight", async () => {
    const port = memoryPort([SONNET_KEY]);
    const writeStarted = deferred<void>();
    const writeRelease = deferred<Revision>();
    const delayedPort: RecentModelsPort = {
      read: port.read,
      write: async (keys, revision) => {
        writeStarted.resolve();
        const result = await writeRelease.promise;
        await port.write(keys, revision);
        return result;
      },
    };
    const original = new RecentModels(delayedPort);
    await original.read();
    const save = original.record(HAIKU);
    await writeStarted.promise;
    const reopened = new RecentModels(delayedPort);
    await reopened.read();
    expect(reopened.getSnapshot().keys).toEqual([HAIKU_KEY, SONNET_KEY]);
    writeRelease.resolve("revision-2" as Revision);
    await save;
    original.dispose();
    reopened.dispose();
  });

  test("keeps two picks queued in order and saves both", async () => {
    const port = memoryPort();
    const firstWriteStarted = deferred<void>();
    const firstWriteRelease = deferred<Revision>();
    let writeCount = 0;
    const delayedPort: RecentModelsPort = {
      read: port.read,
      write: async (keys, revision) => {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted.resolve();
          await firstWriteRelease.promise;
        }
        await port.write(keys, revision);
        return port.revision();
      },
    };
    const recents = new RecentModels(delayedPort);
    await recents.read();
    const first = recents.record(HAIKU);
    await firstWriteStarted.promise;
    const second = recents.record(SONNET);
    expect(recents.getSnapshot().keys).toEqual([SONNET_KEY, HAIKU_KEY]);
    firstWriteRelease.resolve("revision-2" as Revision);
    await Promise.all([first, second]);
    expect(port.savedKeys).toEqual([SONNET_KEY, HAIKU_KEY]);
    expect(port.writes).toEqual([[HAIKU_KEY], [SONNET_KEY, HAIKU_KEY]]);
    recents.dispose();
  });

  test("keeps a failed pick and its own error through later dialogs until the next successful pick", async () => {
    const port = memoryPort();
    let fail = true;
    const failingPort: RecentModelsPort = {
      read: port.read,
      write: async (keys, revision) => {
        if (fail) {
          throw new AppFailure({
            code: "internal",
            message: "Disk full while saving recent models.",
            retryable: true,
          });
        }
        return port.write(keys, revision);
      },
    };
    const original = new RecentModels(failingPort);
    await original.read();
    await original.record(HAIKU);
    const reopened = new RecentModels(failingPort);
    await reopened.read();
    expect(reopened.getSnapshot()).toEqual({
      keys: [HAIKU_KEY],
      error: "Disk full while saving recent models.",
    });
    fail = false;
    const nextSave = reopened.record(SONNET);
    expect(reopened.getSnapshot().error).toBeNull();
    await nextSave;
    expect(reopened.getSnapshot()).toEqual({ keys: [SONNET_KEY, HAIKU_KEY], error: null });
    original.dispose();
    reopened.dispose();
  });
});
