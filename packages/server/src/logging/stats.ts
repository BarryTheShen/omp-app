import { readFileSync } from "node:fs";
import { freemem, loadavg } from "node:os";
import type { Logger } from "./logger";

export interface SampledProcess {
  readonly pid: number | undefined;
  readonly status: string;
}

export interface StatsSampler {
  /** Writes one `stats` line now (the interval does it every `intervalMs`). */
  sample(): void;
  stop(): void;
}

export interface StatsOptions {
  readonly logger: Logger;
  /** The omp processes the server has, from the process registry. */
  readonly processes: () => readonly SampledProcess[];
  readonly intervalMs?: number;
  /** For tests: a process's resident memory in kB, or undefined when unknown. */
  readonly readRssKb?: (pid: number) => number | undefined;
}

/** The loop is probed this often; its largest delay since the last line is what the line reports. */
const PROBE_MS = 250;

function readLinuxRssKb(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
}

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

/**
 * Every `intervalMs` (30 s by default) writes the server's memory, the number and memory of its omp
 * processes, and how long the event loop was blocked at worst: a freeze like the one in #665 then
 * leaves numbers behind. The event loop is probed with a short timer, so a stall of the whole
 * server shows up as a late timer.
 */
export function startStatsSampler(options: StatsOptions): StatsSampler {
  const readRss = options.readRssKb ?? readLinuxRssKb;
  const startedAt = Date.now();
  let lastProbe = Date.now();
  let worstLagMs = 0;
  const probe = setInterval(() => {
    const now = Date.now();
    worstLagMs = Math.max(worstLagMs, now - lastProbe - PROBE_MS);
    lastProbe = now;
  }, PROBE_MS);
  probe.unref();

  const sample = (): void => {
    const memory = process.memoryUsage();
    const processes = options.processes();
    const rss = processes.map((entry) =>
      entry.pid === undefined ? undefined : readRss(entry.pid),
    );
    const known = rss.filter((value): value is number => value !== undefined);
    options.logger.info("stats", {
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      rss_mb: mb(memory.rss),
      heap_mb: mb(memory.heapUsed),
      external_mb: mb(memory.external),
      free_mb: mb(freemem()),
      load1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
      loop_lag_ms: Math.max(0, Math.round(worstLagMs)),
      omp_count: processes.length,
      omp_rss_mb: mb(known.reduce((sum, kb) => sum + kb, 0) * 1024),
      omp_max_mb: mb(Math.max(0, ...known) * 1024),
      omp_pids: processes.flatMap((entry) => (entry.pid === undefined ? [] : [entry.pid])),
    });
    worstLagMs = 0;
  };
  const timer = setInterval(sample, options.intervalMs ?? 30_000);
  timer.unref();
  return {
    sample,
    stop() {
      clearInterval(timer);
      clearInterval(probe);
    },
  };
}
