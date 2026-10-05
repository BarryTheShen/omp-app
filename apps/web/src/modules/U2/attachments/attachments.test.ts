import type { AttachmentRef } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  type AttachmentBlobStore,
  AttachmentManager,
  applyLargePaste,
  classifyLargePaste,
  type StoredAttachment,
} from "./attachments";

class MemoryBlobStore implements AttachmentBlobStore {
  readonly values = new Map<string, StoredAttachment>();
  readonly deleted: string[] = [];

  async put(input: { readonly id: string; readonly file: File }): Promise<StoredAttachment> {
    const uri = `attachment://${input.id}`;
    const ref: AttachmentRef = {
      id: input.id,
      name: input.file.name,
      mediaType: input.file.type,
      sizeBytes: input.file.size,
      uri,
    };
    const content = input.file.type.startsWith("image/")
      ? [{ type: "image" as const, image: uri }]
      : [{ type: "file" as const, data: uri, mimeType: input.file.type }];
    const stored = { ref, content } satisfies StoredAttachment;
    this.values.set(ref.id, stored);
    return stored;
  }

  async get(ref: AttachmentRef): Promise<StoredAttachment> {
    const stored = this.values.get(ref.id);
    if (!stored) throw new Error("missing blob");
    return stored;
  }

  async delete(ref: AttachmentRef): Promise<void> {
    this.deleted.push(ref.id);
    this.values.delete(ref.id);
  }
}

describe("U2.3 AttachmentManager", () => {
  test("adds, sends, projects refs, and removes an image attachment", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const pending = await manager.add({
      file: new File(["png"], "photo.png", { type: "image/png" }),
    });
    expect(manager.getState().pending).toHaveLength(1);
    const complete = await manager.send(pending);
    expect(complete.content).toEqual([{ type: "image", image: "attachment://attachment-1" }]);
    expect(manager.toDraftRefs()).toEqual([
      {
        id: "attachment-1",
        name: "photo.png",
        mediaType: "image/png",
        sizeBytes: 3,
        uri: "attachment://attachment-1",
      },
    ]);
    await manager.remove(complete);
    expect(manager.getState().complete).toHaveLength(0);
    expect(blobs.deleted).toEqual(["attachment-1"]);
  });

  test("rejects disallowed MIME types and oversized files with clear typed errors", async () => {
    const manager = new AttachmentManager({
      blobStore: new MemoryBlobStore(),
      allowedMimeTypes: ["image/png"],
      maxBytes: 3,
    });
    await expect(
      manager.add({ file: new File(["text"], "notes.txt", { type: "text/plain" }) }),
    ).rejects.toMatchObject({
      appError: { code: "invalid_args", message: expect.stringContaining("type") },
    });
    await expect(
      manager.add({ file: new File(["1234"], "photo.png", { type: "image/png" }) }),
    ).rejects.toMatchObject({
      appError: { code: "invalid_args", message: expect.stringContaining("limit") },
    });
    expect(manager.getState().pending).toHaveLength(0);
  });

  test("uses omp's 100-line large-paste threshold and supports inline or attachment choices", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    expect(classifyLargePaste("one\ntwo")).toMatchObject({
      kind: "inline",
      lineCount: 2,
      threshold: 100,
    });
    const large = `${"line\n".repeat(99)}last`;
    expect(classifyLargePaste(large)).toMatchObject({
      kind: "choose",
      lineCount: 100,
      threshold: 100,
    });
    await expect(applyLargePaste(manager, large, "inline")).resolves.toEqual({
      kind: "inline",
      text: large,
    });
    const attached = await applyLargePaste(manager, large, "attachment");
    expect(attached.kind).toBe("attachment");
    if (attached.kind === "attachment") expect(attached.ref.name).toBe("pasted-text.txt");
  });

  test("restores complete attachments from durable refs after a new manager is created", async () => {
    const blobs = new MemoryBlobStore();
    const first = new AttachmentManager({ blobStore: blobs });
    const pending = await first.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });
    await first.send(pending);
    const refs = first.toDraftRefs();
    const reloaded = new AttachmentManager({ blobStore: blobs });
    await reloaded.restore(refs);
    expect(reloaded.toDraftRefs()).toEqual(refs);
    expect(reloaded.getState().complete[0]?.name).toBe("notes.txt");
  });

  test("keeps removal out of the next draft projection", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const pending = await manager.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });
    const complete = await manager.send(pending);
    await manager.remove(complete);
    expect(manager.toDraftRefs()).toEqual([]);
  });
});
