import type { UsageLimitProvider, UsageLimitsResult } from "@omp-app/contracts";
import { z } from "zod";

/** How long one `omp usage` read is reused, so opening the usage popover does not wait on omp each time. */
export const USAGE_LIMITS_CACHE_MS = 60_000;
/** The longest one `omp usage` read may take; past it the popover says omp did not answer in time. */
export const USAGE_LIMITS_TIMEOUT_MS = 45_000;

export interface UsageLimitStoreOptions {
  /** The omp binary to run; `omp` from PATH by default. */
  readonly binary?: string;
  /** Environment for omp, so it finds the same signed-in accounts the chats use. Defaults to this process's. */
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly cacheMs?: number;
  readonly now?: () => number;
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
  label: z.string().min(1),
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
  accounts: number;
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
      const usedPercent = fraction * 100;
      const current = windows.get(label);
      if (current === undefined) {
        windows.set(label, { usedPercent, resetsAt, accounts: 1 });
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
  binary: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<OmpRun> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, "usage", "--json", "--redact"], {
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
 * The provider usage limits omp reports, read with `omp usage --json --redact`. Each read is cached for a minute and
 * concurrent reads share one omp run. The result carries provider ids, window labels, percentages and reset times
 * only: no account names, emails or ids.
 */
export class UsageLimitStoreService {
  readonly #binary: string;
  readonly #env: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  readonly #now: () => number;
  #cache: { readonly at: number; readonly result: UsageLimitsResult } | undefined;
  #pending: Promise<UsageLimitsResult> | undefined;

  constructor(options: UsageLimitStoreOptions = {}) {
    this.#binary = options.binary ?? "omp";
    this.#env = environmentFor(options.env ?? process.env);
    this.#timeoutMs = options.timeoutMs ?? USAGE_LIMITS_TIMEOUT_MS;
    this.#cacheMs = options.cacheMs ?? USAGE_LIMITS_CACHE_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The limits omp reports now, or the plain reason they could not be read. Never rejects. */
  read(): Promise<UsageLimitsResult> {
    if (this.#cache !== undefined && this.#now() - this.#cache.at < this.#cacheMs) {
      return Promise.resolve(this.#cache.result);
    }
    this.#pending ??= this.#load().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #load(): Promise<UsageLimitsResult> {
    const run = await runOmpUsage(this.#binary, this.#env, this.#timeoutMs);
    const result =
      run.kind === "failed" ? unavailable(run.reason) : parseUsageOutput(run.text, this.#now());
    this.#cache = { at: this.#now(), result };
    return result;
  }
}

export function createUsageLimitStore(
  options: UsageLimitStoreOptions = {},
): UsageLimitStoreService {
  return new UsageLimitStoreService(options);
}
