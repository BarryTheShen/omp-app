import type { CompleteAttachment } from "@assistant-ui/react";
import { type AttachmentRef, MAX_ATTACHMENT_BYTES } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  type AttachmentBlobStore,
  AttachmentManager,
  acceptedKindsText,
  applyLargePaste,
  classifyLargePaste,
  type StoredAttachment,
  withPastedText,
} from "./attachments";

class MemoryBlobStore implements AttachmentBlobStore {
  readonly values = new Map<string, StoredAttachment>();
  readonly deleted: string[] = [];
  readonly putIds: string[] = [];

  async put(input: { readonly id: string; readonly file: File }): Promise<StoredAttachment> {
    this.putIds.push(input.id);
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

/** Uploads that wait while `held`: a picture that is still being attached when the test acts. */
class HeldUploadStore extends MemoryBlobStore {
  held = false;
  private readonly waiting: Array<() => void> = [];

  override async put(input: {
    readonly id: string;
    readonly file: File;
  }): Promise<StoredAttachment> {
    if (this.held) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    return super.put(input);
  }

  release(): void {
    this.held = false;
    for (const resume of this.waiting.splice(0)) resume();
  }
}

/** Reads that wait until `release()`: a picture that is still loading from its blob when the test acts. */
class HeldReadStore extends MemoryBlobStore {
  private resume: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.resume = resolve;
  });

  override async get(ref: AttachmentRef): Promise<StoredAttachment> {
    await this.gate;
    return super.get(ref);
  }

  release(): void {
    this.resume?.();
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
  test("clears sent attachments from the next draft without deleting their stored blobs", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const pending = await manager.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });
    await manager.send(pending);

    manager.clearAfterSend();

