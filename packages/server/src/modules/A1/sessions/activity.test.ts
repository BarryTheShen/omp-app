import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { headerTimestamp, lastMessageTimestamp, TAIL_CAP_BYTES } from "./activity";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

/** A file with the given lines, one record per line. Returns its path and the directory to remove. */
async function fileWith(lines: readonly string[]): Promise<{ file: string; dir: string }> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const dir = await mkdtemp(path.join(WORKTREE_DATA, "session-activity-"));
  const file = path.join(dir, "chat.jsonl");
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { file, dir };
}

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "chat",
  timestamp: "2026-10-01T08:00:00.000Z",
  cwd: "/w",
});
const message = (timestamp: string) =>
  JSON.stringify({
    type: "message",
    id: `m-${timestamp}`,
    parentId: null,
    timestamp,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
/** A bookkeeping record of `bytes` bytes on one line: the kind of record that can come after the last message. */
const filler = (bytes: number) =>
  JSON.stringify({
    type: "session_info",
    id: "filler",
    parentId: null,
    timestamp: "2026-10-05T00:00:00.000Z",
    pad: "x".repeat(bytes),
  });

describe("activity reader", () => {
  test("a message further back than the first 16 KiB window is still found", async () => {
    const { file, dir } = await fileWith([
      header,
      message("2026-10-01T10:00:00.000Z"),
      filler(100_000),
    ]);
    try {
      expect(await lastMessageTimestamp(file)).toBe("2026-10-01T10:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a message beyond the cap is not read, and the header's time is the fallback", async () => {
    expect(TAIL_CAP_BYTES).toBe(4 * 1024 * 1024);
    const { file, dir } = await fileWith([
      header,
      message("2026-10-01T10:00:00.000Z"),
      filler(TAIL_CAP_BYTES + 64 * 1024),
    ]);
    try {
      expect(await lastMessageTimestamp(file)).toBeUndefined();
      expect(await headerTimestamp(file)).toBe("2026-10-01T08:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
