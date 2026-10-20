import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "./store";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const NESTED_FILES = 60;
const NESTED_BYTES = 5 * 1024 * 1024;
const PARENT_BYTES = 20 * 1024 * 1024;

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

async function writeSizedTranscript(
  file: string,
  bytes: number,
  id: string,
  role: "parent" | "worker",
): Promise<void> {
  const handle = await open(file, "w");
  const header = line({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-19T12:00:00.000Z",
    cwd: "/workspace/s0-memory",
  });
  const init =
    role === "worker"
      ? line({
          type: "session_init",
          id: `${id}-init`,
          parentId: null,
          timestamp: "2026-10-19T12:00:00.000Z",
          agent: "task",
        })
      : "";
  const filler = line({
    type: "custom",
    customType: "s0-memory",
    id: `${id}-filler`,
    parentId: null,
    timestamp: "2026-10-19T12:00:00.000Z",
    data: { text: "x".repeat(900_000) },
  });
  let written = 0;
  try {
    await handle.write(header);
    written += Buffer.byteLength(header);
    if (init.length > 0) {
      await handle.write(init);
      written += Buffer.byteLength(init);
    }
    const fillerBytes = Buffer.byteLength(filler);
    while (written < bytes) {
      await handle.write(filler);
      written += fillerBytes;
    }
  } finally {
    await handle.close();
  }
}

async function makeFixture(): Promise<{ readonly root: string; readonly chat: string }> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const root = await mkdtemp(path.join(WORKTREE_DATA, "s0-memory-"));
  const bucket = path.join(root, "sessions", "-workspace");
  const chat = path.join(bucket, "main.jsonl");
  await mkdir(path.join(bucket, "main"), { recursive: true });
  await writeSizedTranscript(chat, PARENT_BYTES, "main", "parent");
  await Promise.all(
    Array.from({ length: NESTED_FILES }, (_, index) =>
      writeSizedTranscript(
        path.join(bucket, "main", `Worker${index}.jsonl`),
        NESTED_BYTES,
        `worker-${index}`,
        "worker",
      ),
    ),
  );
  return { root, chat };
}

describe("SP-S0 bounded nested session readers", () => {
  test("readSession does not load nested transcripts, while listSubagents preserves metadata", async () => {
    const fixture = await makeFixture();
    try {
      const store = new SessionFileStore({
        sessionsRoot: path.join(fixture.root, "sessions"),
        home: fixture.root,
        tempRoot: path.join(fixture.root, "tmp"),
        leaseProbe: async () => "inactive" as const,
      });
      const before = process.memoryUsage().rss;
      const session = await store.readSession(fixture.chat);
      const afterRead = process.memoryUsage().rss;
      expect(session.subagents).toEqual([]);
      expect(afterRead - before).toBeLessThan(100 * 1024 * 1024);

      const listed = await store.listSubagents(fixture.chat);
      expect(listed.transcripts).toHaveLength(NESTED_FILES);
      expect(listed.transcripts[0]).toMatchObject({
        key: "Worker0",
        agentId: "Worker0",
        parent: null,
        status: "stopped",
        leafId: expect.any(String),
        aborted: false,
        agent: "task",
      });
      expect(process.memoryUsage().rss - afterRead).toBeLessThan(100 * 1024 * 1024);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
