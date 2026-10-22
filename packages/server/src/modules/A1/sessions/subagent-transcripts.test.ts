import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { collectSubagentTranscripts, SessionFileStore } from "./index";
import { SUBAGENT_ENTRY_MAX_BYTES, SUBAGENT_PAGE_BYTES } from "./subagent-read";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const AT = "2026-10-04T12:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly sessionsRoot: string;
  readonly bucket: string;
  readonly chat: string;
}

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function header(id: string): Record<string, unknown> {
  return { type: "session", version: 3, id, timestamp: AT, cwd: "/workspace" };
}

function init(agent: string): Record<string, unknown> {
  return { type: "session_init", id: "init", parentId: null, timestamp: AT, agent };
}

function assistant(stopReason: string): Record<string, unknown> {
  return {
    type: "message",
    id: `assistant-${stopReason}`,
    parentId: null,
    timestamp: AT,
    message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason },
  };
}

function yieldResult(status: string, isError: boolean): Record<string, unknown> {
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
      isError,
    },
  };
}

function sessionExit(): Record<string, unknown> {
  return {
    type: "custom",
    id: "exit",
    parentId: null,
    timestamp: AT,
    customType: "session_exit",
    data: { reason: "dispose", kind: "normal", recordedAt: AT },
  };
}

async function makeFixture(): Promise<Fixture> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const root = await mkdtemp(path.join(WORKTREE_DATA, "subagent-transcripts-"));
  const sessionsRoot = path.join(root, "sessions");
  const bucket = path.join(sessionsRoot, "-workspace");
  const chat = path.join(bucket, "main.jsonl");
  await mkdir(bucket, { recursive: true });
  await writeFile(chat, `${line(header("main"))}\n`, "utf8");
  return { root, sessionsRoot, bucket, chat };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await makeFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function workerDir(fixture: Fixture): string {
  return path.join(fixture.bucket, "main");
}

