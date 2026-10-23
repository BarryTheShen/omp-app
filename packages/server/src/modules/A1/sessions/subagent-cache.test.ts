import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { RecordedOutcomeState } from "./recorded-outcomes";
import {
  createSubagentScanCache,
  SUBAGENT_CACHE_FILE,
  SubagentScanCache,
  type TranscriptIdentity,
} from "./subagent-cache";
import type { TranscriptFacts } from "./subagent-scanner";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeDirectory(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const directory = await mkdtemp(path.join(WORKTREE_DATA, "subagent-cache-"));
  directories.push(directory);
  return directory;
}

/** A real file, so the cache can check that it still exists when it loads. */
async function realFile(
  directory: string,
  name: string,
): Promise<{ readonly file: string; readonly identity: TranscriptIdentity }> {
  const file = path.join(directory, name);
  await writeFile(file, "x\n");
  const info = await stat(file);
  return {
    file,
    identity: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs },
  };
}

function factsOf(id: string): TranscriptFacts {
  return {
    header: { type: "session", id, cwd: "/workspace" },
    entryCount: 2,
    leafId: "leaf",
    agent: "task",
    sawSuccessfulYield: false,
    assistantStopReason: "stop",
    assistantError: null,
    endedNormally: true,
    warnings: [{ code: "malformed_line", message: "Malformed JSONL record", line: 3 }],
  };
}

function parentState(offset: number): RecordedOutcomeState {
  return {
    dev: 1,
    ino: 2,
    size: offset + 10,
    prefixHash: "ab",
    offset,
    outcomes: new Map([["W1", "completed"]]),
  };
}

const NEVER_FIRES = () => () => undefined;

function fail(error: unknown): never {
  throw error;
}

/** A cache on `file` whose writes happen only when the test calls `flush` or `close`. */
function cacheAt(file: string): SubagentScanCache {
  return new SubagentScanCache({ file, onError: fail, schedule: NEVER_FIRES });
}

async function transcriptKeys(file: string): Promise<string[]> {
  const parsed: { transcripts: { realpath: string }[] } = JSON.parse(await readFile(file, "utf8"));
  return parsed.transcripts.map((entry) => entry.realpath);
}

