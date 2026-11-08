import type { UsageLimitProvider, UsageLimitsResult } from "@omp-app/contracts";
import { z } from "zod";

/** How long one `omp usage` read is current; after that a page's read starts a fresh one. */
export const USAGE_LIMITS_CACHE_MS = 60_000;
/**
 * How old a read may be and still answer a page at once while a fresh one is read behind it: twice the watch's pace, so
 * a page waits on omp (0.8 s typically) only when the server has no recent read.
 */
export const USAGE_LIMITS_STALE_MS = 10 * 60_000;
/** The longest one `omp usage` read may take; past it the popover says omp did not answer in time. */
export const USAGE_LIMITS_TIMEOUT_MS = 45_000;
/** How often the server reads the limits by itself (#2781), so every page follows them without asking. */
export const USAGE_LIMITS_WATCH_MS = 5 * 60_000;
/** How often once a window is near its limit. */
export const USAGE_LIMITS_NEAR_WATCH_MS = 60_000;
/** A window this full, in percent, or fuller is near its limit. */
export const USAGE_LIMITS_NEAR_PERCENT = 85;

export interface UsageLimitStoreOptions {
  /** omp's command line (`ompCommand()`: the program and its leading arguments), or a test's stand-in. */
  readonly command: readonly string[];
  /** Environment for omp, so it finds the same signed-in accounts the chats use. Defaults to this process's. */
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly cacheMs?: number;
  /** How old a read may be and still answer at once (`USAGE_LIMITS_STALE_MS` unless a test sets it). */
  readonly staleMs?: number;
  readonly now?: () => number;
  /** The watch's pace, `USAGE_LIMITS_WATCH_MS` and `USAGE_LIMITS_NEAR_WATCH_MS` unless a test sets them. */
  readonly watchMs?: number;
  readonly nearWatchMs?: number;
}

/** Whether any window of the result is near its limit (`USAGE_LIMITS_NEAR_PERCENT`). */
export function nearLimit(result: UsageLimitsResult): boolean {
  return (
    result.state === "ready" &&
    result.providers.some((provider) =>
      provider.windows.some((window) => window.usedPercent >= USAGE_LIMITS_NEAR_PERCENT),
    )
  );
}

type OmpRun =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "failed"; readonly reason: string };

// Only the fields the popover shows are read; every other field (account emails, ids, raw payloads) is ignored.
const AmountInput = z.looseObject({
  usedFraction: z.number().optional(),
  used: z.number().optional(),
  limit: z.number().optional(),
});
const WindowInput = z.looseObject({
  id: z.string().optional(),
  label: z.string().min(1),
  durationMs: z.number().optional(),
  resetsAt: z.number().optional(),
});
const LimitInput = z.looseObject({
  window: WindowInput.optional(),
  amount: AmountInput.optional(),
});
const ReportInput = z.looseObject({
  provider: z.string().min(1),
  limits: z.array(z.unknown()).optional(),
});
const UsageInput = z.looseObject({
  reports: z.array(z.unknown()),
});

interface WindowSummary {
  usedPercent: number;
  resetsAt: number | undefined;
  durationMs: number | undefined;
  accounts: number;
}

/** omp's stable window ids that say their length ("5h", "7d"); "monthly" and the like do not. */
const WINDOW_ID_LENGTH = /^(\d+)([hd])$/;

/** A window's length: omp's `durationMs` when it gives one, else what its stable id says (pi-ai `UsageWindow`). */
function durationOf(window: z.infer<typeof WindowInput>): number | undefined {
  if (window.durationMs !== undefined && window.durationMs > 0)
    return Math.round(window.durationMs);
  const parsed = WINDOW_ID_LENGTH.exec(window.id ?? "");
  if (parsed === null) return undefined;
  return Number(parsed[1]) * (parsed[2] === "h" ? 3_600_000 : 86_400_000);
}

/**
 * The share of a limit that is used, as omp resolves it (pi-ai `resolveUsedFraction`, src/usage.ts:126-131): the
 * reported fraction, or used over limit when both are known.
 */
function usedFractionOf(amount: z.infer<typeof AmountInput> | undefined): number | undefined {
  if (amount === undefined) return undefined;
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  return undefined;
}

/**
 * Per provider and window, the fullest account's share and its reset time, plus how many accounts report the
 * window. Accounts are counted, never named.
 */
function summarize(reports: readonly unknown[]): UsageLimitProvider[] {
  const byProvider = new Map<string, Map<string, WindowSummary>>();
  for (const raw of reports) {
    const report = ReportInput.safeParse(raw);
    if (!report.success) continue;
    const windows = byProvider.get(report.data.provider) ?? new Map<string, WindowSummary>();
    byProvider.set(report.data.provider, windows);
    const countedInReport = new Set<string>();
    for (const rawLimit of report.data.limits ?? []) {
      const limit = LimitInput.safeParse(rawLimit);
      if (!limit.success || limit.data.window === undefined) continue;
      const fraction = usedFractionOf(limit.data.amount);
      if (fraction === undefined) continue;
      const { label, resetsAt } = limit.data.window;
      const durationMs = durationOf(limit.data.window);
      const usedPercent = fraction * 100;
      const current = windows.get(label);
      if (current === undefined) {
        windows.set(label, { usedPercent, resetsAt, durationMs, accounts: 1 });
        countedInReport.add(label);
        continue;
      }
      if (!countedInReport.has(label)) {
        countedInReport.add(label);
        current.accounts += 1;
      }
      if (usedPercent > current.usedPercent) {
        current.usedPercent = usedPercent;
        current.resetsAt = resetsAt;
      }
    }
  }
  return [...byProvider]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, windows]) => ({
      providerId,
      windows: [...windows].map(([label, summary]) => ({
        label,
        usedPercent: Math.round(summary.usedPercent * 10) / 10,
        resetsAt: summary.resetsAt === undefined ? null : new Date(summary.resetsAt).toISOString(),
        accounts: summary.accounts,
        durationMs: summary.durationMs ?? null,
      })),
    }));
}