    expect(manager.getState()).toMatchObject({ pending: [], complete: [], error: null });
    expect(manager.toDraftRefs()).toEqual([]);
    expect(blobs.deleted).toEqual([]);
  });
  test("does not upload an attachment twice when submission asks to send it again", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const pending = await manager.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });

    const first = await manager.send(pending);
    const second = await manager.send(pending);

    expect(second).toBe(first);
    expect(blobs.putIds).toEqual([pending.id]);
  });

  test("refuses a file the composer will not take, naming the file and the reason", async () => {
    const manager = new AttachmentManager({ blobStore: new MemoryBlobStore(), maxBytes: 3 });
    await expect(
      manager.add({ file: new File(["%PDF"], "report.pdf", { type: "application/pdf" }) }),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message:
          "report.pdf was not attached. Only images, plain text and Markdown files can be attached.",
      },
    });
    await expect(
      manager.add({ file: new File(["1234"], "photo.png", { type: "image/png" }) }),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "photo.png was not attached. Files over 3 bytes can't be attached.",
      },
    });
    expect(manager.getState().pending).toHaveLength(0);
  });

  test("a restore that has been replaced adds nothing when its picture arrives later", async () => {
    const blobs = new HeldReadStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const pending = await manager.add({
      file: new File(["png"], "photo.png", { type: "image/png" }),
    });
    await manager.send(pending);
    const refs = manager.toDraftRefs();
    expect(refs).toHaveLength(1);

    const replaced = new AbortController();
    const restoring = manager.restore(refs, { signal: replaced.signal });
    // The chat moves on: the newer restore replaces this one before its picture has loaded.
    replaced.abort();
    blobs.release();
    await restoring;

    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
    expect(manager.toDraftRefs()).toEqual([]);
  });

  test("a picture the upload would refuse is refused when it is added, by default", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    await expect(
      manager.add({
        file: new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "photo.png", {
          type: "image/png",
        }),
      }),
    ).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "photo.png was not attached. Files over 700 KB can't be attached.",
      },
    });
    expect(blobs.putIds).toEqual([]);
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
  });

  test("says in plain words which kinds of file the composer takes", () => {
    expect(acceptedKindsText("image/*,text/plain,text/markdown")).toBe(
      "Only images, plain text and Markdown files can be attached.",
    );
  });

  test("follows the Large Paste Menu threshold: 0 turns the choice off, and a changed value moves it", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(classifyLargePaste(hundred, 0)).toMatchObject({ kind: "inline", threshold: 0 });
    expect(classifyLargePaste(hundred, 250)).toMatchObject({ kind: "inline", threshold: 250 });
    expect(classifyLargePaste(hundred, 50)).toMatchObject({ kind: "choose", threshold: 50 });
  });

  test("offers the choice only to a paste omp collapses: more than 10 lines or more than 1000 characters", () => {
    const tenLines = Array.from({ length: 10 }, (_, index) => `${index}`).join("\n");
    expect(classifyLargePaste(tenLines, 10)).toMatchObject({ kind: "inline", lineCount: 10 });
    const wideLines = Array.from({ length: 5 }, () => "x".repeat(300)).join("\n");
    expect(classifyLargePaste(wideLines, 5)).toMatchObject({ kind: "choose", lineCount: 5 });
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

  test("restore keeps a picture that is still being attached in the list", async () => {
    const blobs = new MemoryBlobStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const saved = await manager.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });
    await manager.send(saved);
    const refs = manager.toDraftRefs();
    // A picture dropped while the draft loads: its upload has not answered yet.
    const loading = await manager.add({
      file: new File(["png"], "photo.png", { type: "image/png" }),
    });
    await manager.restore(refs);
    expect(manager.getState().pending.map((attachment) => attachment.id)).toEqual([loading.id]);
    expect(manager.toDraftRefs()).toEqual(refs);
  });

  test("dropPending drops a picture still uploading: its late answer adds nothing, attached pictures stay", async () => {
    const blobs = new HeldUploadStore();
    const manager = new AttachmentManager({ blobStore: blobs });
    const attached = await manager.add({
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
    });
    await manager.send(attached);
    blobs.held = true;
    const loading = await manager.add({
      file: new File(["png"], "photo.png", { type: "image/png" }),
    });
    const answer = manager.send(loading).catch((error: unknown) => error);
    manager.dropPending();
    expect(manager.getState().pending).toEqual([]);
    expect(manager.getState().complete.map((item) => item.name)).toEqual(["notes.txt"]);
    blobs.release();
    expect(await answer).toMatchObject({ appError: { code: "cancelled" } });
    expect(manager.getState().pending).toEqual([]);
    expect(manager.toDraftRefs().map((ref) => ref.name)).toEqual(["notes.txt"]);
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

/** A completed chip as the manager holds it: its file's bytes stored as a data URL, the way the app's blob store does. */
function completeChip(name: string, text: string | undefined): CompleteAttachment {
  const data = `data:text/plain;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(text ?? "")))}`;
  return {
    id: `id-${name}`,
    type: "file",
    name,
    contentType: "text/plain",
    status: { type: "complete" },
    content: text === undefined ? [] : [{ type: "file", data, mimeType: "text/plain" }],
  };
}

describe("U2.3 withPastedText", () => {
  test("sends the typed text, then each pasted chip's text as omp's wrapped block, in chip order", () => {
    const chips = [
      completeChip("Pasted text 1 (2 lines).txt", "a\nb"),
      completeChip("Pasted text 2 (1 lines).txt", "c"),
    ];
    expect(withPastedText("Summarize", chips)).toBe(
      "Summarize\n\n<attachment>\na\nb\n</attachment>\n\n<attachment>\nc\n</attachment>",
    );
  });

  test("with no typed text, sends only the blocks", () => {
    expect(withPastedText("", [completeChip("Pasted text 1 (1 lines).txt", "a")])).toBe(
      "<attachment>\na\n</attachment>",
    );
  });

  test("a file the person chose is not wrapped, and the text is left as typed", () => {
    expect(withPastedText("see attached", [completeChip("notes.txt", "x")])).toBe("see attached");
  });

  test("the text comes back as UTF-8, with accents and emoji intact", () => {
    const text = "café 🙂";
    expect(withPastedText("", [completeChip("Pasted text 1 (1 lines).txt", text)])).toBe(
      `<attachment>\n${text}\n</attachment>`,
    );
  });

  test("a pasted-text chip whose file cannot be read is an error, never a message without its text", () => {
    expect(() =>
      withPastedText("hi", [completeChip("Pasted text 1 (1 lines).txt", undefined)]),
    ).toThrow("The pasted text could not be read");
  });
});
