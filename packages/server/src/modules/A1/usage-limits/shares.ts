import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ThreadId,
  UsageLimitsResult,
  UsageShareProvider,
  UsageSharesResult,
} from "@omp-app/contracts";
import type { ChatEvent } from "@omp-app/contracts/chat-host";

/** The window a chat's part is counted in: its provider's 5-hour window (#14). */
const FIVE_HOUR_MS = 5 * 3_600_000;
/** A window's percent that falls by more than this from one reading to the next started over (a reset, or an account's). */
const START_OVER_DROP = 0.5;

interface Logger {
  warn(event: string, fields: Record<string, string | number>): void;
}

/** What a chat spent on a provider: dollars as omp prices them, and tokens. */
interface Spend {
  cost: number;
  tokens: number;
}

/** A chat's part of a window: percent of the window, and its spend there. */
interface Part extends Spend {
  share: number;
}

/** A provider's 5-hour window as counted: its last percent, its reset, the part outside the app, and each chat's. */
interface Window {
  used: number;
  resetsAt: number | null;
  outside: number;
  since: number;
  chats: Map<ThreadId, Part>;
}

/**
 * The file: `{ "version": 1, "windows": { "<provider>": [used, resetsAt, outside, since, { "<thread>": [share, cost,
 * tokens] }] }, "spent": { "<provider>": { "<thread>": [cost, tokens] } } }`.
 */
interface SharesFile {
  readonly version: 1;
  readonly windows: Record<
    string,
    readonly [
      number,
      number | null,
      number,
      number,
      Record<string, readonly [number, number, number]>,
    ]
  >;
  readonly spent: Record<string, Record<string, readonly [number, number]>>;
}

/**
 * A provider's 5-hour window in a reading as a chat's part is counted in: one account's percent, or two or more
 * accounts' together (their shares added up, over how many there are), with when it resets.
 */
