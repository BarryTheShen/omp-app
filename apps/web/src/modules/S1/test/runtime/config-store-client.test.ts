import type { AppClient } from "@omp-app/client";
import {
  type ConfigListArgs,
  ConfigListResult,
  ConfigStore,
  FolderPath,
  Revision,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { NOTIFICATIONS_SETTINGS_SECTION } from "../../interaction";
import { createConfigStoreClient } from "../../runtime";
import { type ConfigStoreClient, readSection } from "../../settings-kit";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const result = ConfigListResult.parse({ entries: [], revision: Revision.parse("revision-1") });
const globalArgs: ConfigListArgs = { folder: null };
const projectArgs: ConfigListArgs = { folder: FolderPath.parse("/workspace/project") };

type ListCall = {
  readonly args: ConfigListArgs;
  readonly options: Parameters<ConfigStoreClient["list"]>[1];
  readonly deferred: Deferred<ConfigListResult>;
};

function clientWithPendingLists() {
  const calls: ListCall[] = [];
  const port = {
    read: vi.fn(),
    list(args: ConfigListArgs, options: Parameters<ConfigStoreClient["list"]>[1]) {
      const request = deferred<ConfigListResult>();
      calls.push({ args, options, deferred: request });
      return request.promise;
    },
    write: vi.fn(async () => undefined),
  };
  const client = {
    port(requested: unknown) {
      if (requested !== ConfigStore) throw new Error("unexpected port");
      return port;
    },
  } as unknown as AppClient;
  return { calls, client };
}

describe("the ConfigStore client coalesces pending list calls", () => {
  test("shares identical in-flight calls across client wrappers and removes the entry when settled", async () => {
    const { calls, client } = clientWithPendingLists();
    const firstClient = createConfigStoreClient(client);
    const secondClient = createConfigStoreClient(client);

    const first = firstClient.list(globalArgs);
    const joined = secondClient.list({ folder: null });

    expect(calls).toHaveLength(1);
    calls[0]?.deferred.resolve(result);
    await expect(first).resolves.toBe(result);
    await expect(joined).resolves.toBe(result);

    const afterSettle = firstClient.list(globalArgs);
    expect(calls).toHaveLength(2);
    calls[1]?.deferred.resolve(result);
    await expect(afterSettle).resolves.toBe(result);
  });

  test("starts a fresh identical call after another task even while the first is pending", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);

    const first = config.list(globalArgs);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const nextTask = config.list({ folder: null });

    expect(calls).toHaveLength(2);
    calls[0]?.deferred.resolve(result);
    calls[1]?.deferred.resolve(result);
    await Promise.all([first, nextTask]);
  });

  test("a list that never settles does not hold a later call", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);

    const never = config.list(globalArgs);
    expect(never).toBeInstanceOf(Promise);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const retry = config.list({ folder: null });

    expect(calls).toHaveLength(2);
    calls[1]?.deferred.resolve(result);
    await expect(retry).resolves.toBe(result);
  });

  test("three section reads in one tick share one config list", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);

    const reads = [
      readSection(config, NOTIFICATIONS_SETTINGS_SECTION, null),
      readSection(config, NOTIFICATIONS_SETTINGS_SECTION, null),
      readSection(config, NOTIFICATIONS_SETTINGS_SECTION, null),
    ];

    expect(calls).toHaveLength(1);
    calls[0]?.deferred.resolve(result);
    await Promise.all(reads);
  });

  test("does not join different list arguments", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);

    const global = config.list(globalArgs);
    const project = config.list(projectArgs);

    expect(calls).toHaveLength(2);
    calls[0]?.deferred.resolve(result);
    calls[1]?.deferred.resolve(result);
    await Promise.all([global, project]);
  });

  test("a rejected list request is removed so the next caller retries", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);
    const failure = new Error("list failed");

    const first = config.list(globalArgs);
    calls[0]?.deferred.reject(failure);
    await expect(first).rejects.toBe(failure);

    const retry = config.list(globalArgs);
    expect(calls).toHaveLength(2);
    calls[1]?.deferred.resolve(result);
    await expect(retry).resolves.toBe(result);
  });

  test("a write invalidates pending list entries without cancelling callers already waiting", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);

    const beforeWrite = config.list(globalArgs);
    await config.write({
      key: "settings.key",
      layer: "global",
      value: { secret: false, value: "value" },
      folder: null,
      expectedRevision: null,
    });
    const afterWrite = config.list(globalArgs);

    expect(calls).toHaveLength(2);
    calls[0]?.deferred.resolve(result);
    calls[1]?.deferred.resolve(result);
    await Promise.all([beforeWrite, afterWrite]);
  });

  test("calls with an AbortSignal bypass coalescing and pass the signal through", async () => {
    const { calls, client } = clientWithPendingLists();
    const config = createConfigStoreClient(client);
    const signal = new AbortController().signal;

    const first = config.list(globalArgs, { signal });
    const second = config.list(globalArgs, { signal });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options?.signal)).toEqual([signal, signal]);
    calls[0]?.deferred.resolve(result);
    calls[1]?.deferred.resolve(result);
    await Promise.all([first, second]);
  });
});
