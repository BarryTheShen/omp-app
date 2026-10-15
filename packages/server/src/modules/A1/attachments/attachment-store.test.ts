import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppFailure, type AttachmentRef } from "@omp-app/contracts";
import { DraftStoreService } from "../drafts/store";
import { AttachmentStoreService } from "./attachment-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = join(import.meta.dir, "../../../../../../.data");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "attachments-"));
  temporaryDirectories.push(directory);
  return directory;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * Blobs are stamped in whole milliseconds, and eviction takes the oldest first. Two uploads in one millisecond tie, and the
 * tie goes to directory order, which can evict the new blob itself. This waits until the clock has moved on.
 */
async function waitForNewMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) await Bun.sleep(1);
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AttachmentStoreService", () => {
  test("round-trips content-addressed bytes and lists/deletes refs", async () => {
    const appDataDir = await temporaryDirectory();
    const store = new AttachmentStoreService({
      appDataDir,
      referencedAttachments: async () => ({ refs: [], complete: true }),
    });
    const put = await store.put({
      id: "attachment-1",
      name: "note.txt",
      mediaType: "text/plain",
      bytes: base64("hello"),
    });
    const ref = { ...put.ref };
    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    expect(ref.name).toBe("note.txt");
    expect(ref.mediaType).toBe("text/plain");
    expect(ref.sizeBytes).toBe(5);
    expect(ref.uri).toBe(`attachment://${ref.id}`);
    expect(await store.get({ ref })).toEqual({ ref, bytes: base64("hello") });
    expect((await store.list()).refs).toEqual([ref]);
    expect(await store.delete({ ref })).toEqual({ deleted: true });
    expect((await store.list()).refs).toEqual([]);
  });

  test("enforces MIME, base64, size and traversal limits", async () => {
    const appDataDir = await temporaryDirectory();
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 100,
      referencedAttachments: async () => ({ refs: [], complete: true }),
    });
    await expectAppFailure(
      store.put({
        id: "id",
        name: "x.exe",
        mediaType: "application/octet-stream",
        bytes: base64("x"),
      }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
    await expectAppFailure(
      store.put({ id: "../outside", name: "x.txt", mediaType: "text/plain", bytes: base64("x") }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
    await expectAppFailure(
      store.put({ id: "id", name: "x.txt", mediaType: "text/plain", bytes: "not base64" }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
    const oversized = base64("x".repeat(700 * 1024 + 1));
    await expectAppFailure(
      store.put({ id: "id", name: "x.txt", mediaType: "text/plain", bytes: oversized }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
  });

  test("keeps referenced blobs and evicts oldest unreferenced blobs first", async () => {
    const appDataDir = await temporaryDirectory();
    let referenced: AttachmentRef[] = [];
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 8,
      referencedAttachments: async () => ({ refs: referenced, complete: true }),
    });
    const first = await store.put({
      id: "first",
      name: "a.txt",
      mediaType: "text/plain",
      bytes: base64("1234"),
    });
    const second = await store.put({
      id: "second",
      name: "b.txt",
      mediaType: "text/plain",
      bytes: base64("5678"),
    });
    referenced = [second.ref];
    await store.cleanup();
    await waitForNewMillisecond();
    const third = await store.put({
      id: "third",
      name: "c.txt",
      mediaType: "text/plain",
      bytes: base64("abcd"),
    });
    // list() returns refs in directory order, which differs from one filesystem to the next (the test machine's disk lists these two the
    // other way round); the contract has no order, so compare by id.
    const byId = (left: AttachmentRef, right: AttachmentRef) => left.id.localeCompare(right.id);
    expect([...(await store.list()).refs].sort(byId)).toEqual([second.ref, third.ref].sort(byId));
    await expectAppFailure(store.get({ ref: first.ref })).then((error) =>
      expect(error.appError.code).toBe("not_found"),
    );
    expect(third.ref.id).not.toBe(second.ref.id);
  });
  test("never evicts a draft-referenced blob and fails when referenced storage is full", async () => {
    const appDataDir = await temporaryDirectory();
    let referenced: AttachmentRef[] = [];
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 4,
      referencedAttachments: async () => ({ refs: referenced, complete: true }),
    });
    const first = await store.put({
      id: "first",
      name: "a.txt",
      mediaType: "text/plain",
      bytes: base64("1234"),
    });
    referenced = [first.ref];
    const failure = await expectAppFailure(
      store.put({ id: "second", name: "b.txt", mediaType: "text/plain", bytes: base64("5678") }),
    );
    expect(failure.appError).toMatchObject({ code: "unavailable", retryable: false });
    expect((await store.list()).refs).toEqual([first.ref]);
  });

  test("startup cleanup removes old orphans but keeps draft-referenced blobs", async () => {
    const appDataDir = await temporaryDirectory();
    let referenced: AttachmentRef[] = [];
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 100,
      referencedAttachments: async () => ({ refs: referenced, complete: true }),
    });
    const keep = await store.put({
      id: "keep",
      name: "keep.txt",
      mediaType: "text/plain",
      bytes: base64("keep"),
    });
    const orphan = await store.put({
      id: "orphan",
      name: "orphan.txt",
      mediaType: "text/plain",
      bytes: base64("orphan"),
    });
    referenced = [keep.ref];
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(join(appDataDir, "attachments", `${orphan.ref.id}.blob`), old, old);
    await utimes(join(appDataDir, "attachments", `${orphan.ref.id}.json`), old, old);
    await store.cleanup({ orphanAgeMs: 24 * 60 * 60 * 1000 });
    expect((await store.list()).refs).toEqual([keep.ref]);
    await expectAppFailure(store.get({ ref: orphan.ref })).then((error) =>
      expect(error.appError.code).toBe("not_found"),
    );
  });

  test("maps malformed refs and missing blobs to typed failures", async () => {
    const appDataDir = await temporaryDirectory();
    const store = new AttachmentStoreService({
      appDataDir,
      referencedAttachments: async () => ({ refs: [], complete: true }),
    });
    await expectAppFailure(
      store.get({ ref: { id: "../bad", name: "x.txt", mediaType: "text/plain" } }),
    ).then((error) => expect(error.appError.code).toBe("invalid_args"));
  });
  test("fails closed when draft reference scanning fails", async () => {
    const appDataDir = await temporaryDirectory();
    let scanFailed = false;
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 4,
      referencedAttachments: async () => {
        if (scanFailed)
          throw new AppFailure({ code: "internal", message: "scan failed", retryable: false });
        return { refs: [], complete: true };
      },
    });
    const first = await store.put({
      id: "first",
      name: "a.txt",
      mediaType: "text/plain",
      bytes: base64("1234"),
    });
    scanFailed = true;
    await expectAppFailure(
      store.put({ id: "second", name: "b.txt", mediaType: "text/plain", bytes: base64("5678") }),
    ).then((error) => expect(error.appError.code).toBe("internal"));
    expect((await store.list()).refs).toHaveLength(2);
    expect(await store.get({ ref: first.ref })).toEqual({ ref: first.ref, bytes: base64("1234") });
  });

  test("keeps every picture, and keeps uploads working, while a draft file cannot be read", async () => {
    const appDataDir = await temporaryDirectory();
    const drafts = new DraftStoreService({ appDataDir });
    await mkdir(join(drafts.draftsDir, "threads"), { recursive: true });
    const unreadable = join(drafts.draftsDir, "threads", "unreadable.json");
    await writeFile(unreadable, "", "utf8");
    const store = new AttachmentStoreService({
      appDataDir,
      referencedAttachments: () => drafts.referencedAttachments(),
    });
    const orphan = await store.put({
      id: "orphan",
      name: "orphan.txt",
      mediaType: "text/plain",
      bytes: base64("orphan"),
    });
    const fresh = await store.put({
      id: "fresh",
      name: "fresh.txt",
      mediaType: "text/plain",
      bytes: base64("fresh"),
    });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(join(appDataDir, "attachments", `${orphan.ref.id}.blob`), old, old);
    await utimes(join(appDataDir, "attachments", `${orphan.ref.id}.json`), old, old);
    await store.cleanup({ orphanAgeMs: 24 * 60 * 60 * 1000 });
    const kept = (await store.list()).refs.map((ref) => ref.id).sort();
    expect(kept).toEqual([orphan.ref.id, fresh.ref.id].sort());
    expect(await readFile(unreadable, "utf8")).toBe("");

    // Once the file is fixed or removed, the old orphan is evicted again.
    await rm(unreadable);
    await store.cleanup({ orphanAgeMs: 24 * 60 * 60 * 1000 });
    expect((await store.list()).refs.map((ref) => ref.id)).toEqual([fresh.ref.id]);
  });

  test("startup is not refused over the cap while a draft cannot be read; an upload over it is", async () => {
    const appDataDir = await temporaryDirectory();
    const roomy = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 100,
      referencedAttachments: async () => ({ refs: [], complete: true }),
    });
    const first = await roomy.put({
      id: "first",
      name: "a.txt",
      mediaType: "text/plain",
      bytes: base64("1234"),
    });
    const second = await roomy.put({
      id: "second",
      name: "b.txt",
      mediaType: "text/plain",
      bytes: base64("5678"),
    });
    // The cap is now smaller than what is stored, and a draft cannot be read.
    const drafts = new DraftStoreService({ appDataDir });
    await mkdir(join(drafts.draftsDir, "threads"), { recursive: true });
    await writeFile(join(drafts.draftsDir, "threads", "unreadable.json"), "", "utf8");
    const store = new AttachmentStoreService({
      appDataDir,
      maxTotalBytes: 4,
      referencedAttachments: () => drafts.referencedAttachments(),
    });
    await expect(store.cleanup()).resolves.toBeUndefined();
    const failure = await expectAppFailure(
      store.put({ id: "third", name: "c.txt", mediaType: "text/plain", bytes: base64("abcd") }),
    );
    expect(failure.appError).toMatchObject({ code: "unavailable", retryable: false });
    // The refused picture is not left behind; the stored ones are kept.
    const kept = (await store.list()).refs.map((ref) => ref.id).sort();
    expect(kept).toEqual([first.ref.id, second.ref.id].sort());
  });
});
