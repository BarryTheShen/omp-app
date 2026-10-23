import { FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createDraftBuffer,
  deletedChatIds,
  type KeyedDraftStorage,
  recordDeletedChat,
  removeDeletedChatCopies,
} from "./draft-buffer";

/** The part of Web Storage the buffer uses, kept in memory, with its key list for the cleanup. */
class MemoryDraftStorage implements KeyedDraftStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  keys(): string[] {
    return [...this.values.keys()];
  }
}

const folderScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") } as const;
const liveScope = { kind: "thread", threadId: ThreadId.parse("chat-live") } as const;
const deletedScope = { kind: "thread", threadId: ThreadId.parse("chat-deleted") } as const;
const held = {
  input: { text: "unsent text", attachments: [], failedSends: [] },
  baseRevision: null,
  saving: null,
};

describe("removeDeletedChatCopies", () => {
  test("removes a deleted chat's local copies, and keeps a live chat's copy and the New-chat copy", async () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    buffer.write(liveScope, held);
    buffer.write(deletedScope, held);
    buffer.writeReplaced(deletedScope, held.input);
    buffer.write(folderScope, held);

    await removeDeletedChatCopies(
      storage,
      async (threadId) => threadId === "chat-live",
      () => undefined,
    );

    expect(buffer.read(deletedScope)).toBeNull();
    expect(buffer.readReplaced(deletedScope)).toBeNull();
    expect(buffer.read(liveScope)).toEqual(held);
    expect(buffer.read(folderScope)).toEqual(held);
  });

  test("removes a deleted chat's send record too, and keeps a live chat's", async () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    buffer.writeSent(deletedScope, "sent then reloaded");
    buffer.writeSent(liveScope, "sent in a live chat");

    await removeDeletedChatCopies(
      storage,
      async (threadId) => threadId === "chat-live",
      () => undefined,
    );

    expect(buffer.readSent(deletedScope)).toBeNull();
    expect(storage.keys().filter((key) => key.includes("chat-deleted"))).toEqual([]);
    expect(buffer.readSent(liveScope)).toBe("sent in a live chat");
  });

  test("keeps a copy whose chat cannot be checked, and reports the failed check", async () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    buffer.write(deletedScope, held);
    const reports: unknown[] = [];

    await removeDeletedChatCopies(
      storage,
      async () => {
        throw new Error("the server is unreachable");
      },
      (error) => reports.push(error),
    );

    expect(buffer.read(deletedScope)).toEqual(held);
    expect(reports).toHaveLength(1);
  });
});

describe("the chats this browser deleted", () => {
  test("a deleted chat is recorded and its copies go at once; the list survives a reload", () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    buffer.write(deletedScope, held);
    buffer.write(liveScope, held);

    recordDeletedChat(storage, "chat-deleted", () => undefined);

    expect(storage.keys().filter((key) => key.includes("chat-deleted"))).toEqual([]);
    expect(buffer.read(deletedScope)).toBeNull();
    expect(buffer.read(liveScope)).toEqual(held);
    expect([...deletedChatIds(storage, () => undefined)]).toEqual(["chat-deleted"]);
  });

  test("a deleted chat's send record goes at once, and a later send is not recorded for it", () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    buffer.writeSent(deletedScope, "sent before the delete");
    buffer.writeSent(liveScope, "sent in a live chat");

    recordDeletedChat(storage, "chat-deleted", () => undefined);
    expect(buffer.readSent(deletedScope)).toBeNull();
    expect(storage.keys().filter((key) => key.includes("chat-deleted"))).toEqual([]);

    buffer.writeSent(deletedScope, "sent after the delete");
    expect(buffer.readSent(deletedScope)).toBeNull();
    expect(storage.keys().filter((key) => key.includes("chat-deleted"))).toEqual([]);
    expect(buffer.readSent(liveScope)).toBe("sent in a live chat");
  });

  test("a chat deleted in this browser keeps no copy: a later write is not kept, and nothing is read for it", () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    recordDeletedChat(storage, "chat-deleted", () => undefined);

    expect(buffer.write(deletedScope, held)).toBe(true);
    expect(buffer.read(deletedScope)).toBeNull();
    expect(storage.keys().filter((key) => key.includes("chat-deleted"))).toEqual([]);
  });
});
