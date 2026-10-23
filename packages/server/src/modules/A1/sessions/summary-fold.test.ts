import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, open, rm, stat, truncate, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { summarizeSessionFile } from "./summary";
import { type ResumeState, readSummary, type SummaryRead } from "./summary-resume";

/*
 * The differential test of the resumable summary (SU1): a chat read from its resume state must summarize exactly as the same
 * chat read whole, after each kind of change omp makes to a chat, and after the state has been through JSON.
 */

const DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(path.join(DATA, "summary-fold-"));
  roots.push(root);
  return path.join(root, "chat.jsonl");
}

/** A deterministic random source, so that a failing sequence fails the same way on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const at = (minute: number): string =>
  `2026-10-01T10:${String(minute % 60).padStart(2, "0")}:00.000Z`;
const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A title slot padded to the 256 bytes omp writes: the first line of a chat that has one. */
function titleSlot(title: string): string {
  const line = JSON.stringify({
    type: "title",
    v: 1,
    title,
    source: "user",
    updatedAt: at(0),
    pad: "",
  });
  return `${line}${" ".repeat(256 - Buffer.byteLength(line) - 1)}\n`;
}

const header = (): string =>
  jsonLine({ type: "session", version: 3, id: "chat-1", timestamp: at(0), cwd: "/work/project" });

/**
 * One record, chosen at random from the kinds a summary reads differently: messages of each role and stop reason, the branch
 * entries omp writes (`branch_summary`, `compaction`, `model_change`), other records, and lines that are not JSON. Records
 * stay small: each check reads the whole chat once.
 */
function recordAt(index: number, next: () => number): string {
  const stamp = at(index);
  const parentId = index > 0 ? `r${index - 1}` : null;
  const id = `r${index}`;
  switch (Math.floor(next() * 11)) {
    case 0:
      return jsonLine({
        type: "message",
        id,
        parentId,
        timestamp: stamp,
        message: { role: "user", content: `Question ${index}: café ☕ 日本` },
      });
    case 1:
      return jsonLine({
        type: "message",
        id,
        parentId,
        timestamp: stamp,
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: `Answer ${index}` }],
        },
      });
    case 2:
      return jsonLine({
        type: "message",
        id,
        parentId,
        timestamp: stamp,
        message: {
          role: "assistant",
          stopReason: "length",
          content: [{ type: "toolCall", id: "c", name: "bash" }],
        },
      });
    case 3:
      return jsonLine({
        type: "message",
        id,
        parentId,
        timestamp: stamp,
        message: { role: "toolResult", content: [{ type: "text", text: "output" }] },
      });
    case 4:
      return jsonLine({
        type: "branch_summary",
        id,
        parentId,
        timestamp: stamp,
        summary: "branch",
      });
    case 5:
      return jsonLine({ type: "compaction", id, parentId, timestamp: stamp, summary: "compacted" });
    case 6:
      return jsonLine({
        type: "model_change",
        id,
        parentId,
        timestamp: stamp,
        model: "fake/model",
      });
    case 7:
      return jsonLine({ type: "custom", id, timestamp: stamp, kind: "note" });
    case 8:
      return "{not json at all\n";
    case 9:
      return `${JSON.stringify({
        type: "message",
        id,
        timestamp: stamp,
        message: { role: "user", content: "crlf line" },
      })}\r\n`;
    default:
      return jsonLine({
        type: "message",
        id,
        timestamp: stamp,
        message: { role: "user", content: "x".repeat(1024) },
      });
  }
}

/** Appends `count` complete records to the chat, the first numbered `from`. Returns the next number. */
async function appendRecords(
  file: string,
  from: number,
  count: number,
  next: () => number,
): Promise<number> {
  let text = "";
  for (let index = from; index < from + count; index += 1) text += recordAt(index, next);
  await appendFile(file, text, "utf8");
  return from + count;
}

/** The chat read whole and read from `prior`: the two summaries must be equal. */
async function expectAgrees(file: string, prior?: ResumeState): Promise<SummaryRead> {
  const { size } = await stat(file);
  const read = await readSummary(file, size, prior);
  expect(read.summary).toEqual(await summarizeSessionFile(file));
  return read;
}

/** Overwrites the title slot at offset 0 in place, the way omp renames a chat. */
async function rewriteTitleSlot(file: string, title: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.write(Buffer.from(titleSlot(title), "utf8"), 0, 256, 0);
  } finally {
    await handle.close();
  }
}