/** A worker transcript beside the chat, as omp writes it: a header, then its records. */
async function writeWorker(
  file: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [header("worker"), ...records].map(line);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

function storeFor(fixture: Fixture): SessionFileStore {
  return new SessionFileStore({
    sessionsRoot: fixture.sessionsRoot,
    home: fixture.root,
    tempRoot: path.join(fixture.root, "tmp"),
  });
}

async function workerNamed(fixture: Fixture, agentId: string) {
  const { subagents } = await collectSubagentTranscripts(fixture.chat);
  const found = subagents.find((worker) => worker.agentId === agentId);
  if (!found) throw new Error(`no worker named ${agentId}`);
  return found;
}

describe("a worker's final status, end time and agent come from its own records", () => {
  test("a successful yield completes the worker, and its agent type is the one omp recorded", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Done.jsonl"), [
        init("task"),
        assistant("toolUse"),
        yieldResult("success", false),
      ]);
      const worker = await workerNamed(fixture, "Done");
      expect(worker).toMatchObject({ status: "completed", agent: "task", aborted: false });
      expect(Date.parse(worker.endedAt ?? "")).toBeGreaterThan(0);
    }));

  test("a worker whose last turn ended in an error failed", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Broken.jsonl"), [
        init("task"),
        assistant("error"),
      ]);
      const worker = await workerNamed(fixture, "Broken");
      expect(worker.status).toBe("failed");
      expect(Date.parse(worker.endedAt ?? "")).toBeGreaterThan(0);
    }));

  test("a failed worker's reason is the failure its last assistant message keeps, without the saved request", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Refused.jsonl"), [
        init("task"),
        {
          type: "message",
          id: "refused",
          parentId: null,
          timestamp: AT,
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage:
              "400 fake provider failure (type=invalid_request_error)\nraw-http-request=/logs/x.json",
          },
        },
      ]);
      const worker = await workerNamed(fixture, "Refused");
      expect(worker).toMatchObject({
        status: "failed",
        reason: "400 fake provider failure (type=invalid_request_error)",
      });
    }));

  test("a cancelled worker, with its tombstone, is aborted", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Cancelled.jsonl"), [
        init("task"),
        assistant("toolUse"),
      ]);
      await writeFile(path.join(workerDir(fixture), "Cancelled.jsonl.tombstone"), "", "utf8");
      const worker = await workerNamed(fixture, "Cancelled");
      expect(worker).toMatchObject({ status: "aborted", aborted: true });
      expect(Date.parse(worker.endedAt ?? "")).toBeGreaterThan(0);
    }));

  test("a worker whose last turn was aborted is aborted, even without a tombstone", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Stopped.jsonl"), [
        init("task"),
        assistant("aborted"),
      ]);
      const worker = await workerNamed(fixture, "Stopped");
      expect(worker).toMatchObject({ status: "aborted", aborted: false });
    }));

  test("a worker that records no end is unknown, with no end time", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Running.jsonl"), [
        init("task"),
        assistant("toolUse"),
      ]);
      const worker = await workerNamed(fixture, "Running");
      expect(worker).toMatchObject({ status: "unknown", endedAt: null, agent: "task" });
    }));

  test("a worker that records no end is stopped once no live omp holds its own session", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Orphan.jsonl"), [
        init("task"),
        assistant("toolUse"),
      ]);
      const store = new SessionFileStore({
        sessionsRoot: fixture.sessionsRoot,
        home: fixture.root,
        tempRoot: path.join(fixture.root, "tmp"),
        leaseProbe: () => "inactive",
      });
      const { transcripts } = await store.listSubagents(fixture.chat);
      expect(transcripts.find((worker) => worker.agentId === "Orphan")).toMatchObject({
        status: "stopped",
        agent: "task",
      });
      expect(transcripts.find((worker) => worker.agentId === "Orphan")?.endedAt).not.toBeNull();
    }));

  test("a worker that records no end stays unknown while a live omp holds its own session", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Held.jsonl"), [
        init("task"),
        assistant("toolUse"),
      ]);
      const store = new SessionFileStore({
        sessionsRoot: fixture.sessionsRoot,
        home: fixture.root,
        tempRoot: path.join(fixture.root, "tmp"),
        leaseProbe: () => "active",
      });
      const { transcripts } = await store.listSubagents(fixture.chat);
      expect(transcripts.find((worker) => worker.agentId === "Held")).toMatchObject({
        status: "unknown",
        endedAt: null,
      });
    }));

  test("a worker that stopped without a yield, and whose session omp disposed last, is stopped", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Quiet.jsonl"), [
        init("task"),
        assistant("stop"),
        sessionExit(),
      ]);
      const worker = await workerNamed(fixture, "Quiet");
      expect(worker).toMatchObject({ status: "stopped", aborted: false, agent: "task" });
      expect(Date.parse(worker.endedAt ?? "")).toBeGreaterThan(0);
    }));

  test("a worker that got a new prompt after its session was disposed may still run, so it is unknown", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Resumed.jsonl"), [
        init("task"),
        assistant("stop"),
        sessionExit(),
        {
          type: "message",
          id: "later",
          parentId: null,
          timestamp: AT,
          message: { role: "user", content: [{ type: "text", text: "again" }] },
        },
      ]);
      const worker = await workerNamed(fixture, "Resumed");
      expect(worker).toMatchObject({ status: "unknown", endedAt: null });
    }));

  test("a worker resumed after its session was disposed, whose new turn ended with a plain stop, is stopped", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Resumed-stopped.jsonl"), [
        init("task"),
        assistant("stop"),
        sessionExit(),
        {
          type: "message",
          id: "later",
          parentId: null,
          timestamp: AT,
          message: { role: "user", content: [{ type: "text", text: "again" }] },
        },
        assistant("stop"),
      ]);
      const worker = await workerNamed(fixture, "Resumed-stopped");
      expect(worker).toMatchObject({ status: "stopped" });
    }));

  test("a worker whose last turn ended with a plain stop, with its session still open, is stopped", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Idle.jsonl"), [
        init("task"),
        assistant("stop"),
      ]);
      const worker = await workerNamed(fixture, "Idle");
      expect(worker).toMatchObject({ status: "stopped", agent: "task" });
      expect(Date.parse(worker.endedAt ?? "")).toBeGreaterThan(0);
    }));

  test("a yield that failed does not complete the worker", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Refused.jsonl"), [
        assistant("stop"),
        yieldResult("invalid", true),
      ]);
      const worker = await workerNamed(fixture, "Refused");
      expect(worker.status).toBe("unknown");
    }));

  test("a worker whose file records no agent type has a null agent", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Anonymous.jsonl"), [assistant("error")]);
      const worker = await workerNamed(fixture, "Anonymous");
      expect(worker).toMatchObject({ status: "failed", agent: null });
    }));

  test("the listing reports each worker's status and agent to the port", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Done.jsonl"), [
        init("task"),
        yieldResult("success", false),
      ]);
      await writeWorker(path.join(workerDir(fixture), "Running.jsonl"), [init("task")]);
      const listed = await storeFor(fixture).listSubagents(fixture.chat);
      expect(listed.transcripts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentId: "Done", status: "completed", agent: "task" }),
          expect.objectContaining({ agentId: "Running", status: "unknown", endedAt: null }),
        ]),
      );
    }));
});

