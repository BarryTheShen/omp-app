import type { UsageLimitAccount, UsageLimitProvider, UsageLimitsResult } from "@omp-app/contracts";
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

// Only the fields the popover shows are read, and of an account's identity only the name omp gives it (its email,
// account or project); every other field (raw payloads, plans, organizations) is ignored.
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
const IdentityInput = z.looseObject({
  email: z.string().optional(),
  accountId: z.string().optional(),
  projectId: z.string().optional(),
});
const LimitInput = z.looseObject({
  window: WindowInput.optional(),
  amount: AmountInput.optional(),
  scope: IdentityInput.optional(),
});
const ReportInput = z.looseObject({
  provider: z.string().min(1),
  limits: z.array(z.unknown()).optional(),
  metadata: IdentityInput.optional(),
});
const UsageInput = z.looseObject({
  reports: z.array(z.unknown()),
});

interface WindowSummary {
  usedPercent: number;
  resetsAt: number | undefined;
  durationMs: number | undefined;
  accounts: number;
  /** The accounts' own highest shares added up (omp's combined line, `computeProviderWindowStats`). */
  usedAccounts: number;
}

/** One account's own share of a window: the highest of its limits in it, and when that one resets. */
interface AccountShare {
  fraction: number;
  resetsAt: number | undefined;
  durationMs: number | undefined;
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
 * An account as omp names it (`reportAccountLabel`, cli/usage-cli.ts): its email, account or project; else the account
 * or project of one of its limits; else its place among the provider's.
 */
function accountLabel(
  report: z.infer<typeof ReportInput>,
  limits: readonly z.infer<typeof LimitInput>[],
  index: number,
): string {
  const named = [
    report.metadata?.email,
    report.metadata?.accountId,
    report.metadata?.projectId,
  ].find((value) => value !== undefined && value !== "");
  if (named !== undefined) return named;
  const scoped = limits
    .map((limit) => limit.scope?.accountId ?? limit.scope?.projectId)
    .find((value) => value !== undefined && value !== "");
  return scoped ?? `Account ${index + 1}`;
}

/** A label no other account of the provider has: one account signed in twice has the same email twice. */
function uniqueLabel(label: string, taken: readonly { readonly label: string }[]): string {
  if (!taken.some((account) => account.label === label)) return label;
  for (let n = 2; ; n += 1) {
    const next = `${label} (${n})`;
    if (!taken.some((account) => account.label === next)) return next;
  }
}

/** One provider's windows as summed so far, and its accounts in the order omp reported them. */
interface ProviderSummary {
  readonly windows: Map<string, WindowSummary>;
  readonly accounts: UsageLimitAccount[];
}

/**
 * Per provider and window: the fullest account's share and its reset time (what the usage rules act on), how many
 * accounts report the window and, as omp's combined line counts them, their shares added up; with two or more
 * accounts, each account's own windows under the name omp gives it (#13).
 */
function summarize(reports: readonly unknown[]): UsageLimitProvider[] {
  const byProvider = new Map<string, ProviderSummary>();
  for (const raw of reports) {
    const report = ReportInput.safeParse(raw);
    if (!report.success) continue;
    const entry: ProviderSummary = byProvider.get(report.data.provider) ?? {
      windows: new Map(),
      accounts: [],
    };
    byProvider.set(report.data.provider, entry);
    const limits: z.infer<typeof LimitInput>[] = [];
    const own = new Map<string, AccountShare>();
    for (const rawLimit of report.data.limits ?? []) {
      const limit = LimitInput.safeParse(rawLimit);
      if (!limit.success) continue;
      limits.push(limit.data);
      if (limit.data.window === undefined) continue;
      const fraction = usedFractionOf(limit.data.amount);
      if (fraction === undefined) continue;
      const { label, resetsAt } = limit.data.window;
      const durationMs = durationOf(limit.data.window);
      const mine = own.get(label);
      if (mine === undefined) own.set(label, { fraction, resetsAt, durationMs });
      else if (fraction > mine.fraction)
        own.set(label, { fraction, resetsAt, durationMs: durationMs ?? mine.durationMs });
    }
    if (own.size === 0) continue;
    for (const [label, mine] of own) {
      const current = entry.windows.get(label);
      if (current === undefined) {
        entry.windows.set(label, {
          usedPercent: mine.fraction * 100,
          resetsAt: mine.resetsAt,
          durationMs: mine.durationMs,
          accounts: 1,
          usedAccounts: mine.fraction,
        });
        continue;
      }
      current.accounts += 1;
      current.usedAccounts += mine.fraction;
      current.durationMs ??= mine.durationMs;
      if (mine.fraction * 100 > current.usedPercent) {
        current.usedPercent = mine.fraction * 100;
        current.resetsAt = mine.resetsAt;
      }
    }
    entry.accounts.push({
      label: uniqueLabel(accountLabel(report.data, limits, entry.accounts.length), entry.accounts),
      windows: [...own].map(([label, mine]) => ({
        label,
        usedPercent: Math.round(mine.fraction * 1_000) / 10,
        resetsAt: mine.resetsAt === undefined ? null : new Date(mine.resetsAt).toISOString(),
      })),
    });
  }
  return [...byProvider]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerId, { windows, accounts }]) => ({
      providerId,
      windows: [...windows].map(([label, summary]) => ({
        label,
        usedPercent: Math.round(summary.usedPercent * 10) / 10,
        resetsAt: summary.resetsAt === undefined ? null : new Date(summary.resetsAt).toISOString(),
        accounts: summary.accounts,
        durationMs: summary.durationMs ?? null,
        // One account's line is its own: the combined numbers and the accounts come only with two or more.
        ...(summary.accounts > 1
          ? { usedAccounts: Math.round(summary.usedAccounts * 100) / 100 }
          : {}),
      })),
      ...(accounts.length > 1 ? { accounts } : {}),
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
 * Runs `omp usage --json` once, bounded by the deadline. Its stderr is read and never returned or logged,
 * since it can carry credentials. The process group is stopped when the read ends, however it ends.
 */
async function runOmpUsage(
  command: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<OmpRun> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([...command, "usage", "--json"], {
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
 * The provider usage limits omp reports, read with `omp usage --json`. A read is current for a minute; up to ten
 * minutes old it still answers a page at once while a fresh one is read behind it, and concurrent reads share one omp
 * run. The result carries provider ids, window labels, percentages and reset times, and with two or more accounts of a
 * provider each account's name as omp gives it (its email, account or project): nothing else of theirs. Once
 * watching, the server reads them by itself, every 5 minutes and every minute once a window is near its limit, and
 * every fresh read goes to the subscribers (#2781), so a page shown a kept read gets the fresh one too.
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
