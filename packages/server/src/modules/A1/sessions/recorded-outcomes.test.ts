import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  clearRecordedOutcomeScans,
  recordedOutcomeScanCount,
  recordedOutcomesOf,
} from "./recorded-outcomes";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

/** A line well past the scan's fingerprint, so an append leaves the file's head unchanged. */
const PADDING = JSON.stringify({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "x".repeat(6000) }] },
});

const directories: string[] = [];

beforeEach(() => {
  clearRecordedOutcomeScans();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeDirectory(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const directory = await mkdtemp(path.join(WORKTREE_DATA, "recorded-outcomes-"));
  directories.push(directory);
  return directory;
}

/** A parent session file holding the lines, each ended by a newline. */
async function sessionFile(lines: readonly string[]): Promise<string> {
  const file = path.join(await makeDirectory(), "parent.jsonl");
  await writeFile(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

function asyncResult(id: string, status: string): string {
  return JSON.stringify({
    type: "custom_message",
    customType: "async-result",
    content: `<system-notice>finished</system-notice>\n<task-result id="${id}" agent="task" status="${status}">\ndone\n</task-result>`,
  });
}

function taskResult(id: string, status: string): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "task",
      content: [
        { type: "text", text: `<task-result id="${id}" status="${status}">out</task-result>` },
      ],
    },
  });
}

function asObject(outcomes: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(outcomes);
}

describe("recordedOutcomesOf", () => {
  test("records each worker's outcome from its async result or task result, and the last record wins", async () => {
    const file = await sessionFile([
      asyncResult("A", "completed"),
      taskResult("B", "failed"),
      asyncResult("A", "aborted"),
      asyncResult("C", "running"),
    ]);
    expect(asObject(await recordedOutcomesOf(file))).toEqual({ A: "aborted", B: "failed" });
  });

  test("a result tag that a read boundary splits is found, whatever the read size", async () => {
    const file = await sessionFile([asyncResult("S", "completed"), taskResult("T", "aborted")]);
    for (const chunkBytes of [1, 2, 5, 11, 12, 13, 64]) {
      clearRecordedOutcomeScans();
      expect(asObject(await recordedOutcomesOf(file, { chunkBytes }))).toEqual({
        S: "completed",
        T: "aborted",
      });
    }
  });

  test("a long record whose tag comes at its end is parsed whole, and no read is larger than a chunk", async () => {
    const long = JSON.stringify({
      type: "custom_message",
      customType: "async-result",
      content: `${"y".repeat(5000)}\n<task-result id="L" status="failed">z</task-result>`,
    });
    const file = await sessionFile([long]);
    const reads: number[] = [];
    const outcomes = await recordedOutcomesOf(file, {
      chunkBytes: 256,
      onRead: (bytes) => reads.push(bytes),
    });
    expect(asObject(outcomes)).toEqual({ L: "failed" });
    expect(Math.max(...reads)).toBeLessThanOrEqual(256);
  });

  test("text that only quotes a result tag records nothing", async () => {
    const file = await sessionFile([
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '<task-result id="Q" status="completed">' }],
        },
      }),
    ]);
    expect((await recordedOutcomesOf(file)).size).toBe(0);
  });

  test("a partial last line waits for its newline", async () => {
    const later = asyncResult("B", "failed");
    const cut = Math.floor(later.length / 2);
    const file = await sessionFile([PADDING, asyncResult("A", "completed")]);
    await appendFile(file, later.slice(0, cut));
    expect(asObject(await recordedOutcomesOf(file))).toEqual({ A: "completed" });
    await appendFile(file, `${later.slice(cut)}\n`);
    expect(asObject(await recordedOutcomesOf(file))).toEqual({ A: "completed", B: "failed" });
  });

  test("a file that grew is read only from the offset its last scan reached", async () => {
    const file = await sessionFile([PADDING, asyncResult("A", "completed")]);
    await recordedOutcomesOf(file);
    const appended = `${asyncResult("B", "failed")}\n`;
    await appendFile(file, appended);
    const reads: number[] = [];
    const outcomes = await recordedOutcomesOf(file, { onRead: (bytes) => reads.push(bytes) });
    expect(asObject(outcomes)).toEqual({ A: "completed", B: "failed" });
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(Buffer.byteLength(appended));
  });

  test("a file replaced under the same path is read from its start", async () => {
    const file = await sessionFile([PADDING, asyncResult("A", "completed")]);
    await recordedOutcomesOf(file);
    const replacement = `${file}.next`;
    await writeFile(replacement, `${PADDING}\n${asyncResult("A", "failed")}\n`);
    await rename(replacement, file);
    expect(asObject(await recordedOutcomesOf(file))).toEqual({ A: "failed" });
  });

  test("a file rewritten shorter in place is read from its start", async () => {
    const file = await sessionFile([
      PADDING,
      asyncResult("A", "completed"),
      taskResult("B", "failed"),
    ]);
    await recordedOutcomesOf(file);
    await writeFile(file, `${PADDING}\n${asyncResult("A", "aborted")}\n`);
    expect(asObject(await recordedOutcomesOf(file))).toEqual({ A: "aborted" });
  });

  test("a missing file records nothing", async () => {
    const file = path.join(await makeDirectory(), "absent.jsonl");
    expect((await recordedOutcomesOf(file)).size).toBe(0);
  });

  test("the scan keeps an offset for at most 32 files", async () => {
    for (let index = 0; index < 40; index += 1) {
      await recordedOutcomesOf(await sessionFile([asyncResult(`W${index}`, "completed")]));
    }
    expect(recordedOutcomeScanCount()).toBeLessThanOrEqual(32);
  });
});