export function fiveHourUse(
  result: UsageLimitsResult,
  providerId: string,
): { readonly used: number; readonly resetsAt: number | null } | undefined {
  if (result.state !== "ready") return undefined;
  const window = result.providers
    .find((provider) => provider.providerId === providerId)
    ?.windows.find((candidate) => candidate.durationMs === FIVE_HOUR_MS);
  if (window === undefined) return undefined;
  const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
  const used =
    window.accounts > 1 && window.usedAccounts !== undefined
      ? (window.usedAccounts / window.accounts) * 100
      : window.usedPercent;
  return { used, resetsAt: Number.isFinite(reset) ? reset : null };
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Each chat's part of its provider's 5-hour window (#14), an estimate. The server hears every chat's replies, each with
 * omp's price and tokens; at each fresh reading of the usage limits, a window's growth since the last reading goes to
 * the chats by what each spent on that provider meanwhile (by tokens when nothing had a price), and growth while no chat
 * spent goes outside the app (omp in a terminal, other computers), as does the use before the first reading. A window
 * whose percent falls, or whose reset has passed, starts over. Kept on disk, so a restart keeps the window's parts.
 */
export class UsageShares {
  readonly #windows = new Map<string, Window>();
  /** Spend since the last reading, by provider and chat. */
  readonly #spent = new Map<string, Map<ThreadId, Spend>>();
  readonly #path: string;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  #saving: Promise<void> = Promise.resolve();

  private constructor(path: string, now: () => number, logger: Logger | undefined) {
    this.#path = path;
    this.#now = now;
    this.#logger = logger;
  }

  /** The parts kept in `path` (none when it is missing or unreadable). */
  static async open(
    path: string,
    options: { readonly now?: () => number; readonly logger?: Logger } = {},
  ): Promise<UsageShares> {
    const shares = new UsageShares(path, options.now ?? Date.now, options.logger);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return shares;
    try {
      const file = JSON.parse(text) as SharesFile;
      if (file.version !== 1) return shares;
      for (const [providerId, [used, resetsAt, outside, since, chats]] of Object.entries(
        file.windows,
      )) {
        const parts = new Map<ThreadId, Part>();
        for (const [threadId, [share, cost, tokens]] of Object.entries(chats)) {
          if (finite(share) && finite(cost) && finite(tokens))
            parts.set(threadId as ThreadId, { share, cost, tokens });
        }
        if (finite(used) && finite(outside) && finite(since))
          shares.#windows.set(providerId, {
            used,
            resetsAt: finite(resetsAt) ? resetsAt : null,
            outside,
            since,
            chats: parts,
          });
      }
      for (const [providerId, chats] of Object.entries(file.spent)) {
        const spent = new Map<ThreadId, Spend>();
        for (const [threadId, [cost, tokens]] of Object.entries(chats)) {
          if (finite(cost) && finite(tokens)) spent.set(threadId as ThreadId, { cost, tokens });
        }
        shares.#spent.set(providerId, spent);
      }
    } catch (failure) {
      options.logger?.warn("usage_shares.load_failed", { error: String(failure) });
    }
    return shares;
  }

  /** A chat's event: each reply's price and tokens count to its provider's window at the next reading. */
  onEvent(threadId: ThreadId, event: ChatEvent): void {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const { provider, usage } = event.message;
    const cost = finite(usage?.cost?.total) ? Math.max(0, usage.cost.total) : 0;
    const tokens = finite(usage?.totalTokens) ? Math.max(0, Math.round(usage.totalTokens)) : 0;
    if (typeof provider !== "string" || (cost === 0 && tokens === 0)) return;
    const spent = this.#spent.get(provider) ?? new Map<ThreadId, Spend>();
    const was = spent.get(threadId) ?? { cost: 0, tokens: 0 };
    spent.set(threadId, { cost: was.cost + cost, tokens: was.tokens + tokens });
    this.#spent.set(provider, spent);
    this.#keep();
  }

  /** A fresh reading of the usage limits: each provider's 5-hour window's growth goes to the chats that spent. */
  onReading(result: UsageLimitsResult): void {
    if (result.state !== "ready") return;
    const now = this.#now();
    const providers = new Set([
      ...this.#spent.keys(),
      ...result.providers.map((provider) => provider.providerId),
    ]);
    for (const providerId of providers) {
      const use = fiveHourUse(result, providerId);
      const spent = this.#spent.get(providerId);
      this.#spent.delete(providerId);
      // A provider with no 5-hour window: its spend has no window to count in.
      if (use === undefined) continue;
      const window = this.#windows.get(providerId);
      if (window === undefined) {
        // The first reading: the window's use so far came before the server counted it.
        this.#windows.set(providerId, {
          used: use.used,
          resetsAt: use.resetsAt,
          outside: use.used,
          since: now,
          chats: new Map(),
        });
        continue;
      }
      const startedOver =
        use.used < window.used - START_OVER_DROP ||
        (window.resetsAt !== null && now >= window.resetsAt);
      if (startedOver) {
        window.used = 0;
        window.outside = 0;
        window.since = window.resetsAt !== null && now >= window.resetsAt ? window.resetsAt : now;
        window.chats = new Map();
      }
      const growth = Math.max(0, use.used - window.used);
      let cost = 0;
      let tokens = 0;
      for (const each of spent?.values() ?? []) {
        cost += each.cost;
        tokens += each.tokens;
      }
      if (growth > 0 && cost + tokens === 0) window.outside += growth;
      for (const [threadId, each] of spent ?? []) {
        const weight = cost > 0 ? each.cost / cost : tokens > 0 ? each.tokens / tokens : 0;
        const part = window.chats.get(threadId) ?? { share: 0, cost: 0, tokens: 0 };
        window.chats.set(threadId, {
          share: part.share + growth * weight,
          cost: part.cost + each.cost,
          tokens: part.tokens + each.tokens,
        });
      }
      window.used = use.used;
      window.resetsAt = use.resetsAt;
    }
    this.#keep();
  }

  /** A chat's part of a provider's window, or of the fullest of its parts with no provider named; null with none. */
  shareOf(threadId: ThreadId, providerId?: string): number | null {
    let most: number | null = null;
    for (const [id, window] of this.#windows) {
      if (providerId !== undefined && id !== providerId) continue;
      const share = window.chats.get(threadId)?.share;
      if (share !== undefined && (most === null || share > most)) most = share;
    }
    return most;
  }

  /** Each provider's window as counted, the fullest first; each chat in it with the largest part first. */
  snapshot(): UsageSharesResult {
    const providers: UsageShareProvider[] = [...this.#windows].map(([providerId, window]) => ({
      providerId,
      used: window.used,
      resetsAt: window.resetsAt,
      outside: window.outside,
      since: window.since,
      chats: [...window.chats]
        .map(([threadId, part]) => ({
          threadId,
          share: part.share,
          cost: part.cost,
          tokens: part.tokens,
        }))
        .sort((a, b) => b.share - a.share || b.cost - a.cost)
        .slice(0, 500),
    }));
    return { providers: providers.sort((a, b) => b.used - a.used).slice(0, 64) };
  }

  /** Writes the parts after the writes before it, so the file holds the last ones. */
  #keep(): void {
    const file: SharesFile = {
      version: 1,
      windows: Object.fromEntries(
        [...this.#windows].map(([providerId, window]) => [
          providerId,
          [
            window.used,
            window.resetsAt,
            window.outside,
            window.since,
            Object.fromEntries(
              [...window.chats].map(([threadId, part]) => [
                threadId,
                [part.share, part.cost, part.tokens] as const,
              ]),
            ),
          ] as const,
        ]),
      ),
      spent: Object.fromEntries(
        [...this.#spent].map(([providerId, spent]) => [
          providerId,
          Object.fromEntries(
            [...spent].map(([threadId, each]) => [threadId, [each.cost, each.tokens] as const]),
          ),
        ]),
      ),
    };
    const text = `${JSON.stringify(file)}\n`;
    const path = this.#path;
    this.#saving = this.#saving.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, text, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (failure) {
        this.#logger?.warn("usage_shares.save_failed", { error: String(failure) });
      }
    });
  }

  /** The last write's end (tests). */
  saved(): Promise<void> {
    return this.#saving;
  }
}
