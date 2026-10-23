import { type AttachmentRef, type DraftScope, FolderPath, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { type BufferedDraft, createDraftBuffer, type DraftBufferStorage } from "./draft-buffer";

/** The part of sessionStorage the draft buffer uses, kept in memory. */
class MemoryDraftStorage implements DraftBufferStorage {
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

const folderScope: DraftScope = { kind: "folder", folder: FolderPath.parse("/workspace/app") };
const threadScope: DraftScope = { kind: "thread", threadId: ThreadId.parse("chat-buffer") };
const attachment: AttachmentRef = {
  id: "att-buffer-1",
  name: "notes.txt",
  mediaType: "text/plain",
  sizeBytes: 12,
};

describe("createDraftBuffer", () => {
  test("keeps a scope's unsaved text, its attachments, the revision it was typed on and the save in flight, until it is cleared", () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    const held: BufferedDraft = {
      input: { text: "typed here", attachments: [attachment], failedSends: [] },
      baseRevision: "revision-3",
      saving: { text: "typed", attachments: [], failedSends: [] },
    };

    buffer.write(folderScope, held);

    // A new buffer over the same storage reads what the old one wrote: the text outlives its controller.
    expect(createDraftBuffer(storage, () => undefined).read(folderScope)).toEqual(held);
    buffer.clear(folderScope);
    expect(buffer.read(folderScope)).toBeNull();
  });

  test("keeps each scope apart: a thread and a folder never read each other's text", () => {
    const buffer = createDraftBuffer(new MemoryDraftStorage(), () => undefined);

    buffer.write(folderScope, {
      input: { text: "folder text", attachments: [], failedSends: [] },
      baseRevision: null,
      saving: null,
    });

    expect(buffer.read(threadScope)).toBeNull();
    expect(buffer.read(folderScope)?.input.text).toBe("folder text");
  });

  test("drops and reports a stored value that is not a draft, instead of restoring part of it", () => {
    const storage = new MemoryDraftStorage();
    const reports: unknown[] = [];
    const buffer = createDraftBuffer(storage, (error) => reports.push(error));
    buffer.write(folderScope, {
      input: { text: "soon corrupt", attachments: [], failedSends: [] },
      baseRevision: null,
      saving: null,
    });
    for (const key of storage.keys()) {
      storage.setItem(key, JSON.stringify({ text: "not the stored shape" }));
    }

    expect(buffer.read(folderScope)).toBeNull();
    expect(storage.keys()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  test("a pending send is kept per scope until it is cleared, and a damaged record is dropped and reported", () => {
    const storage = new MemoryDraftStorage();
    const reports: unknown[] = [];
    const buffer = createDraftBuffer(storage, (error) => reports.push(error));
    buffer.writeSent(folderScope, "sent text");
    expect(buffer.readSent(folderScope)).toBe("sent text");
    buffer.clearSent(folderScope);
    expect(buffer.readSent(folderScope)).toBeNull();

    buffer.writeSent(folderScope, "soon damaged");
    for (const key of storage.keys()) {
      storage.setItem(key, JSON.stringify({ text: 3 }));
    }

    expect(buffer.readSent(folderScope)).toBeNull();
    expect(storage.keys()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  test("reports a write the storage refuses, and does not throw into the controller", () => {
    class FullStorage extends MemoryDraftStorage {
      override setItem(): void {
        throw new Error("QuotaExceededError");
      }
    }
    const reports: unknown[] = [];
    const buffer = createDraftBuffer(new FullStorage(), (error) => reports.push(error));

    expect(() =>
      buffer.write(folderScope, {
        input: { text: "does not fit", attachments: [], failedSends: [] },
        baseRevision: null,
        saving: null,
      }),
    ).not.toThrow();
    expect(reports).toHaveLength(1);
  });

  test("keeps a scope's earlier draft until it is cleared, without touching its unsaved text", () => {
    const storage = new MemoryDraftStorage();
    const buffer = createDraftBuffer(storage, () => undefined);
    const earlier = { text: "earlier", attachments: [attachment], failedSends: [] };

    buffer.writeReplaced(folderScope, earlier);

    expect(createDraftBuffer(storage, () => undefined).readReplaced(folderScope)).toEqual(earlier);
    expect(buffer.read(folderScope)).toBeNull();
    buffer.clearReplaced(folderScope);
    expect(buffer.readReplaced(folderScope)).toBeNull();
  });

  test("drops and reports a stored earlier draft that is not a draft", () => {
    const storage = new MemoryDraftStorage();
    const reports: unknown[] = [];
    const buffer = createDraftBuffer(storage, (error) => reports.push(error));
    buffer.writeReplaced(folderScope, { text: "earlier", attachments: [], failedSends: [] });
    for (const key of storage.keys()) {
      storage.setItem(key, JSON.stringify({ text: "not the stored shape" }));
    }

    expect(buffer.readReplaced(folderScope)).toBeNull();
    expect(storage.keys()).toEqual([]);
    expect(reports).toHaveLength(1);
  });
});
