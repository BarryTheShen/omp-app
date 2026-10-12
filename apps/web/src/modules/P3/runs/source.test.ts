import { EntryId as EntryIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { captureP3EditSource, isImageContent, storedEntryId } from "./source";
import { pngImage, sourceThread, storeWithUserMessage, userEntry } from "./test-support";

describe("captureP3EditSource", () => {
  test("captures a stored user message's exact text and its images", () => {
    const store = storeWithUserMessage([
      { type: "text", text: "Explain " },
      { type: "text", text: "this" },
      { type: "image", data: pngImage.data, mimeType: pngImage.mimeType },
    ]);

    const source = captureP3EditSource(store, userEntry);

    expect(source?.editSource).toEqual({
      threadId: sourceThread,
      entryId: userEntry,
      parentId: null,
      originalText: "Explain this",
      originalImages: [pngImage],
      sourceHeadId: null,
    });
    expect(source?.composerSource).toEqual({
      text: "Explain this",
      images: [pngImage],
      attachmentRefs: [],
      sourceMessageId: String(userEntry),
    });
  });

  test("captures a message stored as plain text, with no images", () => {
    const source = captureP3EditSource(storeWithUserMessage("Explain"), userEntry);

    expect(source?.editSource.originalText).toBe("Explain");
    expect(source?.editSource.originalImages).toEqual([]);
  });

  test("returns null for an entry this chat does not hold", () => {
    const store = storeWithUserMessage("Explain");

    expect(captureP3EditSource(store, EntryIdSchema.parse("missing-entry"))).toBeNull();
  });
});

describe("storedEntryId", () => {
  test("finds a stored row's entry by the row's message key, not by the key itself", () => {
    const store = storeWithUserMessage("Explain");
    const [key] = store.getSnapshot().messageOrder;
    expect(key).toBeDefined();
    expect(key).not.toBe(userEntry);
    expect(storedEntryId(store, String(key))).toBe(userEntry);
  });

  test("gives no entry id to a row omp has not saved", () => {
    const store = new OmpRuntimeStore({ threadId: sourceThread });
    store.ingest(
      {
        kind: "omp",
        event: {
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "Explain" }], timestamp: 1 },
        },
      },
      1,
    );
    const [key] = store.getSnapshot().messageOrder;
    expect(key).toBeDefined();
    expect(storedEntryId(store, String(key))).toBeNull();
  });

  test("an entry id is not a row key, so it finds no row", () => {
    expect(storedEntryId(storeWithUserMessage("Explain"), userEntry)).toBeNull();
  });

  test("finds a streamed row's entry by the streamed copy's key once history returns the entry", () => {
    const store = new OmpRuntimeStore({ threadId: sourceThread });
    const streamed = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Explain" }],
      timestamp: 1,
    };
    store.ingest({ kind: "omp", event: { type: "message_end", message: streamed } }, 1);
    const [streamedKey] = store.getSnapshot().messageOrder;
    expect(streamedKey).toBeDefined();
    store.pairEndedMessages([
      {
        type: "message",
        id: userEntry,
        parentId: null,
        timestamp: new Date(1).toISOString(),
        message: streamed,
      },
    ]);
    expect(storedEntryId(store, String(streamedKey))).toBe(userEntry);
  });
});

describe("isImageContent", () => {
  test("accepts only an image that carries its type, bytes and mime type", () => {
    expect(isImageContent(pngImage)).toBe(true);
    expect(isImageContent({ type: "image", data: "aW1h" })).toBe(false);
    expect(isImageContent({ type: "text", text: "Explain" })).toBe(false);
    expect(isImageContent(null)).toBe(false);
  });
});
