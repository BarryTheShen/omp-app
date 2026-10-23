import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { EntryId, SessionFilePath } from "@omp-app/contracts";
import { isJsonObject } from "./parser";
import { SessionFileStore } from "./store";
import { IMAGE_BLOB_MAX_BYTES, OUTPUT_CUT_BYTES, readEntryOutput, readEntryWindow } from "./window";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "session-window-"));
}

function header(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-04T12:00:00.000Z",
    cwd: "/work",
  });
}

function message(id: string, parentId: string | null, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-04T12:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}
function compaction(id: string, parentId: string, firstKeptEntryId: string): string {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId,
    summary: "Keep the current goal.",
    shortSummary: "Keep the goal.",
    firstKeptEntryId,
    tokensBefore: 120_000,
    tokensAfter: 28_000,
    method: "remote",
    timestamp: "2026-10-04T12:00:00.000Z",
  });
}

function toolResult(id: string, parentId: string | null, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-04T12:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
    },
  });
}

function ids(entries: readonly Record<string, unknown>[]): unknown[] {
  return entries.map((entry) => entry.id);
}

/** One named field of an entry's message, read after a runtime check. */
function messageField(entry: Record<string, unknown> | undefined, field: string): unknown {
  const body = entry?.message;
  return isJsonObject(body) ? body[field] : undefined;
}

/** The text of an entry's first content part, or "" when it has none. */
function textOf(entry: Record<string, unknown> | undefined): string {
  const parts = messageField(entry, "content");
  const part: unknown = Array.isArray(parts) ? parts[0] : undefined;
  if (!isJsonObject(part)) return "";
  return typeof part.text === "string" ? part.text : "";
}

