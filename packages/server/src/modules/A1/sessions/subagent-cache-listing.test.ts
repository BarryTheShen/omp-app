import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SUBAGENT_CACHE_FILE, SubagentScanCache } from "./subagent-cache";
import {
  collectSubagentTranscripts,
  type SubagentCollection,
  type WorkerLeaseProbe,
} from "./subagents";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const AT = "2026-10-04T12:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

function header(id: string): Record<string, unknown> {
  return { type: "session", version: 3, id, timestamp: AT, cwd: "/workspace" };
}

function init(agent: string): Record<string, unknown> {
  return { type: "session_init", id: "init", parentId: null, timestamp: AT, agent };
}

function assistant(stopReason: string, errorMessage?: string): Record<string, unknown> {
  return {
    type: "message",
    id: `assistant-${stopReason}`,
    parentId: null,
    timestamp: AT,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  };
}

function userMessage(): Record<string, unknown> {
  return {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: AT,
    message: { role: "user", content: [{ type: "text", text: "go" }] },
  };
}

function yieldResult(status: string): Record<string, unknown> {
  return {
    type: "message",
    id: "yield",
    parentId: null,
    timestamp: AT,
    message: {
      role: "toolResult",
      toolCallId: "call_yield",
      toolName: "yield",
      content: [],
      details: { status },
      isError: false,
    },
  };
}

function asyncResult(id: string, status: string): Record<string, unknown> {
  return {
    type: "custom_message",
    customType: "async-result",
    content: `<system-notice>finished</system-notice>\n<task-result id="${id}" agent="task" status="${status}">\ndone\n</task-result>`,
  };
}