describe("SubagentScanCache", () => {
  test("transcripts and parents persist, and a new cache reads them back", async () => {
    const directory = await makeDirectory();
    const worker = await realFile(directory, "W1.jsonl");
    const parent = await realFile(directory, "chat.jsonl");
    const file = path.join(directory, "app", SUBAGENT_CACHE_FILE);
    const first = cacheAt(file);
    first.putTranscript(worker.file, worker.identity, factsOf("W1"));
    first.putParent(parent.file, parentState(4));
    await first.flush();

    const second = cacheAt(file);
    await second.ready();
    expect(second.transcript(worker.file, worker.identity)).toEqual(factsOf("W1"));
    expect(second.parent(parent.file)).toEqual(parentState(4));
  });

  test("a transcript is served only while its real path, size, mtime and inode are unchanged", async () => {
    const directory = await makeDirectory();
    const worker = await realFile(directory, "W1.jsonl");
    const cache = cacheAt(path.join(directory, SUBAGENT_CACHE_FILE));
    cache.putTranscript(worker.file, worker.identity, factsOf("W1"));
    const { identity } = worker;
    expect(cache.transcript(worker.file, identity)).toEqual(factsOf("W1"));
    expect(cache.transcript(worker.file, { ...identity, size: identity.size + 1 })).toBeUndefined();
    expect(
      cache.transcript(worker.file, { ...identity, mtimeMs: identity.mtimeMs + 1 }),
    ).toBeUndefined();
    expect(cache.transcript(worker.file, { ...identity, ino: identity.ino + 1 })).toBeUndefined();
    expect(cache.transcript(`${worker.file}.other`, identity)).toBeUndefined();
  });

  test("the least recently used transcript leaves first, and a read makes an entry recent", () => {
    const identity = { dev: 1, ino: 1, size: 1, mtimeMs: 1 };
    const cache = new SubagentScanCache({
      transcriptLimit: 2,
      onError: fail,
      schedule: NEVER_FIRES,
    });
    cache.putTranscript("/a", identity, factsOf("A"));
    cache.putTranscript("/b", identity, factsOf("B"));
    expect(cache.transcript("/a", identity)).toBeDefined();
    cache.putTranscript("/c", identity, factsOf("C"));
    expect(cache.transcript("/b", identity)).toBeUndefined();
    expect(cache.transcript("/a", identity)).toBeDefined();
    expect(cache.transcript("/c", identity)).toBeDefined();
  });

  test("the least recently used parent leaves first", () => {
    const cache = new SubagentScanCache({ parentLimit: 1, onError: fail, schedule: NEVER_FIRES });
    cache.putParent("/chat", parentState(1));
    cache.putParent("/other", parentState(2));
    expect(cache.parent("/chat")).toBeUndefined();
    expect(cache.parent("/other")).toEqual(parentState(2));
  });

  test("a file that loads without its transcript or parent forgets it, and the rewritten file no longer names it", async () => {
    const directory = await makeDirectory();
    const kept = await realFile(directory, "kept.jsonl");
    const gone = await realFile(directory, "gone.jsonl");
    const file = path.join(directory, SUBAGENT_CACHE_FILE);
    const first = cacheAt(file);
    first.putTranscript(kept.file, kept.identity, factsOf("K"));
    first.putTranscript(gone.file, gone.identity, factsOf("G"));
    first.putParent(gone.file, parentState(2));
    await first.flush();
    await rm(gone.file);

    const second = cacheAt(file);
    await second.ready();
    expect(second.transcript(kept.file, kept.identity)).toEqual(factsOf("K"));
    expect(second.transcript(gone.file, gone.identity)).toBeUndefined();
    expect(second.parent(gone.file)).toBeUndefined();
    await second.flush();
    expect(await transcriptKeys(file)).toEqual([kept.file]);
  });

  test("a file of another schema, or one that is not JSON, starts the cache empty and is then rewritten", async () => {
    const directory = await makeDirectory();
    const worker = await realFile(directory, "W1.jsonl");
    const file = path.join(directory, SUBAGENT_CACHE_FILE);
    for (const text of [`{"schema":99,"transcripts":[],"parents":[]}`, "not json at all"]) {
      await writeFile(file, text);
      const cache = cacheAt(file);
      await cache.ready();
      expect(cache.transcript(worker.file, worker.identity)).toBeUndefined();
      cache.putTranscript(worker.file, worker.identity, factsOf("W1"));
      await cache.flush();
      const written = JSON.parse(await readFile(file, "utf8"));
      expect(written.schema).toBe(1);
    }
  });

  test("an invalid entry is dropped and the valid ones are kept", async () => {
    const directory = await makeDirectory();
    const kept = await realFile(directory, "kept.jsonl");
    const file = path.join(directory, SUBAGENT_CACHE_FILE);
    const valid = { realpath: kept.file, identity: kept.identity, facts: factsOf("K") };
    const invalid = { realpath: kept.file, identity: { dev: "x" }, facts: {} };
    await writeFile(
      file,
      JSON.stringify({ schema: 1, transcripts: [valid, invalid], parents: [] }),
    );

    const cache = cacheAt(file);
    await cache.ready();
    expect(cache.transcript(kept.file, kept.identity)).toEqual(factsOf("K"));
    await cache.flush();
    expect(await transcriptKeys(file)).toEqual([kept.file]);
  });

  test("changes are written once per interval, and close writes what changed and nothing after", async () => {
    const directory = await makeDirectory();
    const file = path.join(directory, SUBAGENT_CACHE_FILE);
    const identity = { dev: 1, ino: 1, size: 1, mtimeMs: 1 };
    let clock = 0;
    const timers: { run: () => void; due: number; cancelled: boolean }[] = [];
    const cache = new SubagentScanCache({
      file,
      onError: fail,
      writeIntervalMs: 5_000,
      now: () => clock,
      schedule: (run, delayMs) => {
        const timer = { run, due: clock + delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });

    cache.putTranscript("/a", identity, factsOf("A"));
    cache.putTranscript("/b", identity, factsOf("B"));
    expect(timers.map((timer) => timer.due)).toEqual([5_000]);
    clock = 5_000;
    timers[0]?.run();
    await cache.flush();
    expect(await transcriptKeys(file)).toEqual(["/a", "/b"]);

    cache.putTranscript("/c", identity, factsOf("C"));
    expect(timers.map((timer) => timer.due)).toEqual([5_000, 10_000]);
    await cache.close();
    expect(timers[1]?.cancelled).toBe(true);
    expect(await transcriptKeys(file)).toEqual(["/a", "/b", "/c"]);

    cache.putTranscript("/d", identity, factsOf("D"));
    await cache.flush();
    expect(await transcriptKeys(file)).toEqual(["/a", "/b", "/c"]);
  });

  test("a write that fails is reported, and the cache keeps serving from memory", async () => {
    const directory = await makeDirectory();
    const blocker = path.join(directory, "not-a-folder");
    await writeFile(blocker, "x");
    const identity = { dev: 1, ino: 1, size: 1, mtimeMs: 1 };
    const errors: unknown[] = [];
    const cache = new SubagentScanCache({
      file: path.join(blocker, SUBAGENT_CACHE_FILE),
      onError: (error) => errors.push(error),
      schedule: NEVER_FIRES,
    });
    cache.putTranscript("/a", identity, factsOf("A"));
    await cache.flush();
    expect(errors).toHaveLength(1);
    expect(cache.transcript("/a", identity)).toEqual(factsOf("A"));
  });

  test("the store's cache is session-subagents.json in the app data folder, and memory-only without one", async () => {
    const appData = path.join(await makeDirectory(), "app");
    const identity = { dev: 1, ino: 1, size: 1, mtimeMs: 1 };
    const cache = createSubagentScanCache(appData, { onError: fail, schedule: NEVER_FIRES });
    cache.putTranscript("/a", identity, factsOf("A"));
    await cache.flush();
    expect(await transcriptKeys(path.join(appData, SUBAGENT_CACHE_FILE))).toEqual(["/a"]);

    const memory = createSubagentScanCache(undefined, { onError: fail, schedule: NEVER_FIRES });
    memory.putTranscript("/a", identity, factsOf("A"));
    await memory.flush();
    expect(memory.transcript("/a", identity)).toEqual(factsOf("A"));
  });
});
