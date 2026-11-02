import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import { MAX_FILE_CHUNK_BYTES } from "@omp-app/contracts";
import { listEntries, readChunk, statPath } from "./read";

let scratch: string;
let folder: FolderPath;
const path = (text: string) => text as WorkspaceRelativePath;
const codeOf = (failure: unknown) => (failure as { appError?: { code?: string } }).appError?.code;
const failureCode = (call: Promise<unknown>) => call.then(() => "none", codeOf);

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "omp-app-workspace-files-"));
  folder = join(scratch, "folder") as FolderPath;
  await mkdir(join(folder, "docs"), { recursive: true });
  await mkdir(join(scratch, "outside"));
  await writeFile(join(scratch, "outside", "secret.txt"), "not yours");
  await writeFile(join(folder, "docs", "inside.txt"), "yours");
  await symlink(join(folder, "docs", "inside.txt"), join(folder, "link-in"));
  await symlink(join(scratch, "outside", "secret.txt"), join(folder, "link-out"));
  await symlink(join(scratch, "outside"), join(folder, "dir-out"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the Files panel's reading (#2782)", () => {
  test("a symlink to outside the folder is listed but never followed; one inside is read through", async () => {
    const { entries } = await listEntries({ folder, showIgnored: false });
    const linkOut = entries.find((entry) => entry.name === "link-out");
    const linkIn = entries.find((entry) => entry.name === "link-in");
    expect(linkOut).toMatchObject({ kind: "symlink", targetInside: false });
    expect(linkIn).toMatchObject({ kind: "symlink", targetInside: true });

    expect(
      await failureCode(readChunk({ folder, path: path("link-out"), offset: 0, length: 64 })),
    ).toBe("permission");
    expect(await failureCode(statPath({ folder, path: path("link-out") }))).toBe("permission");
    const read = await readChunk({ folder, path: path("link-in"), offset: 0, length: 64 });
    expect(Buffer.from(read.bytes, "base64").toString()).toBe("yours");
  });

  test("a path whose directory leads out of the folder through a symlink is refused", async () => {
    expect(
      await failureCode(
        readChunk({ folder, path: path("dir-out/secret.txt"), offset: 0, length: 64 }),
      ),
    ).toBe("permission");
    expect(
      await failureCode(listEntries({ folder, path: path("dir-out"), showIgnored: false })),
    ).toBe("permission");
  });

  test("a FIFO is refused at once, not waited on", async () => {
    const fifo = join(folder, "pipe");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);
    const started = performance.now();
    expect(
      await failureCode(readChunk({ folder, path: path("pipe"), offset: 0, length: 64 })),
    ).toBe("invalid_args");
    expect(performance.now() - started).toBeLessThan(1000);
    const { entries } = await listEntries({ folder, showIgnored: false });
    expect(entries.find((entry) => entry.name === "pipe")?.kind).toBe("other");
    await rm(fifo);
  });

  test("a 3 MiB binary read in chunks is the same file, byte for byte", async () => {
    const bytes = randomBytes(3 * 1024 * 1024);
    await writeFile(join(folder, "blob.bin"), bytes);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += MAX_FILE_CHUNK_BYTES) {
      const read = await readChunk({
        folder,
        path: path("blob.bin"),
        offset,
        length: MAX_FILE_CHUNK_BYTES,
      });
      expect(read.size).toBe(bytes.length);
      chunks.push(Buffer.from(read.bytes, "base64"));
    }
    const whole = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
    expect(whole).toBe(createHash("sha256").update(bytes).digest("hex"));
    const stat = await statPath({ folder, path: path("blob.bin") });
    expect(stat).toMatchObject({ kind: "file", size: bytes.length, hash: whole });
  });

  test("a list puts directories first, then names in people's order; ignored names only when asked; truncated past the limit", async () => {
    const sorted = join(folder, "sorted");
    await mkdir(join(sorted, "zdir"), { recursive: true });
    await mkdir(join(sorted, "node_modules"));
    for (const name of ["b10.txt", "b2.txt", "A.txt"]) await writeFile(join(sorted, name), name);

    const plain = await listEntries({ folder, path: path("sorted"), showIgnored: false });
    expect(plain.entries.map((entry) => entry.name)).toEqual([
      "zdir",
      "A.txt",
      "b2.txt",
      "b10.txt",
    ]);
    expect(plain.truncated).toBe(false);

    const all = await listEntries({ folder, path: path("sorted"), showIgnored: true });
    expect(all.entries.find((entry) => entry.name === "node_modules")).toMatchObject({
      kind: "directory",
      ignored: true,
    });

    const capped = await listEntries({ folder, path: path("sorted"), showIgnored: false }, 2);
    expect(capped.entries.map((entry) => entry.name)).toEqual(["zdir", "A.txt"]);
    expect(capped.truncated).toBe(true);
  });

  test("stat names a file's media type from its name, and a directory has no hash", async () => {
    await writeFile(join(folder, "notes.md"), "# Notes");
    expect(await statPath({ folder, path: path("notes.md") })).toMatchObject({
      kind: "file",
      mediaType: "text/markdown",
    });
    expect(await statPath({ folder, path: path("docs") })).toMatchObject({
      kind: "directory",
      hash: null,
    });
    expect(await failureCode(statPath({ folder, path: path("nothing-here.txt") }))).toBe(
      "not_found",
    );
  });
});
