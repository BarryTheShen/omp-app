import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "./store";
import type { Sample, SampleInput } from "./summary-cache-memory.sample";

const WORKTREE = path.resolve(import.meta.dir, "../../../../../../");
const WORKTREE_DATA = path.join(WORKTREE, ".data");
/**
 * Where the measurements go. `apps/web/test-results` is git-ignored and is one of the folders a the test machine job returns, so the
 * numbers reach the main agent even though the package test run prints only its counts.
 */
const RESULT_FILE = path.join(WORKTREE, "apps", "web", "test-results", "summary-cache-memory.json");
const SAMPLE_SCRIPT = path.join(import.meta.dir, "summary-cache-memory.sample.ts");
/** The summary cache's file in the app data folder (the name `summary-cache.ts` gives it; the baseline has no such module). */
const CACHE_FILE = "session-summaries.json";
const MiB = 1024 * 1024;
const CHATS = 30;
const SAMPLES = 5;
const TOOL_RESULTS = 4;
const TOOL_RESULT_BYTES = 7 * MiB;
const SMALL_MESSAGES = 20;
const SMALL_MESSAGE_BYTES = 64 * 1024;
const RSS_BUDGET_MIB = 150;

/** Writes one chat of about 29 MiB: a header, a prompt, four tool results of 7 MiB each and small replies. */
async function writeChat(file: string, id: string, cwd: string): Promise<number> {
  let bytes = 0;
  const put = async (chunk: string | Buffer): Promise<void> => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    await appendFile(file, buffer);
    bytes += buffer.length;
  };
  const reply = async (messageId: string, textBytes: number): Promise<void> => {
    await put(
      `{"type":"message","id":"${messageId}","timestamp":"2026-10-01T09:30:00.000Z","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"`,
    );
    await put(Buffer.alloc(textBytes, 0x61));
    await put(`"}]}}\n`);
  };
  await put(
    `{"type":"session","version":3,"id":"${id}","timestamp":"2026-10-01T09:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n`,
  );
  await put(
    `{"type":"message","id":"user-0","timestamp":"2026-10-01T09:01:00.000Z","message":{"role":"user","content":"Summarize the build"}}\n`,
  );
  for (let index = 0; index < TOOL_RESULTS; index += 1) {
    await reply(`tool-${index}`, TOOL_RESULT_BYTES);
  }
  for (let index = 0; index < SMALL_MESSAGES; index += 1) {
    await reply(`small-${index}`, SMALL_MESSAGE_BYTES);
  }
  return bytes;
}

/** One sample, in a process of its own: see `summary-cache-memory.sample.ts`. */
async function runSample(input: SampleInput): Promise<Sample> {
  const child = Bun.spawn([process.execPath, SAMPLE_SCRIPT, JSON.stringify(input)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`The memory sample exited with ${code}: ${stderr.slice(-2000)}`);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Sample;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

test("the first page of 30 chats, about 880 MiB, adds at most 150 MiB of memory, and a restart reads no chat", async () => {
  await mkdir(WORKTREE_DATA, { recursive: true });
  const root = await mkdtemp(path.join(WORKTREE_DATA, "summary-cache-memory-"));
  try {
    const home = path.join(root, "home");
    const sessionsRoot = path.join(root, "sessions");
    const tempRoot = path.join(root, "tmp");
    const appDataDir = path.join(root, "app");
    const cwd = path.join(home, "project");
    const bucket = new SessionFileStore({ sessionsRoot, home, tempRoot, appDataDir }).bucketPath(
      cwd,
    );
    await mkdir(bucket, { recursive: true });
    let totalBytes = 0;
    for (let index = 0; index < CHATS; index += 1) {
      const name = `2026-10-01_chat-${String(index).padStart(2, "0")}.jsonl`;
      totalBytes += await writeChat(path.join(bucket, name), `chat-${index}`, cwd);
    }

    const input: SampleInput = { sessionsRoot, home, tempRoot, appDataDir, cwd, chats: CHATS };
    const samples: Sample[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      // Each sample starts cold: no cache file, so every chat is read.
      await rm(path.join(appDataDir, CACHE_FILE), { force: true });
      samples.push(await runSample(input));
    }

    const result = {
      chats: CHATS,
      samples: SAMPLES,
      totalMiB: Math.round(totalBytes / MiB),
      rssBudgetMiB: RSS_BUDGET_MIB,
      medians: {
        coldFirstPageMs: median(samples.map((sample) => sample.cold.firstPageMs)),
        coldRssDeltaMiB: median(samples.map((sample) => sample.cold.rssDeltaMiB)),
        warmFirstPageMs: median(samples.map((sample) => sample.warm.firstPageMs)),
        warmRssDeltaMiB: median(samples.map((sample) => sample.warm.rssDeltaMiB)),
        warmFilesRead: median(samples.map((sample) => sample.warm.filesRead)),
      },
      samplesDetail: samples,
    };
    await mkdir(path.dirname(RESULT_FILE), { recursive: true });
    await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);

    // Each cold sample is its own process, and one process's resident memory varies by about a sixth on the same code, so the
    // bound is on the median of the samples. Every sample's own numbers are in the result file.
    expect(median(samples.map((sample) => sample.cold.rssDeltaMiB))).toBeLessThanOrEqual(
      RSS_BUDGET_MIB,
    );
    for (const sample of samples) {
      expect(sample.cold.chats).toBe(CHATS);
      expect(sample.cold.filesRead).toBeGreaterThan(0);
      expect(sample.warm.chats).toBe(CHATS);
      expect(sample.warm.filesRead).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 1_200_000);