describe("resumable summary", () => {
  test("appends of complete records resume from the last state and agree with a whole read", async () => {
    const file = await tempFile();
    const next = random(7);
    await writeFile(file, titleSlot("First") + header(), "utf8");
    let index = await appendRecords(file, 0, 30, next);
    let read = await expectAgrees(file);
    expect(read.resume).toBeDefined();
    for (let round = 0; round < 4; round += 1) {
      index = await appendRecords(file, index, 25, next);
      const resumed = await expectAgrees(file, read.resume);
      expect(resumed.resumed).toBe(true);
      read = resumed;
    }
  });

  test("a partial last record is left for the next change, and the summary still counts what is there", async () => {
    const file = await tempFile();
    const next = random(11);
    await writeFile(file, titleSlot("Partial") + header(), "utf8");
    const index = await appendRecords(file, 0, 10, next);
    const whole = await expectAgrees(file);
    const record = jsonLine({
      type: "message",
      id: "late",
      timestamp: at(50),
      message: { role: "user", content: "still typing" },
    });
    await appendFile(file, record.slice(0, 40), "utf8");
    const midWrite = await expectAgrees(file, whole.resume);
    expect(midWrite.resumed).toBe(true);
    expect(midWrite.resume?.offset).toBe(whole.resume?.offset);
    await appendFile(file, record.slice(40), "utf8");
    const completed = await expectAgrees(file, midWrite.resume);
    expect(completed.resumed).toBe(true);
    await appendRecords(file, index, 3, next);
    expect((await expectAgrees(file, completed.resume)).resumed).toBe(true);
  });

  test("a title rewritten in place is read whole, so the new title shows", async () => {
    const file = await tempFile();
    const next = random(13);
    await writeFile(file, titleSlot("Before") + header(), "utf8");
    await appendRecords(file, 0, 12, next);
    const before = await expectAgrees(file);
    await rewriteTitleSlot(file, "After the rename");
    const after = await expectAgrees(file, before.resume);
    expect(after.resumed).toBe(false);
    expect(after.summary.header?.title).toBe("After the rename");
  });

  test("a truncation is read whole, and a later growth past the cut resumes from the cut", async () => {
    const file = await tempFile();
    const next = random(17);
    await writeFile(file, titleSlot("Cut") + header(), "utf8");
    await appendRecords(file, 0, 40, next);
    const full = await expectAgrees(file);
    const { size } = await stat(file);
    await truncate(file, Math.floor(size / 2));
    const cut = await expectAgrees(file, full.resume);
    expect(cut.resumed).toBe(false);
    await appendRecords(file, 100, 40, next);
    expect((await expectAgrees(file, cut.resume)).resumed).toBe(true);
  });

  test("a truncate and regrow with different bytes is caught by the tail hash, not read as an append", async () => {
    const file = await tempFile();
    const next = random(19);
    await writeFile(file, titleSlot("Regrow") + header(), "utf8");
    await appendRecords(file, 0, 600, next);
    const before = await expectAgrees(file);
    expect(before.resume?.offset).toBeGreaterThan(64 * 1024);
    const { size } = await stat(file);
    // Cut into the last complete record, then append different records past the old size.
    await truncate(file, size - 40);
    await appendFile(file, `${"z".repeat(200)}\n`, "utf8");
    const regrown = await expectAgrees(file, before.resume);
    expect(regrown.resumed).toBe(false);
  });

  test("a rollback to a complete-line boundary followed by appends still resumes correctly", async () => {
    const file = await tempFile();
    const next = random(23);
    await writeFile(file, titleSlot("Rollback") + header(), "utf8");
    const index = await appendRecords(file, 0, 20, next);
    const boundary = await expectAgrees(file);
    const half = '{"type":"message","id":"half';
    await appendFile(file, half, "utf8");
    const { size } = await stat(file);
    await truncate(file, size - half.length);
    await appendRecords(file, index, 20, next);
    expect((await expectAgrees(file, boundary.resume)).resumed).toBe(true);
  });

  test("a record longer than a read chunk is folded whole", async () => {
    const file = await tempFile();
    const next = random(31);
    await writeFile(file, titleSlot("Long") + header(), "utf8");
    const long = jsonLine({
      type: "message",
      id: "long",
      timestamp: at(1),
      message: { role: "user", content: `${"y".repeat(600 * 1024)} end` },
    });
    await appendFile(file, long, "utf8");
    const first = await expectAgrees(file);
    await appendRecords(file, 0, 5, next);
    expect((await expectAgrees(file, first.resume)).resumed).toBe(true);
  });

  test("a state whose prefix or tail hash does not match the file is not used: the file is read whole", async () => {
    const file = await tempFile();
    const next = random(37);
    await writeFile(file, titleSlot("Checked") + header(), "utf8");
    await appendRecords(file, 0, 20, next);
    const state = (await expectAgrees(file)).resume;
    if (state === undefined) throw new Error("A read of a complete chat kept no state.");
    await appendRecords(file, 20, 5, next);
    const { size } = await stat(file);
    const wrongPrefix = await readSummary(file, size, { ...state, prefixHash: "0".repeat(32) });
    expect(wrongPrefix.resumed).toBe(false);
    expect(wrongPrefix.summary).toEqual(await summarizeSessionFile(file));
    const wrongTail = await readSummary(file, size, { ...state, tailHash: "f".repeat(32) });
    expect(wrongTail.resumed).toBe(false);
    expect(wrongTail.summary).toEqual(await summarizeSessionFile(file));
    expect((await readSummary(file, size, state)).resumed).toBe(true);
  });

  test("random sequences of appends, partial writes, title rewrites and truncations always agree with a whole read", async () => {
    const file = await tempFile();
    const next = random(29);
    await writeFile(file, titleSlot("Random") + header(), "utf8");
    let index = await appendRecords(file, 0, 5, next);
    let prior: ResumeState | undefined;
    for (let step = 0; step < 60; step += 1) {
      const move = next();
      if (move < 0.5) {
        index = await appendRecords(file, index, 1 + Math.floor(next() * 12), next);
      } else if (move < 0.65) {
        await appendFile(file, '{"type":"message","id":"partial-', "utf8");
      } else if (move < 0.8) {
        await rewriteTitleSlot(file, `Title ${step}`);
      } else if (move < 0.9) {
        const { size } = await stat(file);
        await truncate(file, Math.max(256, size - Math.floor(next() * 500)));
      } else {
        index = await appendRecords(file, index, 1, next);
      }
      const read = await expectAgrees(file, prior);
      // The state is kept as JSON, as the cache keeps it: a state that survives the round trip agrees the same way.
      prior =
        read.resume === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(read.resume)) as ResumeState);
    }
  }, 120_000);
});
