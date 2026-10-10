import type { AppClient } from "@omp-app/client";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createShareSettingsReader } from "./settings";

const FOLDER = FolderPath.parse("/work/chat-folder");
const UNREADABLE = "The share settings could not be read, so nothing was shared.";
const VALUES: Record<string, unknown> = {
  "share.serverUrl": "https://my.omp.sh/s",
  "share.store": "blob",
  "share.redactSecrets": true,
};

interface Read {
  readonly key: string;
  readonly folder: FolderPath | null;
}

/**
 * A fake of the one config port the reader uses. The client's generic port signature is not needed here, so the
 * fake is cast at the client boundary only.
 */
function fakeClient(
  values: Record<string, unknown>,
  reads: Read[],
  options: { readonly failWith?: unknown; readonly secretKeys?: readonly string[] } = {},
): Pick<AppClient, "port"> {
  const config = {
    read: async ({ key, folder }: Read) => {
      reads.push({ key, folder });
      if (options.failWith !== undefined) throw options.failWith;
      const secret = options.secretKeys?.includes(key) === true;
      return { key, secret, value: values[key], source: "global", overrides: [] };
    },
  };
  return { port: () => config } as unknown as Pick<AppClient, "port">;
}

describe("the share settings reader", () => {
  test("reads the three share keys for the folder the chat is in at the moment of the read", async () => {
    const reads: Read[] = [];
    let folder: FolderPath | null = FOLDER;
    const read = createShareSettingsReader({
      client: fakeClient(VALUES, reads),
      folder: () => folder,
    });
    await expect(read()).resolves.toEqual({
      serverUrl: "https://my.omp.sh/s",
      store: "blob",
      redactSecrets: true,
    });
    expect(reads).toEqual(
      expect.arrayContaining([
        { key: "share.serverUrl", folder: FOLDER },
        { key: "share.store", folder: FOLDER },
        { key: "share.redactSecrets", folder: FOLDER },
      ]),
    );

    folder = null;
    await read();
    expect(reads.slice(-3)).toEqual([
      { key: "share.serverUrl", folder: null },
      { key: "share.store", folder: null },
      { key: "share.redactSecrets", folder: null },
    ]);
  });

  test("a value of the wrong kind is unreadable, so no question can name a destination", async () => {
    const read = createShareSettingsReader({
      client: fakeClient({ ...VALUES, "share.store": "auto" }, []),
      folder: () => FOLDER,
    });
    await expect(read()).rejects.toMatchObject({
      appError: { code: "unavailable", message: UNREADABLE, retryable: true },
    });
  });

  test("a secret entry is not a share setting, so it is unreadable", async () => {
    const read = createShareSettingsReader({
      client: fakeClient(VALUES, [], { secretKeys: ["share.serverUrl"] }),
      folder: () => FOLDER,
    });
    await expect(read()).rejects.toMatchObject({ appError: { message: UNREADABLE } });
  });

  test("omp's own failure from the config store passes through unchanged", async () => {
    const original = new AppFailure({
      code: "unavailable",
      message: "The config store is not available.",
      retryable: true,
    });
    const read = createShareSettingsReader({
      client: fakeClient(VALUES, [], { failWith: original }),
      folder: () => FOLDER,
    });
    await expect(read()).rejects.toBe(original);
  });

  test("any other read failure is reported as the settings being unreadable", async () => {
    const cause = new Error("socket closed");
    const read = createShareSettingsReader({
      client: fakeClient(VALUES, [], { failWith: cause }),
      folder: () => FOLDER,
    });
    const failure: unknown = await read().catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(AppFailure);
    expect(failure).toMatchObject({ appError: { message: UNREADABLE, retryable: true } });
    expect(failure instanceof AppFailure ? failure.cause : undefined).toBe(cause);
  });
});