describe("reading a worker transcript from a byte cursor", () => {
  test("returns complete lines, holds a partial last line for the next page, and parses like omp", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Reader.jsonl");
      await writeWorker(file, [init("task"), assistant("stop"), yieldResult("success", false)]);
      const complete = await readFile(file, "utf8");
      const partial = '{"type":"custom","id":"late"';
      await writeFile(file, `${complete}${partial}`, "utf8");
      const store = storeFor(fixture);

      const first = await store.readSubagent({ sessionFile: file });
      expect(first).toMatchObject({ sessionFile: file, fromByte: 0, reset: false });
      expect(first.entries.map((entry) => entry.type)).toEqual([
        "session",
        "session_init",
        "message",
        "message",
      ]);
      expect(first.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
      expect(first.nextByte).toBe(Buffer.byteLength(complete));

      await writeFile(file, `${complete}${partial}}\n`, "utf8");
      const second = await store.readSubagent({ sessionFile: file, fromByte: first.nextByte });
      expect(second.entries).toEqual([{ type: "custom", id: "late" }]);
      expect(second.nextByte).toBe(Buffer.byteLength(`${complete}${partial}}\n`));
    }));

  test("a cursor past the end starts again from 0, and says so", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Reset.jsonl");
      await writeWorker(file, [init("task")]);
      const size = (await stat(file)).size;
      const page = await storeFor(fixture).readSubagent({ sessionFile: file, fromByte: size + 10 });
      expect(page).toMatchObject({ fromByte: 0, nextByte: size, reset: true });
      expect(page.entries).toHaveLength(2);
    }));

  test("a malformed complete line is skipped, and the page still moves past it", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Torn.jsonl");
      await mkdir(workerDir(fixture), { recursive: true });
      const text = `${line(header("worker"))}\nnot json at all\n${line(init("task"))}\n`;
      await writeFile(file, text, "utf8");
      const page = await storeFor(fixture).readSubagent({ sessionFile: file });
      expect(page.entries.map((entry) => entry.type)).toEqual(["session", "session_init"]);
      expect(page.nextByte).toBe(Buffer.byteLength(text));
    }));

  test("a page holds at most a page of bytes, cut at a complete line, and the next page continues there", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Long.jsonl");
      await mkdir(workerDir(fixture), { recursive: true });
      const records = Array.from({ length: 200 }, (_, index) =>
        line({
          type: "custom",
          id: `record-${index}`,
          parentId: null,
          timestamp: AT,
          customType: "filler",
          data: { text: "x".repeat(64 * 1024) },
        }),
      );
      await writeFile(file, `${records.join("\n")}\n`, "utf8");
      const store = storeFor(fixture);
      const seen: string[] = [];
      let cursor = 0;
      let pages = 0;
      while (pages < 100) {
        const page = await store.readSubagent({ sessionFile: file, fromByte: cursor });
        pages += 1;
        expect(page.nextByte - page.fromByte).toBeLessThanOrEqual(SUBAGENT_PAGE_BYTES);
        seen.push(...page.entries.map((entry) => String(entry.id)));
        if (page.nextByte === cursor) break;
        cursor = page.nextByte;
      }
      expect(pages).toBeGreaterThan(3);
      expect(seen).toEqual(records.map((_, index) => `record-${index}`));
    }));

  test("an entry larger than a page comes back whole and alone, and the lines after it come next", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Big.jsonl");
      await mkdir(workerDir(fixture), { recursive: true });
      const big = line({
        type: "custom",
        id: "big",
        parentId: null,
        timestamp: AT,
        customType: "filler",
        data: { text: "y".repeat(SUBAGENT_PAGE_BYTES + 1024) },
      });
      const after = line({
        type: "custom",
        id: "after",
        parentId: null,
        timestamp: AT,
        customType: "filler",
        data: {},
      });
      await writeFile(file, `${big}\n${after}\n`, "utf8");
      const store = storeFor(fixture);
      const first = await store.readSubagent({ sessionFile: file });
      expect(first.entries.map((entry) => entry.id)).toEqual(["big"]);
      expect(first.nextByte).toBe(Buffer.byteLength(`${big}\n`));
      const second = await store.readSubagent({ sessionFile: file, fromByte: first.nextByte });
      expect(second.entries.map((entry) => entry.id)).toEqual(["after"]);
    }));

  test("an entry larger than the entry limit is refused explicitly, and nothing past it is read", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Huge.jsonl");
      await mkdir(workerDir(fixture), { recursive: true });
      await writeFile(file, `${"z".repeat(SUBAGENT_ENTRY_MAX_BYTES + 1024)}\n`, "utf8");
      const failure = await storeFor(fixture)
        .readSubagent({ sessionFile: file })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(AppFailure);
      expect((failure as AppFailure).appError).toMatchObject({
        code: "internal",
        message: "A transcript entry is larger than 16 MiB, so it cannot be read.",
        retryable: false,
      });
    }));

  test("reading never changes the transcript or the folder beside it", () =>
    withFixture(async (fixture) => {
      const file = path.join(workerDir(fixture), "Reader.jsonl");
      await writeWorker(file, [init("task"), assistant("error")]);
      const bytesBefore = await readFile(file);
      const timeBefore = (await stat(file)).mtimeMs;
      const store = storeFor(fixture);
      await store.readSubagent({ sessionFile: file });
      await store.listSubagents(fixture.chat);
      await store.readSubagent({ sessionFile: file, fromByte: 5 });
      expect((await readFile(file)).equals(bytesBefore)).toBe(true);
      expect((await stat(file)).mtimeMs).toBe(timeBefore);
      expect(await readdir(workerDir(fixture))).toEqual(["Reader.jsonl"]);
    }));

  test("a path outside the sessions folder is refused", () =>
    withFixture(async (fixture) => {
      const outside = path.join(fixture.root, "elsewhere", "main", "Done.jsonl");
      await writeWorker(outside, [init("task")]);
      await expect(storeFor(fixture).readSubagent({ sessionFile: outside })).rejects.toMatchObject({
        appError: { code: "invalid_args" },
      });
    }));

  test("a .. segment is refused, even when the path would resolve inside the folder", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Reader.jsonl"), [init("task")]);
      const store = storeFor(fixture);
      const throughParent = `${workerDir(fixture)}/../main/Reader.jsonl`;
      const throughBucket = `${fixture.bucket}/../-workspace/main/Reader.jsonl`;
      await expect(store.readSubagent({ sessionFile: throughParent })).rejects.toMatchObject({
        appError: { code: "invalid_args" },
      });
      await expect(store.readSubagent({ sessionFile: throughBucket })).rejects.toMatchObject({
        appError: { code: "invalid_args" },
      });
    }));

  test("a chat session, an advisor and a backup are not worker transcripts", () =>
    withFixture(async (fixture) => {
      const advisor = path.join(workerDir(fixture), "__advisor.jsonl");
      const backup = path.join(workerDir(fixture), "Done.bak.jsonl");
      await writeWorker(advisor, [init("task")]);
      await writeWorker(backup, [init("task")]);
      const store = storeFor(fixture);
      for (const sessionFile of [fixture.chat, advisor, backup]) {
        await expect(store.readSubagent({ sessionFile })).rejects.toMatchObject({
          appError: { code: "invalid_args" },
        });
      }
    }));

  test("a worker whose chat session is not there is not found", () =>
    withFixture(async (fixture) => {
      const file = path.join(fixture.bucket, "ghost", "Done.jsonl");
      await writeWorker(file, [init("task")]);
      await expect(storeFor(fixture).readSubagent({ sessionFile: file })).rejects.toMatchObject({
        appError: { code: "not_found" },
      });
    }));

  test("a symlink is never read as a worker transcript, and the listing skips it", () =>
    withFixture(async (fixture) => {
      const real = path.join(workerDir(fixture), "Real.jsonl");
      await writeWorker(real, [init("task")]);
      const link = path.join(workerDir(fixture), "Link.jsonl");
      await symlink(real, link);
      await expect(storeFor(fixture).readSubagent({ sessionFile: link })).rejects.toMatchObject({
        appError: { code: "not_found" },
      });
      const { subagents } = await collectSubagentTranscripts(fixture.chat);
      expect(subagents.map((worker) => worker.agentId)).toEqual(["Real"]);
    }));
});