async function writeRecords(
  file: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${records.map(line).join("\n")}\n`);
}

async function makeDirectory(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const directory = await mkdtemp(path.join(WORKTREE_DATA, "subagent-listing-"));
  directories.push(directory);
  return directory;
}

interface Tree {
  readonly chat: string;
  readonly workers: string;
}

/**
 * A chat with every kind of worker a listing reads: finished, failed, aborted by a marker, stopped, unknown, a nested
 * worker with its own child, a transcript with parse warnings, a transcript with no header, and files that are not
 * collected (an advisor file).
 */
async function makeTree(): Promise<Tree> {
  const root = await makeDirectory();
  const bucket = path.join(root, "sessions", "-workspace");
  const chat = path.join(bucket, "main.jsonl");
  const workers = path.join(bucket, "main");
  await writeRecords(chat, [
    header("main"),
    asyncResult("Done", "completed"),
    asyncResult("Failed", "failed"),
    asyncResult("Aborted", "aborted"),
    asyncResult("Nested", "completed"),
  ]);
  await writeRecords(path.join(workers, "Done.jsonl"), [
    header("Done"),
    init("task"),
    assistant("stop"),
    yieldResult("success"),
  ]);
  await writeRecords(path.join(workers, "Failed.jsonl"), [
    header("Failed"),
    init("task"),
    assistant("error", "Provider overloaded"),
  ]);
  await writeRecords(path.join(workers, "Aborted.jsonl"), [
    header("Aborted"),
    init("task"),
    assistant("stop"),
  ]);
  await writeFile(path.join(workers, "Aborted.jsonl.tombstone"), "");
  await writeRecords(path.join(workers, "Stopped.jsonl"), [
    header("Stopped"),
    init("task"),
    assistant("stop"),
  ]);
  await writeRecords(path.join(workers, "Unknown.jsonl"), [
    header("Unknown"),
    init("task"),
    userMessage(),
  ]);
  await writeRecords(path.join(workers, "Nested.jsonl"), [
    header("Nested"),
    init("task"),
    assistant("stop"),
    asyncResult("Child", "failed"),
  ]);
  await writeRecords(path.join(workers, "Nested", "Child.jsonl"), [
    header("Child"),
    init("task"),
    assistant("error", "Child crashed"),
  ]);
  await writeFile(
    path.join(workers, "Messy.jsonl"),
    `${line(init("task"))}\n${line(header("Messy"))}\n{not json\n${line(assistant("stop"))}`,
  );
  await writeFile(path.join(workers, "Broken.jsonl"), "{not a header}\n");
  await writeRecords(path.join(workers, "__advisor.jsonl"), [header("Advisor")]);
  return { chat, workers };
}

/** A cache that has read nothing: a listing through it reads every file, as a first listing does. */
function emptyCache(): SubagentScanCache {
  return new SubagentScanCache({
    onError: (error) => {
      throw error;
    },
    schedule: () => () => undefined,
  });
}

function uncachedOf(chat: string, leaseOf?: WorkerLeaseProbe): Promise<SubagentCollection> {
  return collectSubagentTranscripts(chat, leaseOf, emptyCache());
}

function statusesOf(listing: SubagentCollection): Record<string, string> {
  return Object.fromEntries(listing.subagents.map((worker) => [worker.key, worker.status]));
}

function workerOf(listing: SubagentCollection, key: string) {
  const worker = listing.subagents.find((item) => item.key === key);
  if (worker === undefined) throw new Error(`no worker ${key}`);
  return worker;
}

describe("subagent listing through the cache", () => {
  test("a cached listing equals an uncached one through every change a worker's files can take", async () => {
    const tree = await makeTree();
    let lease: "free" | "held" = "held";
    const leaseOf: WorkerLeaseProbe = async () => lease;
    const cache = emptyCache();
    const cachedListing = async (): Promise<SubagentCollection> => {
      const cached = await collectSubagentTranscripts(tree.chat, leaseOf, cache);
      expect(cached).toEqual(await uncachedOf(tree.chat, leaseOf));
      return cached;
    };

    const first = await cachedListing();
    expect(statusesOf(first)).toEqual({
      Done: "completed",
      Failed: "failed",
      Aborted: "aborted",
      Stopped: "stopped",
      Unknown: "unknown",
      Nested: "stopped",
      "Nested/Child": "failed",
      Messy: "stopped",
    });
    expect(workerOf(first, "Failed").reason).toBe("Provider overloaded");
    expect(workerOf(first, "Nested/Child").recordedStatus).toBe("failed");
    expect(first.parseWarnings.map((warning) => warning.code).sort()).toEqual([
      "header_not_first",
      "invalid_header",
      "malformed_line",
      "malformed_line",
    ]);

    lease = "free";
    expect(workerOf(await cachedListing(), "Unknown").status).toBe("stopped");
    await appendFile(path.join(tree.workers, "Unknown.jsonl"), `${line(yieldResult("success"))}\n`);
    expect(workerOf(await cachedListing(), "Unknown").status).toBe("completed");
    await writeFile(path.join(tree.workers, "Done.jsonl.tombstone"), "");
    expect(workerOf(await cachedListing(), "Done")).toMatchObject({
      aborted: true,
      status: "completed",
    });
    await appendFile(tree.chat, `${line(asyncResult("Stopped", "failed"))}\n`);
    expect(workerOf(await cachedListing(), "Stopped").recordedStatus).toBe("failed");
    await appendFile(
      path.join(tree.workers, "Nested.jsonl"),
      `${line(asyncResult("Child", "completed"))}\n`,
    );
    expect(workerOf(await cachedListing(), "Nested/Child").recordedStatus).toBe("completed");
    await writeRecords(path.join(tree.workers, "Failed.jsonl"), [
      header("Failed"),
      init("task"),
      assistant("stop"),
    ]);
    expect(workerOf(await cachedListing(), "Failed").status).toBe("stopped");
    await rm(path.join(tree.workers, "Aborted.jsonl.tombstone"));
    expect(workerOf(await cachedListing(), "Aborted").status).toBe("stopped");
  });

  test("after a restart, a listing reads no transcript and no parent that is unchanged", async () => {
    const tree = await makeTree();
    const appData = await makeDirectory();
    const file = path.join(appData, SUBAGENT_CACHE_FILE);
    const first = new SubagentScanCache({
      file,
      onError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    });
    const listed = await collectSubagentTranscripts(tree.chat, undefined, first);
    await first.flush();

    const reads: { readonly file: string; readonly bytes: number }[] = [];
    const restarted = new SubagentScanCache({
      file,
      onError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
      onRead: (readFile, bytes) => reads.push({ file: readFile, bytes }),
    });
    expect(await collectSubagentTranscripts(tree.chat, undefined, restarted)).toEqual(listed);
    expect(reads).toEqual([]);
  });

  test("after a restart, only the transcript and the chat that changed are read, and the chat only from its offset", async () => {
    const tree = await makeTree();
    const appData = await makeDirectory();
    const file = path.join(appData, SUBAGENT_CACHE_FILE);
    const first = new SubagentScanCache({
      file,
      onError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    });
    await collectSubagentTranscripts(tree.chat, undefined, first);
    await first.flush();

    const changed = path.join(tree.workers, "Unknown.jsonl");
    await appendFile(changed, `${line(yieldResult("success"))}\n`);
    const appended = `${line(asyncResult("Stopped", "failed"))}\n`;
    await appendFile(tree.chat, appended);
    const reads: { readonly file: string; readonly bytes: number }[] = [];
    const restarted = new SubagentScanCache({
      file,
      onError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
      onRead: (readFile, bytes) => reads.push({ file: readFile, bytes }),
    });
    expect(await collectSubagentTranscripts(tree.chat, undefined, restarted)).toEqual(
      await uncachedOf(tree.chat),
    );
    expect(new Set(reads.map((read) => read.file))).toEqual(new Set([changed, tree.chat]));
    const chatBytes = reads
      .filter((read) => read.file === tree.chat)
      .reduce((sum, read) => sum + read.bytes, 0);
    expect(chatBytes).toBe(Buffer.byteLength(appended));
  });

  test("a cache whose limits overflow still lists every worker as an uncached listing does", async () => {
    const tree = await makeTree();
    const cache = new SubagentScanCache({
      transcriptLimit: 2,
      parentLimit: 1,
      onError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    });
    const expected = await uncachedOf(tree.chat);
    expect(await collectSubagentTranscripts(tree.chat, undefined, cache)).toEqual(expected);
    expect(await collectSubagentTranscripts(tree.chat, undefined, cache)).toEqual(expected);
  });
});
