import {
  AppFailure,
  type AttachmentBlobStore as AttachmentBlobStorePort,
  type AttachmentRef,
  MAX_ATTACHMENT_BYTES,
  type PortClient,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createAttachmentBlobStore } from "./blob-store";

type Client = PortClient<typeof AttachmentBlobStorePort>;

function ref(): AttachmentRef {
  return {
    id: "a".repeat(64),
    name: "note.txt",
    mediaType: "text/plain",
    sizeBytes: 5,
    uri: `attachment://${"a".repeat(64)}`,
  };
}

describe("createAttachmentBlobStore", () => {
  test("encodes put bytes and decodes get content through the typed port", async () => {
    let uploaded = "";
    const client = {
      put: async (args: { bytes: string }) => {
        uploaded = args.bytes;
        return { ref: ref() };
      },
      get: async () => ({ ref: ref(), bytes: uploaded }),
      delete: async () => ({ deleted: true as const }),
      list: async () => ({ refs: [ref()] }),
    } as unknown as Client;
    const store = createAttachmentBlobStore(client);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const stored = await store.put({ id: "pending-1", file });
    expect(uploaded).toBe("aGVsbG8=");
    expect(stored.ref).toEqual(ref());
    expect(stored.content).toEqual([
      { type: "file", data: "data:text/plain;base64,aGVsbG8=", mimeType: "text/plain" },
    ]);
    expect(await store.get(ref())).toEqual(stored);
  });

  test("preserves AppFailures and maps unknown client failures", async () => {
    const typed = new AppFailure({ code: "permission", message: "blocked", retryable: false });
    const client = {
      put: async () => {
        throw typed;
      },
      get: async () => {
        throw new Error("disconnect");
      },
      delete: async () => ({ deleted: true as const }),
      list: async () => ({ refs: [] }),
    } as unknown as Client;
    const store = createAttachmentBlobStore(client);
    await expect(
      store.put({ id: "id", file: new File(["x"], "x.txt", { type: "text/plain" }) }),
    ).rejects.toBe(typed);
    await expect(store.get(ref())).rejects.toMatchObject({
      appError: { code: "unavailable", retryable: true },
    });
  });

  test("rejects oversized files before calling the port", async () => {
    let calls = 0;
    const client = {
      put: async () => {
        calls += 1;
        return { ref: ref() };
      },
      get: async () => ({ ref: ref(), bytes: "" }),
      delete: async () => ({ deleted: true as const }),
      list: async () => ({ refs: [] }),
    } as unknown as Client;
    const store = createAttachmentBlobStore(client);
    await expect(
      store.put({
        id: "large",
        file: new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large.bin", {
          type: "text/plain",
        }),
      }),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "large.bin was not attached. Files over 700 KB can't be attached.",
      },
    });
    expect(calls).toBe(0);
  });
});