describe("a worker's recorded outcome comes from the task result its parent records", () => {
  /** An async result the parent records for a worker, as omp writes it when the background job settles. */
  function asyncResult(agentId: string, status: string): Record<string, unknown> {
    return {
      type: "custom_message",
      id: `async-${agentId}-${status}`,
      parentId: null,
      timestamp: AT,
      customType: "async-result",
      content: `<system-notice>\nBackground job ${agentId} has completed.\n<task-result id="${agentId}" agent="task" status="${status}" duration="1ms">\n\n<output>\nDone.\n</output>\n</task-result>\n</system-notice>`,
    };
  }

  async function writeChat(
    fixture: Fixture,
    records: readonly Record<string, unknown>[],
  ): Promise<void> {
    await writeFile(fixture.chat, `${[header("main"), ...records].map(line).join("\n")}\n`, "utf8");
  }

  test("a worker that ends in plain text takes the completed status the parent records for it", () =>
    withFixture(async (fixture) => {
      await writeChat(fixture, [asyncResult("Done", "completed")]);
      await writeWorker(path.join(workerDir(fixture), "Done.jsonl"), [assistant("stop")]);
      const worker = await workerNamed(fixture, "Done");
      expect(worker).toMatchObject({ status: "stopped", recordedStatus: "completed" });
      expect(worker.endedAt).not.toBeNull();
    }));

  test("the last record the parent makes for a worker is the one that counts", () =>
    withFixture(async (fixture) => {
      await writeChat(fixture, [asyncResult("Done", "failed"), asyncResult("Done", "completed")]);
      await writeWorker(path.join(workerDir(fixture), "Done.jsonl"), [assistant("stop")]);
      expect((await workerNamed(fixture, "Done")).recordedStatus).toBe("completed");
    }));

  test("a worker the parent records as aborted keeps that outcome", () =>
    withFixture(async (fixture) => {
      await writeChat(fixture, [asyncResult("Cut", "aborted")]);
      await writeWorker(path.join(workerDir(fixture), "Cut.jsonl"), [assistant("stop")]);
      expect((await workerNamed(fixture, "Cut")).recordedStatus).toBe("aborted");
    }));

  test("a worker the parent records nothing about has no recorded status, and keeps its transcript's own", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Quiet.jsonl"), [assistant("stop")]);
      const worker = await workerNamed(fixture, "Quiet");
      expect(worker.recordedStatus).toBeUndefined();
      expect(worker.status).toBe("stopped");
    }));

  test("a nested worker's outcome is recorded by its parent worker's own file", () =>
    withFixture(async (fixture) => {
      await writeWorker(path.join(workerDir(fixture), "Outer.jsonl"), [
        asyncResult("Inner", "completed"),
      ]);
      await writeWorker(path.join(workerDir(fixture), "Outer", "Inner.jsonl"), [assistant("stop")]);
      const inner = await workerNamed(fixture, "Inner");
      expect(inner).toMatchObject({ status: "stopped", recordedStatus: "completed" });
    }));
});
