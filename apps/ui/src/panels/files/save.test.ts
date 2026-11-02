import { createHash } from "node:crypto";
import type { FileHash, FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { resolveConflict, saveText } from "./save";
import { type FilesClient, fromBase64, toBase64 } from "./transfer";

const folder = "/work" as FolderPath;
const notes = "notes/a.md" as WorkspaceRelativePath;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") as FileHash;
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const conflict = () => Object.assign(new Error("conflict"), { appError: { code: "conflict" } });

/** The Files port in memory, with the server's rules for the expected hash. */
function fakeFiles(initial: Record<string, string>) {
  const disk = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, value]) => [path, new TextEncoder().encode(value)]),
  );
  const uploads = new Map<
    string,
    { path: string; expected: FileHash | null | undefined; bytes: Uint8Array }
  >();
  let next = 0;
  const files = {
    stat: async ({ path }: { path: string }) => {
      const bytes = disk.get(path);
      if (bytes === undefined)
        throw Object.assign(new Error("gone"), { appError: { code: "not_found" } });
      return {
        kind: "file",
        size: bytes.length,
        modifiedMs: 1,
        hash: sha(bytes),
        mediaType: "text/markdown",
      };
    },
    read: async ({ path, offset, length }: { path: string; offset: number; length: number }) => {
      const bytes = disk.get(path) ?? new Uint8Array();
      return {
        bytes: toBase64(bytes.subarray(offset, offset + length)),
        size: bytes.length,
        modifiedMs: 1,
      };
    },
    beginWrite: async ({
      path,
      expectedHash,
    }: {
      path: string;
      expectedHash?: FileHash | null;
    }) => {
      next += 1;
      uploads.set(`u${next}`, { path, expected: expectedHash, bytes: new Uint8Array() });
      return { uploadId: `u${next}` };
    },
    writeChunk: async ({ uploadId, bytes }: { uploadId: string; bytes: string }) => {
      const upload = uploads.get(uploadId);
      if (upload === undefined) throw new Error("no upload");
      const chunk = fromBase64(bytes);
      const joined = new Uint8Array(upload.bytes.length + chunk.length);
      joined.set(upload.bytes);
      joined.set(chunk, upload.bytes.length);
      upload.bytes = joined;
      return { received: joined.length };
    },
    commit: async ({ uploadId }: { uploadId: string }) => {
      const upload = uploads.get(uploadId);
      if (upload === undefined) throw new Error("no upload");
      const there = disk.get(upload.path);
      if (upload.expected === null && there !== undefined) throw conflict();
      if (
        typeof upload.expected === "string" &&
        (there === undefined || sha(there) !== upload.expected)
      ) {
        throw conflict();
      }
      disk.set(upload.path, upload.bytes);
      return { hash: sha(upload.bytes) };
    },
  };
  return { files: files as unknown as FilesClient, disk };
}

describe("saving a file and the four ways out of a conflict (#2782)", () => {
  const opened = sha(new TextEncoder().encode("first"));

  test("a save against the hash it opened with is written; against a changed file it is a conflict and writes nothing", async () => {
    const { files, disk } = fakeFiles({ [notes]: "first" });
    expect(await saveText(files, folder, notes, "mine", opened)).toMatchObject({ kind: "saved" });
    expect(text(disk.get(notes))).toBe("mine");
    disk.set(notes, new TextEncoder().encode("theirs"));
    expect(await saveText(files, folder, notes, "mine again", opened)).toEqual({
      kind: "conflict",
    });
    expect(text(disk.get(notes))).toBe("theirs");
  });

  test("Overwrite puts mine on disk over theirs", async () => {
    const { files, disk } = fakeFiles({ [notes]: "theirs" });
    const outcome = await resolveConflict("overwrite", files, folder, notes, "mine");
    expect(outcome.kind).toBe("overwritten");
    expect(text(disk.get(notes))).toBe("mine");
  });

  test("Save as copy puts mine in a dated copy beside it and leaves theirs, which the editor shows again", async () => {
    const { files, disk } = fakeFiles({ [notes]: "theirs" });
    const outcome = await resolveConflict(
      "copy",
      files,
      folder,
      notes,
      "mine",
      new Date(2026, 10, 1, 21, 5),
    );
    expect(outcome).toMatchObject({
      kind: "copied",
      copy: "notes/a (conflict 2026-11-01 2105).md",
      diskText: "theirs",
    });
    expect(text(disk.get("notes/a (conflict 2026-11-01 2105).md"))).toBe("mine");
    expect(text(disk.get(notes))).toBe("theirs");
  });

  test("Discard mine gives back the disk's text, and Compare the disk's text and hash to merge against; neither writes", async () => {
    const { files, disk } = fakeFiles({ [notes]: "theirs" });
    expect(await resolveConflict("discard", files, folder, notes, "mine")).toMatchObject({
      kind: "discarded",
      diskText: "theirs",
    });
    expect(await resolveConflict("compare", files, folder, notes, "mine")).toEqual({
      kind: "compare",
      diskText: "theirs",
      diskHash: sha(new TextEncoder().encode("theirs")),
    });
    expect(text(disk.get(notes))).toBe("theirs");
  });
});