describe("session entry windows", () => {
  test("walks the branch from the leaf, not from the file's last line", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "branches.jsonl");
      await writeFile(
        file,
        `${[
          header("s"),
          message("r1", null, "root"),
          message("a2", "r1", "branch A"),
          message("c4", "a2", "branch A leaf"),
          message("b3", "r1", "branch B, written last"),
        ].join("\n")}\n`,
        "utf8",
      );

      const latest = await readEntryWindow(file, {});
      expect(latest.leafId).toBe(EntryId.parse("b3"));
      expect(ids(latest.entries)).toEqual(["r1", "b3"]);

      const branch = await readEntryWindow(file, { leafId: EntryId.parse("c4") });
      expect(branch.leafId).toBe(EntryId.parse("c4"));
      expect(branch.fileLastId).toBe(EntryId.parse("b3"));
      expect(ids(branch.entries)).toEqual(["r1", "a2", "c4"]);
      expect(branch.hasOlder).toBe(false);
      expect(branch.oldestId).toBe(EntryId.parse("r1"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("walks through compaction entries as part of the branch", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "compaction.jsonl");
      await writeFile(
        file,
        `${[
          header("compaction"),
          message("u1", null, "root"),
          message("a2", "u1", "before compact"),
          compaction("c3", "a2", "u4"),
          message("u4", "c3", "after compact"),
        ].join("\n")}\n`,
        "utf8",
      );

      const page = await readEntryWindow(file, {});
      expect(page.leafId).toBe(EntryId.parse("u4"));
      expect(ids(page.entries)).toEqual(["u1", "a2", "c3", "u4"]);
      expect(page.hasOlder).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads an entry that crosses a reverse-scan chunk boundary", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "chunk-boundary.jsonl");
      const text = "x".repeat(1024 * 1024 + 100);
      await writeFile(
        file,
        `${[header("chunk-boundary"), message("u1", null, text)].join("\n")}\n`,
        "utf8",
      );

      const page = await readEntryWindow(file, {});
      expect(ids(page.entries)).toEqual(["u1"]);
      expect(textOf(page.entries[0])).toBe(text);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fills the byte budget newest first and pages older entries by id", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "chain.jsonl");
      const names = Array.from({ length: 10 }, (_, index) => `e${index}`);
      const lines = [header("chain")];
      names.forEach((name, index) => {
        lines.push(
          message(name, index === 0 ? null : (names[index - 1] ?? null), "x".repeat(1000)),
        );
      });
      await writeFile(file, `${lines.join("\n")}\n`, "utf8");

      const pages: unknown[][] = [];
      let page = await readEntryWindow(file, { byteBudget: 3500 });
      const explicitLatest = await readEntryWindow(file, {
        leafId: EntryId.parse("e9"),
        byteBudget: 3500,
      });
      expect(explicitLatest).toEqual(page);
      pages.push(ids(page.entries));
      while (page.hasOlder) {
        page = await readEntryWindow(file, {
          byteBudget: 3500,
          before: page.oldestId ?? undefined,
        });
        pages.push(ids(page.entries));
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0]).toEqual(["e7", "e8", "e9"]);
      expect(pages.reverse().flat()).toEqual(names);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pages near the start of a middle leaf's branch like the index path", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "near-start.jsonl");
      const names = Array.from({ length: 201 }, (_, index) => `e${index}`);
      const lines = [header("near-start")];
      names.forEach((name, index) => {
        lines.push(message(name, index === 0 ? null : (names[index - 1] ?? null), name));
      });
      await writeFile(file, `${lines.join("\n")}\n`, "utf8");

      const leafId = EntryId.parse("e100");
      const before = EntryId.parse("e2");
      const page = await readEntryWindow(file, { leafId, before });
      const expected = [
        await readEntryOutput(file, EntryId.parse("e0")),
        await readEntryOutput(file, EntryId.parse("e1")),
      ];

      expect(page.entries).toEqual(expected);
      expect(page.leafId).toBe(leafId);
      expect(page.fileLastId).toBe(EntryId.parse("e200"));
      expect(page.oldestId).toBe(EntryId.parse("e0"));
      expect(page.hasOlder).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("always includes the newest entry, even when it alone is over the budget", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "one.jsonl");
      await writeFile(
        file,
        `${[
          header("one"),
          message("u1", null, "older"),
          message("u2", "u1", "y".repeat(5000)),
        ].join("\n")}\n`,
        "utf8",
      );
      const page = await readEntryWindow(file, { byteBudget: 1024 });
      expect(ids(page.entries)).toEqual(["u2"]);
      expect(page.hasOlder).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shortens a long tool or bash output, marks the cut, and reads the full text back", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "outputs.jsonl");
      const longOutput = `HEAD-${"y".repeat(200_000)}-TAIL`;
      const longUserText = "u".repeat(100_000);
      const bash = JSON.stringify({
        type: "message",
        id: "b3",
        parentId: "t2",
        timestamp: "2026-10-04T12:00:00.000Z",
        message: { role: "bashExecution", command: "ls", output: longOutput, exitCode: 0 },
      });
      await writeFile(
        file,
        `${[
          header("outputs"),
          message("u1", null, longUserText),
          toolResult("t2", "u1", longOutput),
          bash,
        ].join("\n")}\n`,
        "utf8",
      );

      const page = await readEntryWindow(file, {});
      const user = page.entries.find((entry) => entry.id === "u1");
      expect(textOf(user)).toBe(longUserText);
      expect(messageField(user, "outputCut")).toBeUndefined();

      const result = page.entries.find((entry) => entry.id === "t2");
      expect(messageField(result, "outputCut")).toEqual({
        shownBytes: 64 * 1024,
        totalBytes: Buffer.byteLength(longOutput, "utf8"),
      });
      const shortened = textOf(result);
      expect(shortened.startsWith("HEAD-")).toBe(true);
      expect(shortened.endsWith("-TAIL")).toBe(true);
      expect(shortened).toContain("bytes left out");
      expect(shortened.length).toBeLessThan(OUTPUT_CUT_BYTES + 256);

      const cutBash = page.entries.find((entry) => entry.id === "b3");
      expect(messageField(cutBash, "outputCut")).toBeDefined();
      expect(String(messageField(cutBash, "output"))).toContain("bytes left out");

      const full = await readEntryOutput(file, EntryId.parse("t2"));
      expect(textOf(full)).toBe(longOutput);
      expect(messageField(full, "outputCut")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores an incomplete last line until it is completed", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "growing.jsonl");
      const third = message("u3", "u2", "three");
      await writeFile(
        file,
        [header("growing"), message("u1", null, "one"), message("u2", "u1", "two")].join("\n") +
          `\n${third.slice(0, 30)}`,
        "utf8",
      );

      const first = await readEntryWindow(file, {});
      expect(first.fileLastId).toBe(EntryId.parse("u2"));
      expect(ids(first.entries)).toEqual(["u1", "u2"]);

      await expect(readEntryOutput(file, EntryId.parse("u3"))).rejects.toMatchObject({
        appError: { code: "not_found" },
      });
      await appendFile(file, `${third.slice(30)}\n`, "utf8");
      const second = await readEntryWindow(file, {});
      expect(second.fileLastId).toBe(EntryId.parse("u3"));
      expect(ids(second.entries)).toEqual(["u1", "u2", "u3"]);
      expect(textOf(await readEntryOutput(file, EntryId.parse("u3")))).toBe("three");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads a rewritten file from its current contents", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "rewritten.jsonl");
      await writeFile(
        file,
        `${[header("first"), message("u1", null, "one"), message("u2", "u1", "two")].join("\n")}\n`,
        "utf8",
      );
      expect(ids((await readEntryWindow(file, {})).entries)).toEqual(["u1", "u2"]);

      await writeFile(
        file,
        `${[header("second"), message("x1", null, "replaced")].join("\n")}\n`,
        "utf8",
      );
      expect(ids((await readEntryWindow(file, {})).entries)).toEqual(["x1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a leaf that is not in the file, and a before id that is not on the branch", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "refuse.jsonl");
      await writeFile(
        file,
        `${[
          header("refuse"),
          message("r1", null, "root"),
          message("a2", "r1", "A"),
          message("b3", "r1", "B"),
        ].join("\n")}\n`,
        "utf8",
      );
      await expect(
        readEntryWindow(file, { leafId: EntryId.parse("missing") }),
      ).rejects.toMatchObject({ appError: { code: "not_found" } });
      await expect(
        readEntryWindow(file, { leafId: EntryId.parse("a2"), before: EntryId.parse("b3") }),
      ).rejects.toMatchObject({ appError: { code: "not_found" } });
      await expect(readEntryOutput(file, EntryId.parse("missing"))).rejects.toMatchObject({
        appError: { code: "not_found" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a session file the store does not list, including one outside the sessions root", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const listed = path.join(sessionsRoot, "-work", "listed.jsonl");
      const outside = path.join(root, "outside.jsonl");
      await mkdir(path.dirname(listed), { recursive: true });
      await writeFile(
        listed,
        `${[header("listed"), message("u1", null, "listed text")].join("\n")}\n`,
        "utf8",
      );
      await writeFile(
        outside,
        `${[header("outside"), message("o1", null, "outside text")].join("\n")}\n`,
        "utf8",
      );
      const store = new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
      });

      const page = await store.readEntryWindow({ sessionFile: SessionFilePath.parse(listed) });
      expect(ids(page.entries)).toEqual(["u1"]);
      await expect(
        store.readEntryWindow({ sessionFile: SessionFilePath.parse(outside) }),
      ).rejects.toMatchObject({ appError: { code: "not_found" } });
      await expect(
        store.readEntryOutput({
          sessionFile: SessionFilePath.parse(outside),
          entryId: EntryId.parse("o1"),
        }),
      ).rejects.toMatchObject({ appError: { code: "not_found" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("session entry pictures", () => {
  test("carries the bytes of a picture omp saved beside the session, and keeps references it cannot load", async () => {
    const root = await makeTempRoot();
    try {
      const file = path.join(root, "pictures.jsonl");
      const blobs = path.join(root, "blobs");
      await mkdir(blobs, { recursive: true });
      const saved = Buffer.from("a saved picture");
      const savedHex = "a".repeat(64);
      const missingHex = "b".repeat(64);
      const largeHex = "c".repeat(64);
      await writeFile(path.join(blobs, savedHex), saved);
      await writeFile(path.join(blobs, largeHex), Buffer.alloc(IMAGE_BLOB_MAX_BYTES + 1));
      await writeFile(
        file,
        `${[
          header("p"),
          pictureResult("p1", null, `blob:sha256:${savedHex}`),
          pictureResult("p2", "p1", `blob:sha256:${missingHex}`),
          pictureResult("p3", "p2", `blob:sha256:${largeHex}`),
        ].join("\n")}\n`,
        "utf8",
      );

      const window = await readEntryWindow(file, { blobsDir: blobs });
      expect(window.entries.map(pictureData)).toEqual([
        saved.toString("base64"),
        `blob:sha256:${missingHex}`,
        `blob:sha256:${largeHex}`,
      ]);

      const withoutBlobs = await readEntryWindow(file, {});
      expect(pictureData(withoutBlobs.entries[0])).toBe(`blob:sha256:${savedHex}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function pictureResult(id: string, parentId: string | null, data: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-04T12:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "read",
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data, mimeType: "image/png" },
      ],
      isError: false,
    },
  });
}

/** The data of an entry's second content part, the picture; undefined when there is none. */
function pictureData(entry: Record<string, unknown> | undefined): unknown {
  const parts = messageField(entry, "content");
  const part: unknown = Array.isArray(parts) ? parts[1] : undefined;
  return isJsonObject(part) ? part.data : undefined;
}
