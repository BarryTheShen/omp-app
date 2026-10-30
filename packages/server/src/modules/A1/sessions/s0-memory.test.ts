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

const LIVE_LIMIT_BYTES = 100 * 1024 * 1024;
/** How often memory is read while a call runs, and how often a full collection runs. */
const SAMPLE_MS = 2;
const COLLECT_MS = 5;

/**
 * Runs `read` and returns its result with the most live memory (JS heap plus external buffers) the call held above where
 * it started. The process's RSS would also count garbage the collector has not freed yet, which depends on its timing and
 * on what ran earlier in the process; with a full collection every few milliseconds only what the call keeps is left.
 */
async function withPeakLive<T>(
  read: () => Promise<T>,
): Promise<{ readonly result: T; readonly peak: number }> {
  const live = (): number => {
    const { heapUsed, external } = process.memoryUsage();
    return heapUsed + external;
  };
  Bun.gc(true);
  const start = live();
  let peak = 0;
  const sample = (): void => {
    peak = Math.max(peak, live() - start);
  };
  const sampler = setInterval(sample, SAMPLE_MS);
  const collector = setInterval(() => Bun.gc(true), COLLECT_MS);
  try {
    const result = await read();
    // What the call returns is still held here.
    sample();
    return { result, peak };
  } finally {
    clearInterval(sampler);
    clearInterval(collector);
  }
}

const TEST_TIMEOUT_MS = 120_000;

describe("SP-S0 bounded nested session readers", () => {
  // A full collection every few milliseconds is slow in a process with a large heap: in the whole package's run the
  // list takes about ten seconds, against under half a second when this file runs alone.
  test("readSession does not load nested transcripts, while listSubagents preserves metadata", async () => {
    const fixture = await makeFixture();
    try {
      const store = new SessionFileStore({
        sessionsRoot: path.join(fixture.root, "sessions"),
        home: fixture.root,
        tempRoot: path.join(fixture.root, "tmp"),
        leaseProbe: async () => "inactive" as const,
      });
      const read = await withPeakLive(() => store.readSession(fixture.chat));
      expect(read.result.subagents).toEqual([]);
      expect(read.peak).toBeLessThan(LIVE_LIMIT_BYTES);

      const list = await withPeakLive(() => store.listSubagents(fixture.chat));
      expect(list.result.transcripts).toHaveLength(NESTED_FILES);
      expect(list.result.transcripts[0]).toMatchObject({
        key: "Worker0",
        agentId: "Worker0",
        parent: null,
        status: "stopped",
        leafId: expect.any(String),
        aborted: false,
        agent: "task",
      });
      expect(list.peak).toBeLessThan(LIVE_LIMIT_BYTES);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
