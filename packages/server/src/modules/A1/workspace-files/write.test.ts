import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHash, FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import { TRASH_KEEP_MS, WorkspaceTrash } from "./trash";
import { UPLOAD_IDLE_MS, WorkspaceWrites } from "./write";

let scratch: string;
let folder: FolderPath;
let clock: { now: number };
let logged: string[];
let writes: WorkspaceWrites;
let trash: WorkspaceTrash;
const path = (text: string) => text as WorkspaceRelativePath;
const sha = (text: string) => createHash("sha256").update(text).digest("hex") as FileHash;
const base64 = (text: string) => Buffer.from(text).toString("base64");
const failureCode = (call: Promise<unknown>) =>
  call.then(
    () => "none",
    (failure: unknown) => (failure as { appError?: { code?: string } }).appError?.code,
  );
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** Uploads `text` to `at` in two chunks, with `expectedHash` as given, and commits it. */
async function upload(at: string, text: string, expectedHash?: FileHash | null) {
  const { uploadId } = await writes.beginWrite(
    { folder, path: path(at), ...(expectedHash === undefined ? {} : { expectedHash }) },
    "device-1",
  );
  const half = Math.floor(text.length / 2);
  await writes.writeChunk({ uploadId, offset: 0, bytes: base64(text.slice(0, half)) });
  await writes.writeChunk({
    uploadId,
    offset: Buffer.byteLength(text.slice(0, half)),
    bytes: base64(text.slice(half)),
  });
  return writes.commit({ uploadId });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "omp-app-workspace-writes-"));
  folder = join(scratch, "folder") as FolderPath;
  await mkdir(join(folder, ".git"), { recursive: true });
  await mkdir(join(folder, "notes"));
  await writeFile(join(folder, "notes", "a.md"), "first");
  clock = { now: 1_790_000_000_000 };
  logged = [];
  const deps = {
    dataDir: join(scratch, "data"),
    now: () => clock.now,
    log: (event: string, fields: Readonly<Record<string, string>>) =>
      logged.push(`${event} ${JSON.stringify(fields)}`),
  };
  writes = new WorkspaceWrites(deps);
  trash = new WorkspaceTrash(deps);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the Files panel's writes (#2782)", () => {
  test("a save with the hash it opened replaces the file; a stale hash fails with conflict and leaves the file as it was", async () => {
    const saved = await upload("notes/a.md", "second", sha("first"));
    expect(saved.hash).toBe(sha("second"));
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("second");

    expect(await failureCode(upload("notes/a.md", "third", sha("first")))).toBe("conflict");
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("second");
    // The failed commit took its upload with it.
    expect(writes.pending).toBe(0);
  });

  test("null means the file must not exist yet: a new file is made, an existing one is left alone", async () => {
    await upload("notes/new.md", "fresh", null);
    expect(await readFile(join(folder, "notes", "new.md"), "utf8")).toBe("fresh");
    expect(await failureCode(upload("notes/a.md", "over", null))).toBe("conflict");
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("first");
  });

  test("a write with no expected hash overwrites, and is logged as one without its content", async () => {
    await upload("notes/a.md", "chosen overwrite");
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("chosen overwrite");
    expect(logged.at(-1)).toContain('"overwrite":"true"');
    expect(logged.join("\n")).not.toContain("chosen overwrite");
  });

  test("chunks come in order: one that does not start where the last ended is refused", async () => {
    const { uploadId } = await writes.beginWrite(
      { folder, path: path("notes/b.md"), expectedHash: null },
      "d",
    );
    await writes.writeChunk({ uploadId, offset: 0, bytes: base64("abc") });
    expect(await failureCode(writes.writeChunk({ uploadId, offset: 10, bytes: base64("x") }))).toBe(
      "invalid_args",
    );
  });

  test("an upload left idle for ten minutes is dropped with its bytes", async () => {
    const { uploadId } = await writes.beginWrite(
      { folder, path: path("notes/c.md"), expectedHash: null },
      "d",
    );
    clock.now += UPLOAD_IDLE_MS;
    await writes.dropIdle();
    expect(await failureCode(writes.commit({ uploadId }))).toBe("not_found");
    expect(await exists(join(folder, "notes", "c.md"))).toBe(false);
  });

  test("nothing under .git is written, made, moved or trashed", async () => {
    expect(await failureCode(upload(".git/config", "x", null))).toBe("permission");
    expect(
      await failureCode(writes.createDirectory({ folder, path: path(".git/hooks2") }, "d")),
    ).toBe("permission");
    expect(
      await failureCode(
        writes.move({ folder, from: path("notes/a.md"), to: path(".git/a.md") }, "d"),
      ),
    ).toBe("permission");
    expect(await failureCode(trash.trash({ folder, path: path(".git") }, "d"))).toBe("permission");
  });

  test("a move never overwrites what is at the new place", async () => {
    await writeFile(join(folder, "notes", "b.md"), "kept");
    expect(
      await failureCode(
        writes.move({ folder, from: path("notes/a.md"), to: path("notes/b.md") }, "d"),
      ),
    ).toBe("conflict");
    expect(await readFile(join(folder, "notes", "b.md"), "utf8")).toBe("kept");
    await writes.move({ folder, from: path("notes/a.md"), to: path("notes/renamed.md") }, "d");
    expect(await readFile(join(folder, "notes", "renamed.md"), "utf8")).toBe("first");
  });
});

describe("the Files panel's trash (#2782)", () => {
  test("a trashed item comes back where it was; restoring onto a taken place fails with conflict", async () => {
    const { trashId } = await trash.trash({ folder, path: path("notes/a.md") }, "d");
    expect(await exists(join(folder, "notes", "a.md"))).toBe(false);
    expect(await trash.restore({ trashId }, "d")).toEqual({ folder, path: path("notes/a.md") });
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("first");

    const again = await trash.trash({ folder, path: path("notes/a.md") }, "d");
    await writeFile(join(folder, "notes", "a.md"), "newer");
    expect(await failureCode(trash.restore({ trashId: again.trashId }, "d"))).toBe("conflict");
    expect(await readFile(join(folder, "notes", "a.md"), "utf8")).toBe("newer");
  });

  test("the sweep removes trash older than seven days and keeps newer trash", async () => {
    const old = await trash.trash({ folder, path: path("notes/a.md") }, "d");
    clock.now += TRASH_KEEP_MS - 60_000;
    await writeFile(join(folder, "notes", "b.md"), "b");
    const recent = await trash.trash({ folder, path: path("notes/b.md") }, "d");
    clock.now += 120_000;
    expect(await trash.sweep()).toBe(1);
    expect(await failureCode(trash.restore({ trashId: old.trashId }, "d"))).toBe("not_found");
    await trash.restore({ trashId: recent.trashId }, "d");
    expect(await readFile(join(folder, "notes", "b.md"), "utf8")).toBe("b");
  });
});
