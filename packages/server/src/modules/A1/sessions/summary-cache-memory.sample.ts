/*
 * One sample of the first-page memory test (`summary-cache-memory.test.ts`), run in a process of its own. A server that starts
 * fresh has the memory of a fresh process; a sample run in a process that already listed chats would reuse the memory that
 * process kept, and show less growth. Prints one JSON line: the first page of a cold start, then the first page after a
 * restart (the same folder, a new store).
 */
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { SessionFileStore } from "./store";
import type { SessionFileStoreOptions } from "./types";

export interface SampleInput {
  readonly sessionsRoot: string;
  readonly home: string;
  readonly tempRoot: string;
  readonly appDataDir: string;
  readonly cwd: string;
  readonly chats: number;
}

export interface Measurement {
  readonly firstPageMs: number;
  /** The most resident memory the listing added over the memory it started with, in MiB. */
  readonly rssDeltaMiB: number;
  readonly chats: number;
  /** The session files the listing opened to read. */
  readonly filesRead: number;
}

export interface Sample {
  readonly cold: Measurement;
  readonly warm: Measurement;
}

const MiB = 1024 * 1024;

/**
 * Times one first-page listing and samples the process's resident memory while it runs. RSS can only be read in real time, so
 * the sampler is a real interval: it measures, and nothing waits on it.
 */
async function measureFirstPage(store: SessionFileStore, input: SampleInput): Promise<Measurement> {
  Bun.gc(true);
  const before = process.memoryUsage.rss();
  let peak = before;
  const originalOpen = fs.open.bind(fs);
  const opens = spyOn(fs, "open").mockImplementation(async (...args) => originalOpen(...args));
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  const started = performance.now();
  try {
    const page = await store.listSessions({ folder: input.cwd, limit: input.chats });
    const firstPageMs = performance.now() - started;
    peak = Math.max(peak, process.memoryUsage.rss());
    return {
      firstPageMs,
      rssDeltaMiB: (peak - before) / MiB,
      chats: page.sessions.length,
      filesRead: opens.mock.calls
        .map(([file]) => String(file))
        .filter((file) => file.startsWith(input.sessionsRoot)).length,
    };
  } finally {
    clearInterval(sampler);
    opens.mockRestore();
  }
}

if (import.meta.main) {
  const input = JSON.parse(process.argv[2] ?? "") as SampleInput;
  const options: SessionFileStoreOptions = {
    sessionsRoot: input.sessionsRoot,
    home: input.home,
    tempRoot: input.tempRoot,
    appDataDir: input.appDataDir,
  };
  const first = new SessionFileStore(options);
  const cold = await measureFirstPage(first, input);
  // The baseline (main) has no summary cache to write: the optional call keeps its measurement running.
  await first.flushSummaries?.();
  const restarted = new SessionFileStore(options);
  const warm = await measureFirstPage(restarted, input);
  const sample: Sample = { cold, warm };
  process.stdout.write(`${JSON.stringify(sample)}\n`);
}