function unavailable(reason: string): UsageLimitsResult {
  return { state: "unavailable", reason };
}

function parseUsageOutput(text: string, fetchedAt: number): UsageLimitsResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return unavailable("omp's usage output could not be read.");
  }
  const usage = UsageInput.safeParse(json);
  if (!usage.success) return unavailable("omp's usage output was not in a form this app reads.");
  return {
    state: "ready",
    fetchedAt: new Date(fetchedAt).toISOString(),
    providers: summarize(usage.data.reports),
  };
}

/** Stops omp and whatever it started. A group that has already gone is not an error. */
function stopProcessGroup(child: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
}

/**
 * Runs `omp usage --json --redact` once, bounded by the deadline. Its stderr is read and never returned or logged,
 * since it can carry credentials. The process group is stopped when the read ends, however it ends.
 */
async function runOmpUsage(
  command: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<OmpRun> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([...command, "usage", "--json", "--redact"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so that omp's own children can be stopped with it.
      detached: true,
    });
  } catch {
    return {
      kind: "failed",
      reason: "omp could not be started, so provider limits were not read.",
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // omp's children can keep the output pipes open after omp exits, so the wait for the output is bounded too.
  const finished = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(
    ([exitCode, stdout]) => ({ exitCode, stdout }),
    () => undefined,
  );
  try {
    const outcome = await Promise.race([finished, deadline]);
    if (outcome === "timeout") {
      return {
        kind: "failed",
        reason: `omp did not report provider limits within ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    if (outcome === undefined) {
      return { kind: "failed", reason: "omp's usage output could not be read." };
    }
    if (outcome.exitCode !== 0) {
      return { kind: "failed", reason: `omp usage stopped with exit code ${outcome.exitCode}.` };
    }
    return { kind: "output", text: outcome.stdout };
  } finally {
    clearTimeout(timer);
    stopProcessGroup(child);
  }
}

function environmentFor(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * The provider usage limits omp reports, read with `omp usage --json --redact`. A read is current for a minute; up to
 * ten minutes old it still answers a page at once while a fresh one is read behind it, and concurrent reads share one
 * omp run. The result carries provider ids, window labels, percentages and reset times only: no account names, emails
 * or ids. Once watching, the server reads them by itself, every 5 minutes and every minute once a window is near its
 * limit, and every fresh read goes to the subscribers (#2781), so a page shown a kept read gets the fresh one too.
 */
export class UsageLimitStoreService {
  readonly #command: readonly string[];
  readonly #env: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  readonly #staleMs: number;
  readonly #now: () => number;
  readonly #watchMs: number;
  readonly #nearWatchMs: number;
  readonly #listeners = new Set<(result: UsageLimitsResult) => void>();
  #cache: { readonly at: number; readonly result: UsageLimitsResult } | undefined;
  #pending: Promise<UsageLimitsResult> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: UsageLimitStoreOptions) {
    this.#command = options.command;
    this.#env = environmentFor(options.env ?? process.env);
    this.#timeoutMs = options.timeoutMs ?? USAGE_LIMITS_TIMEOUT_MS;
    this.#cacheMs = options.cacheMs ?? USAGE_LIMITS_CACHE_MS;
    this.#staleMs = options.staleMs ?? USAGE_LIMITS_STALE_MS;
    this.#now = options.now ?? Date.now;
    this.#watchMs = options.watchMs ?? USAGE_LIMITS_WATCH_MS;
    this.#nearWatchMs = options.nearWatchMs ?? USAGE_LIMITS_NEAR_WATCH_MS;
  }

  /** The limits omp reports now, or the plain reason they could not be read. Never rejects. */
  read(): Promise<UsageLimitsResult> {
    const cache = this.#cache;
    if (cache !== undefined) {
      const age = this.#now() - cache.at;
      if (age < this.#cacheMs) return Promise.resolve(cache.result);
      // A failed read is not shown again: the page waits for the fresh one instead.
      if (age < this.#staleMs && cache.result.state === "ready") {
        void this.#fresh();
        return Promise.resolve(cache.result);
      }
    }
    return this.#fresh();
  }

  /** Each fresh read's result, whoever asked for it: a page, or the server's own watch. */
  subscribe(listener: (result: UsageLimitsResult) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Reads the limits by itself from now on, the first time one watch interval from now, until disposed. */
  watch(): void {
    if (this.#timer !== undefined || this.#disposed) return;
    this.#schedule(this.#watchMs);
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
  }

  #schedule(ms: number): void {
    const timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#fresh().then((result) => {
        if (!this.#disposed) this.#schedule(nearLimit(result) ? this.#nearWatchMs : this.#watchMs);
      });
    }, ms);
    // The watch alone keeps no process alive.
    timer.unref?.();
    this.#timer = timer;
  }

  #fresh(): Promise<UsageLimitsResult> {
    this.#pending ??= this.#load().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #load(): Promise<UsageLimitsResult> {
    const run = await runOmpUsage(this.#command, this.#env, this.#timeoutMs);
    const result =
      run.kind === "failed" ? unavailable(run.reason) : parseUsageOutput(run.text, this.#now());
    this.#cache = { at: this.#now(), result };
    if (!this.#disposed) for (const listener of this.#listeners) listener(result);
    return result;
  }
}

export function createUsageLimitStore(options: UsageLimitStoreOptions): UsageLimitStoreService {
  return new UsageLimitStoreService(options);
}
