import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ThreadId,
  USAGE_BUDGET_HOLD_RULE,
  type UsageActivityAction,
  UsageActivityEntry,
  type UsageLimitsResult,
  type UsagePaceResult,
  type UsagePauseHold,
  UsagePauseReason,
  UsageRule,
  type UsageRuleHeld,
  UsageRuleScope,
} from "@omp-app/contracts";
import type { Logger } from "../../logging/logger";
import type { ProcessTimer } from "../../process/omp-process";
import {
  FIVE_HOUR_MS,
  fullestWindow,
  type HeldFor,
  type Holding,
  holdingConditions,
  inHours,
  type ProviderReading,
  RESUME_GRACE_MS,
  type UsageConditions,
  WEEK_MS,
  windowOf,
} from "./usage-rules";

/** The window a chat's own mark watches: its provider's 5-hour window (#2781). */
export const USAGE_PAUSE_WINDOW_MS = FIVE_HOUR_MS;
/** A held chat resumes this long after its window's reset, once the provider counts the new window. */
export const USAGE_PAUSE_RESUME_GRACE_MS = RESUME_GRACE_MS;
/** A resume due while the server was down runs this long after the server is back, once the chats' hosts reconnected. */
export const USAGE_PAUSE_AFTER_START_MS = 30_000;
/** How often the rules with hours are judged, so their chats pause and continue on the minute (#2836). */
export const USAGE_RULES_TICK_MS = 60_000;
/**
 * Held chats no condition holds any more continue one at a time, this far apart, in the queue's order, so a window
 * that resets is not spent in one burst (#2836).
 */
export const USAGE_CONTINUE_STAGGER_MS = 3 * 60_000;
/** A hand resume of a chat held for a reason with no expected end keeps it running this long at most. */
const OVERRIDE_FALLBACK_MS = FIVE_HOUR_MS;

/** A chat's mark: pause at `percent` of its provider's 5-hour window; `folder` lists it with the folder's chats. */
export interface UsagePauseMark {
  readonly percent: number;
  readonly folder: string;
}

/** A chat's budget (#14): pause once its own part of its provider's 5-hour window reaches `percent`. */
export interface UsageBudget {
  readonly percent: number;
  readonly folder: string;
}

/** What is kept beside the pause's own file (#14): the chats' budgets, and who each rule pauses. */
export interface UsagePauseExtras {
  readonly budgets: ReadonlyMap<ThreadId, UsageBudget>;
  readonly scopes: ReadonlyMap<string, UsageRuleScope>;
}

const NO_EXTRAS: UsagePauseExtras = { budgets: new Map(), scopes: new Map() };

/**
 * Hand resumes (#2836): for each chat resumed by hand while held, each condition that held it and until when it does
 * not pause the chat again (epoch ms: when that condition next starts, as a window's reset or the next day's hours).
 */
export type UsagePauseOverrides = ReadonlyMap<ThreadId, ReadonlyMap<UsagePauseReason, number>>;

/** What is kept on disk: the marks, the rules, the holds not ended yet, their order, and the hand resumes still running. */
export interface UsagePauseKept {
  readonly marks: ReadonlyMap<ThreadId, UsagePauseMark>;
  readonly holds: ReadonlyMap<ThreadId, UsagePauseHold>;
  readonly rules: readonly UsageRule[];
  readonly overrides: UsagePauseOverrides;
  /** The held chats in the queue's order (#2836): the first continues first. */
  readonly order: readonly ThreadId[];
  /** What the usage pause did, oldest first: the last `USAGE_ACTIVITY_KEPT` things (#2836). */
  readonly activity: readonly UsageActivityEntry[];
}

/** How many things the usage pause did are kept for the dashboard's activity. */
export const USAGE_ACTIVITY_KEPT = 200;

/** A held chat in the queue (#2836): its hold, and when it is next to continue if no condition holds it any more. */
export interface UsageQueued {
  readonly id: ThreadId;
  readonly hold: UsagePauseHold;
  /** When it continues (epoch ms), once its turn comes; null while a condition still holds it. */
  readonly continuesAt: number | null;
}

export interface UsagePauseDeps {
  readonly now: () => number;
  readonly timer: ProcessTimer;
  readonly load: () => Promise<UsagePauseKept>;
  readonly save: (kept: UsagePauseKept) => Promise<void>;
  /** The provider of the model the chat runs now; null when its omp is not running. */
  readonly providerOf: (threadId: ThreadId) => Promise<string | null>;
  /** Holds the chat's agents at their next step, as omp's `/pause`; false when its omp is not running. */
  readonly pause: (threadId: ThreadId) => Promise<boolean>;
  readonly resume: (threadId: ThreadId) => Promise<boolean>;
  /** Whether the chat is paused now, whoever paused it (the pause the chat's host reports). */
  readonly isPaused: (threadId: ThreadId) => boolean;
  /** The folder of a chat the server runs: a rule's chat has no mark to say it (#2836). */
  readonly folderOf?: (threadId: ThreadId) => string | undefined;
  /** Each window's pace from the server's readings (#2836): a rule's pace condition reads its 5-hour window's. */
  readonly pace?: () => UsagePaceResult;
  /**
   * A chat's own part of a provider's 5-hour window (`UsageShares`), or of the fullest of its parts with no provider
   * named; null when it has none (#14).
   */
  readonly shareOf?: (threadId: ThreadId, providerId?: string) => number | null;
  /** The budgets and the rules' scopes kept before the server started, in a file of their own (#14); none when absent. */
  readonly loadExtras?: () => Promise<UsagePauseExtras>;
  readonly saveExtras?: (extras: UsagePauseExtras) => Promise<void>;
  /** The chats the server runs now: a rule for every chat pauses each of them (#14). */
  readonly chats?: () => readonly ThreadId[];
  /** The time zone of the rules' hours: the server's own unless given. */
  readonly timeZone?: string;
  readonly logger?: Logger;
}

/** Hears a chat's mark or hold change: `percent` null when it is not marked, `hold` null while it is not held. */
export type UsagePauseListener = (
  threadId: ThreadId,
  folder: string,
  percent: number | null,
  hold: UsagePauseHold | null,
) => void;

const EMPTY: UsagePauseKept = {
  marks: new Map(),
  holds: new Map(),
  rules: [],
  overrides: new Map(),
  order: [],
  activity: [],
};

/** A condition that holds for a chat, with the rule it is from (none for the chat's own mark). */
type RuleHolding = Holding & { readonly rule: string | undefined };

/** What a hold holds its chat for, and until when it expected that (a hold kept before rules is a mark's 5-hour one). */
function heldFor(hold: UsagePauseHold): HeldFor {
  return { reason: hold.reason ?? "five_hour", until: hold.until };
}

/** Of the conditions that hold, the one a hold names: the one expected to last longest, an open-ended one first. */
function longest(holding: readonly RuleHolding[]): RuleHolding | undefined {
  let best: RuleHolding | undefined;
  for (const candidate of holding) {
    if (best === undefined) best = candidate;
    else if (best.until !== null && (candidate.until === null || candidate.until > best.until))
      best = candidate;
  }
  return best;
}

/** Of the conditions that hold, when the first is expected to end: then the chat is judged again. */
function earliest(holding: readonly RuleHolding[]): number | null {
  let first: number | null = null;
  for (const { until } of holding) {
    if (until !== null && (first === null || until < first)) first = until;
  }
  return first;
}

/**
 * The usage pause (#2781 part 3) and the usage rules (#2836). A chat pauses (omp's `/pause`: its agents hold at their
 * next step) while a condition holds that it is marked or listed for: its own mark (its provider's 5-hour window at the
 * mark's percent, 95% unless set otherwise), or a rule's (the 5-hour or weekly window at a percent, the 5-hour window's
 * pace heading past a percent before its reset, the clock in given hours). The pause keeps a hold on it, which names the
 * condition expected to last longest, and the chat continues once no condition holds: at a reading under the limits, at
 * a window's reset plus `USAGE_PAUSE_RESUME_GRACE_MS` (read or not), at the end of the hours. A reading older than
 * `STALE_READING_MS` continues nothing. A chat that was paused already is left alone; one resumed by anyone else while
 * held ends its hold, and the conditions that held it do not pause it again until they next start (a window's reset, the
 * next day's hours). Unmarking a chat, or taking it out of every rule, continues it. Marks, rules, holds and hand
 * resumes are kept on disk; a resume that fell due while the server was down runs `USAGE_PAUSE_AFTER_START_MS` after it
 * is back.
 */
export class UsagePause {
  readonly #deps: UsagePauseDeps;
  readonly #zone: string;
  readonly #marks = new Map<ThreadId, UsagePauseMark>();
  /** The chats' budgets of their provider's 5-hour window (#14). */
  readonly #budgets = new Map<ThreadId, UsageBudget>();
  /** Who each rule pauses, when not just the chats it lists (#14). */
  readonly #scopes = new Map<string, UsageRuleScope>();
  readonly #rules = new Map<string, UsageRule>();
  readonly #holds = new Map<ThreadId, UsagePauseHold>();
  readonly #overrides = new Map<ThreadId, Map<UsagePauseReason, number>>();
  readonly #timers = new Map<ThreadId, { readonly handle: unknown; readonly at: number }>();
  readonly #listeners = new Set<UsagePauseListener>();
  /** The held chats in the queue's order; a new hold joins at the end. */
  #order: ThreadId[] = [];
  /** Held chats no condition holds any more, waiting for their turn to continue. */
  readonly #due = new Set<ThreadId>();
  /** When the last chat continued in its turn: the next waits `USAGE_CONTINUE_STAGGER_MS` from it. */
  #lastContinue = Number.NEGATIVE_INFINITY;
  #dispatch: unknown = null;
  /** What the usage pause did, oldest first. */
  #activity: UsageActivityEntry[] = [];
  /** The last usage read and when the server got it, so a mark or rule set or changed is judged at once. */
  #usage: { readonly result: UsageLimitsResult; readonly receivedAt: number } | null = null;
  #tick: unknown = null;
  /** Judgments run one after another: each asks chats for their provider and pauses or resumes them. */
  #judging: Promise<void> = Promise.resolve();
  #saving: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: UsagePauseDeps) {
    this.#deps = deps;
    this.#zone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** The time zone of the rules' hours. */
  get timeZone(): string {
    return this.#zone;
  }

  /** Takes up the marks, rules, holds and hand resumes kept before the server started. */
  async restore(): Promise<void> {
    const kept = await this.#deps.load().catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.load_failed", { error: String(failure) });
      return EMPTY;
    });
    for (const [threadId, mark] of kept.marks) this.#marks.set(threadId, mark);
    const extras = await (this.#deps.loadExtras?.() ?? Promise.resolve(NO_EXTRAS)).catch(
      (failure: unknown) => {
        this.#deps.logger?.warn("usage_pause.extras_load_failed", { error: String(failure) });
        return NO_EXTRAS;
      },
    );
    for (const [threadId, budget] of extras.budgets) this.#budgets.set(threadId, budget);
    for (const [id, scope] of extras.scopes) this.#scopes.set(id, scope);
    for (const rule of kept.rules) this.#rules.set(rule.id, rule);
    const now = this.#deps.now();
    for (const [threadId, reasons] of kept.overrides) {
      const live = new Map([...reasons].filter(([, until]) => until > now));
      if (live.size > 0) this.#overrides.set(threadId, live);
    }
    const earliest = now + USAGE_PAUSE_AFTER_START_MS;
    for (const [threadId, hold] of kept.holds) {
      if (!this.#watched(threadId)) continue;
      this.#holds.set(threadId, hold);
      if (hold.until !== null) this.#schedule(threadId, Math.max(hold.until, earliest));
    }
    this.#order = [
      ...kept.order.filter((id) => this.#holds.has(id)),
      ...[...this.#holds.keys()].filter((id) => !kept.order.includes(id)),
    ];
    this.#activity = kept.activity.slice(-USAGE_ACTIVITY_KEPT);
    this.#ticking();
  }

  /** The chats of a folder that are marked, with their limits and holds. */
  marksIn(folder: string): readonly {
    readonly id: ThreadId;
    readonly percent: number;
    readonly hold: UsagePauseHold | null;
  }[] {
    return [...this.#marks]
      .filter(([, mark]) => mark.folder === folder)
      .map(([id, mark]) => ({ id, percent: mark.percent, hold: this.#holds.get(id) ?? null }));
  }

  /** The rules, each with the chats it holds now and why. */
  rules(): readonly { readonly rule: UsageRule; readonly held: readonly UsageRuleHeld[] }[] {
    return [...this.#rules.values()].map((rule) => ({
      rule,
      held: [...this.#holds].flatMap(([id, hold]) =>
        hold.rule === rule.id
          ? [{ id, reason: hold.reason ?? "five_hour", until: hold.until }]
          : [],
      ),
    }));
  }

  /**
   * Marks the chat to pause at `percent` of its provider's 5-hour window, or unmarks it (`null`). The new limit is
   * judged against the last read at once: a lower one can pause the chat now, a higher one can end its hold.
   */
  setMark(threadId: ThreadId, folder: string, percent: number | null): Promise<void> {
    return this.#queue(async () => {
      if (percent === null) {
        const mark = this.#marks.get(threadId);
        if (mark === undefined) return;
        this.#marks.delete(threadId);
        this.#deps.logger?.info("usage_pause.unmarked", { threadId });
      } else {
        this.#marks.set(threadId, { percent, folder });
        this.#deps.logger?.info("usage_pause.marked", { threadId, percent });
      }
      this.#keep();
      this.#notify(threadId, folder);
      await this.#judge([threadId]);
    });
  }

  /** The chats' budgets (#14). */
  budgets(): ReadonlyMap<ThreadId, UsageBudget> {
    return this.#budgets;
  }

  /**
   * Gives the chat a budget of `percent` of its provider's 5-hour window, or removes it (`null`) (#14). It is judged
   * against the chat's part at once: a part already past it pauses the chat now, a higher budget can end its hold.
   */
  setBudget(threadId: ThreadId, folder: string, percent: number | null): Promise<void> {
    return this.#queue(async () => {
      if (percent === null) {
        if (!this.#budgets.delete(threadId)) return;
        this.#deps.logger?.info("usage_pause.budget_removed", { threadId });
      } else {
        this.#budgets.set(threadId, { percent, folder });
        this.#deps.logger?.info("usage_pause.budget_set", { threadId, percent });
      }
      await this.#keepExtras();
      await this.#judge([threadId]);
    });
  }

  /** Who each rule pauses, when not just the chats it lists (#14). */
  scopes(): ReadonlyMap<string, UsageRuleScope> {
    return this.#scopes;
  }

  /**
   * Sets who a rule pauses (#14): the chats it lists, or every chat the server runs, on any provider or one. The chats
   * it reached before and those it reaches now are judged at once.
   */
  setRuleScope(id: string, scope: UsageRuleScope): Promise<void> {
    const parsed = UsageRuleScope.parse(scope);
    return this.#queue(async () => {
      const before = this.#scopes.get(id);
      if (!parsed.everyChat && parsed.provider === null) this.#scopes.delete(id);
      else this.#scopes.set(id, parsed);
      this.#deps.logger?.info("usage_pause.rule_scope_set", {
        rule: id,
        chats: parsed.everyChat ? "every chat" : "listed",
        provider: parsed.provider ?? "any",
      });
      await this.#keepExtras();
      const listed = this.#rules.get(id)?.chats ?? [];
      const every = before?.everyChat === true || parsed.everyChat ? this.#runningChats() : [];
      await this.#judge([...new Set([...listed, ...every, ...this.#holds.keys()])]);
    });
  }

  /** Adds a rule, or replaces the one with its id, and judges its chats (and those it no longer lists) at once. */
  setRule(rule: UsageRule): Promise<void> {
    const parsed = UsageRule.parse(rule);
    return this.#queue(async () => {
      const before = this.#rules.get(parsed.id);
      this.#rules.set(parsed.id, parsed);
      this.#deps.logger?.info("usage_pause.rule_set", {
        rule: parsed.id,
        chats: parsed.chats.length,
      });
      this.#keep();
      this.#ticking();
      const every = this.#scopes.get(parsed.id)?.everyChat === true ? this.#runningChats() : [];
      await this.#judge([...new Set([...(before?.chats ?? []), ...parsed.chats, ...every])]);
    });
  }

  /** Removes a rule and its scope: the chats it held continue, unless another rule, a mark or a budget holds them. */
  removeRule(id: string): Promise<void> {
    return this.#queue(async () => {
      const rule = this.#rules.get(id);
      if (rule === undefined) return;
      this.#rules.delete(id);
      const every = this.#scopes.get(id)?.everyChat === true ? this.#runningChats() : [];
      if (this.#scopes.delete(id)) await this.#keepExtras();
      this.#deps.logger?.info("usage_pause.rule_removed", { rule: id });
      this.#keep();
      this.#ticking();
      await this.#judge([...new Set([...rule.chats, ...every])]);
    });
  }

  /** Writes the budgets and the rules' scopes to their own file (#14). */
  async #keepExtras(): Promise<void> {
    const extras = { budgets: new Map(this.#budgets), scopes: new Map(this.#scopes) };
    await this.#deps.saveExtras?.(extras).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.extras_save_failed", { error: String(failure) });
    });
  }

  /** The held chats in the queue's order, each with its hold and, once no condition holds it, when it continues. */
  queue(): readonly UsageQueued[] {
    const now = this.#deps.now();
    let turn = Math.max(now, this.#lastContinue + USAGE_CONTINUE_STAGGER_MS);
    return this.#order.flatMap((id): UsageQueued[] => {
      const hold = this.#holds.get(id);
      if (hold === undefined) return [];
      if (!this.#due.has(id)) return [{ id, hold, continuesAt: null }];
      const at = turn;
      turn += USAGE_CONTINUE_STAGGER_MS;
      return [{ id, hold, continuesAt: at }];
    });
  }

  /** Puts the held chats in this order; those it leaves out keep theirs after them. */
  setOrder(threadIds: readonly ThreadId[]): Promise<void> {
    return this.#queue(async () => {
      const first = threadIds.filter(
        (id, index) => this.#holds.has(id) && threadIds.indexOf(id) === index,
      );
      this.#order = [...first, ...this.#order.filter((id) => !first.includes(id))];
      this.#keep();
    });
  }

  /**
   * Continues a held chat now, out of its turn: as a hand resume, the conditions that hold it do not pause it again
   * until they next start.
   */
  continueNow(threadId: ThreadId): Promise<void> {
    return this.#queue(async () => {
      const hold = this.#holds.get(threadId);
      if (hold === undefined) return;
      this.#putOff(threadId, hold);
      await this.#release(threadId, "continued_now", "continued_now");
    });
  }

  /** Skips a held chat's continuing: it stays paused, and the rules let it be until it is resumed by hand. */
  skip(threadId: ThreadId): Promise<void> {
    return this.#queue(async () => {
      const hold = this.#holds.get(threadId);
      if (hold === undefined) return;
      this.#log(threadId, "skipped", hold);
      this.#endHold(threadId, "skipped");
    });
  }

  /** A fresh usage read: chats a condition holds for pause, held ones none holds for any more continue. */
  onUsage(result: UsageLimitsResult): Promise<void> {
    if (result.state !== "ready") return Promise.resolve();
    this.#usage = { result, receivedAt: this.#deps.now() };
    return this.#queue(() => this.#judge(this.#watchedChats()));
  }

  /**
   * The chat's pause changed. A held chat running again was resumed by someone else: the rule lets it be, and the
   * conditions that held it do not pause it again until they next start.
   */
  onPauseChanged(threadId: ThreadId, pausedAt: number | null): void {
    if (pausedAt !== null) return;
    const hold = this.#holds.get(threadId);
    if (hold === undefined) return;
    this.#putOff(threadId, hold);
    this.#log(threadId, "resumed_by_hand", hold);
    this.#endHold(threadId, "resumed_elsewhere");
  }

  /** What the usage pause did, newest first. */
  activity(): readonly UsageActivityEntry[] {
    return [...this.#activity].reverse();
  }

  /** Notes what the usage pause did with a chat, with the condition and rule that held it. */
  #log(threadId: ThreadId, action: UsageActivityAction, hold: UsagePauseHold | undefined): void {
    this.#activity.push({
      at: this.#deps.now(),
      id: threadId,
      action,
      reason: hold?.reason ?? (hold === undefined ? null : "five_hour"),
      rule: hold?.rule ?? null,
    });
    if (this.#activity.length > USAGE_ACTIVITY_KEPT)
      this.#activity.splice(0, this.#activity.length - USAGE_ACTIVITY_KEPT);
  }

  /** A held chat resumed by hand: each condition that holds it does not pause it again until it next starts. */
  #putOff(threadId: ThreadId, hold: UsagePauseHold): void {
    const now = this.#deps.now();
    const reasons = this.#overrides.get(threadId) ?? new Map<UsagePauseReason, number>();
    for (const holding of this.#holding(threadId, hold.providerId, heldFor(hold), now)) {
      reasons.set(holding.reason, holding.until ?? now + OVERRIDE_FALLBACK_MS);
    }
    if (reasons.size > 0) this.#overrides.set(threadId, reasons);
  }

  /** The chat moved to omp's new id for it: its mark, its place in the rules, its hold and hand resumes go with it. */
  move(from: ThreadId, to: ThreadId): void {
    const mark = this.#marks.get(from);
    if (mark !== undefined) {
      this.#marks.delete(from);
      this.#marks.set(to, mark);
    }
    for (const rule of this.#rules.values()) {
      if (rule.chats.includes(from))
        this.#rules.set(rule.id, {
          ...rule,
          chats: rule.chats.map((id) => (id === from ? to : id)),
        });
    }
    const overrides = this.#overrides.get(from);
    if (overrides !== undefined) {
      this.#overrides.delete(from);
      this.#overrides.set(to, overrides);
    }
    const hold = this.#holds.get(from);
    if (hold !== undefined) {
      this.#holds.delete(from);
      this.#holds.set(to, hold);
      this.#clearTimer(from);
      if (hold.until !== null) this.#schedule(to, hold.until);
    }
    this.#keep();
    const folder = mark?.folder ?? this.#deps.folderOf?.(to);
    if (folder === undefined) return;
    this.#notify(from, folder, null, null);
    this.#notify(to, folder);
  }

  /** Calls `listener` each time a chat's mark or hold changes; the returned function stops it. */
  onChange(listener: UsagePauseListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops every timer; the marks, rules and holds stay on disk for the next start. */
  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) this.#deps.timer.clearTimeout(timer.handle);
    this.#timers.clear();
    if (this.#tick !== null) this.#deps.timer.clearTimeout(this.#tick);
    this.#tick = null;
    if (this.#dispatch !== null) this.#deps.timer.clearTimeout(this.#dispatch);
    this.#dispatch = null;
  }

  /** Whether an enabled rule pauses the chat (#14): it lists it or is for every chat, and is for any provider or its. */
  #ruleApplies(rule: UsageRule, threadId: ThreadId, providerId?: string): boolean {
    if (!rule.enabled) return false;
    const scope = this.#scopes.get(rule.id);
    if (scope?.everyChat !== true && !rule.chats.includes(threadId)) return false;
    return (
      scope === undefined ||
      scope.provider === null ||
      providerId === undefined ||
      scope.provider === providerId
    );
  }

  /** The chats the server runs now, for the rules for every chat. */
  #runningChats(): readonly ThreadId[] {
    return this.#deps.chats?.() ?? [];
  }

  /** Whether the chat is marked, has a budget, or an enabled rule reaches it (its provider is asked later). */
  #watched(threadId: ThreadId): boolean {
    return (
      this.#marks.has(threadId) ||
      this.#budgets.has(threadId) ||
      [...this.#rules.values()].some((rule) => this.#ruleApplies(rule, threadId))
    );
  }

  /** The chats a mark, a budget or a rule watches (every running chat with a rule for every chat), and those held. */
  #watchedChats(): ThreadId[] {
    const chats = new Set<ThreadId>([
      ...this.#marks.keys(),
      ...this.#budgets.keys(),
      ...this.#holds.keys(),
    ]);
    for (const rule of this.#rules.values()) for (const id of rule.chats) chats.add(id);
    const everyChat = [...this.#rules.values()].some(
      (rule) => rule.enabled && this.#scopes.get(rule.id)?.everyChat === true,
    );
    if (everyChat) for (const id of this.#runningChats()) chats.add(id);
    return [...chats];
  }

  /**
   * The conditions the chat is watched for: its mark's, its budget's, and each enabled rule's that reaches it, on
   * `providerId` when given (without it, a rule for one provider counts, so the provider is asked).
   */
  #conditionsOf(
    threadId: ThreadId,
    providerId?: string,
  ): { readonly rule: string | undefined; readonly conditions: UsageConditions }[] {
    const mark = this.#marks.get(threadId);
    const budget = this.#budgets.get(threadId);
    const none = { fiveHourAt: null, weeklyAt: null, paceAt: null, hours: null } as const;
    return [
      ...(mark === undefined
        ? []
        : [{ rule: undefined, conditions: { ...none, fiveHourAt: mark.percent } }]),
      ...(budget === undefined
        ? []
        : [{ rule: USAGE_BUDGET_HOLD_RULE, conditions: { ...none, shareAt: budget.percent } }]),
      ...[...this.#rules.values()]
        .filter((rule) => this.#ruleApplies(rule, threadId, providerId))
        .map((rule) => ({ rule: rule.id, conditions: rule })),
    ];
  }

  /** The provider's windows in the last reading and its 5-hour window's pace. */
  #reading(providerId: string): ProviderReading | undefined {
    if (this.#usage === null) return undefined;
    const { result, receivedAt } = this.#usage;
    const fiveHour = windowOf(result, providerId, FIVE_HOUR_MS);
    const weekly = windowOf(result, providerId, WEEK_MS);
    if (fiveHour === undefined && weekly === undefined) return undefined;
    const pace =
      fiveHour === undefined
        ? undefined
        : this.#deps
            .pace?.()
            .windows.find(
              (window) => window.providerId === providerId && window.label === fiveHour.label,
            );
    return { fiveHour, weekly, atReset: pace?.atReset ?? null, receivedAt };
  }

  /** The conditions that hold for the chat on `providerId` at `now`, less those a hand resume put off. */
  #holding(
    threadId: ThreadId,
    providerId: string,
    heldFor: HeldFor | null,
    now: number,
  ): RuleHolding[] {
    const reading = this.#reading(providerId);
    const overrides = this.#overrides.get(threadId);
    const share = this.#deps.shareOf?.(threadId, providerId) ?? null;
    return this.#conditionsOf(threadId, providerId).flatMap(({ rule, conditions }) =>
      holdingConditions(conditions, reading, now, this.#zone, heldFor, share)
        .filter(({ reason }) => (overrides?.get(reason) ?? 0) <= now)
        .map((holding) => ({ ...holding, rule })),
    );
  }

  /** Whether any condition the chat is listed for could hold now, whatever its provider: else its provider is not asked. */
  #mayHold(threadId: ThreadId, now: number): boolean {
    const result = this.#usage?.result;
    const fiveHour = result === undefined ? 0 : fullestWindow(result, FIVE_HOUR_MS);
    const weekly = result === undefined ? 0 : fullestWindow(result, WEEK_MS);
    const share = this.#deps.shareOf?.(threadId) ?? 0;
    return this.#conditionsOf(threadId).some(
      ({ conditions }) =>
        (conditions.hours !== null && inHours(now, conditions.hours, this.#zone)) ||
        (conditions.fiveHourAt !== null && fiveHour >= conditions.fiveHourAt) ||
        (conditions.weeklyAt !== null && weekly >= conditions.weeklyAt) ||
        (conditions.shareAt !== undefined &&
          conditions.shareAt !== null &&
          share >= conditions.shareAt) ||
        (conditions.paceAt !== null && result !== undefined && this.#deps.pace !== undefined),
    );
  }

  async #judge(threadIds: readonly ThreadId[]): Promise<void> {
    for (const threadId of threadIds) {
      if (this.#closed) return;
      const now = this.#deps.now();
      const overrides = this.#overrides.get(threadId);
      if (overrides !== undefined) {
        for (const [reason, until] of overrides) if (until <= now) overrides.delete(reason);
        if (overrides.size === 0) this.#overrides.delete(threadId);
      }
      const hold = this.#holds.get(threadId);
      if (hold !== undefined) {
        // Unmarked, or out of every enabled rule: it continues at once, out of the queue.
        if (!this.#watched(threadId)) {
          await this.#release(threadId, "unwatched");
          continue;
        }
        const holding = this.#holding(threadId, hold.providerId, heldFor(hold), now);
        if (holding.length === 0) {
          // Its turn comes after this pass, in the queue's order.
          this.#due.add(threadId);
          continue;
        }
        // Held again before its turn came.
        if (this.#due.delete(threadId)) this.#log(threadId, "held_again", hold);
        this.#rehold(threadId, hold, holding);
        continue;
      }
      if (
        !this.#watched(threadId) ||
        this.#deps.isPaused(threadId) ||
        !this.#mayHold(threadId, now)
      )
        continue;
      const providerId = await this.#deps.providerOf(threadId).catch(() => null);
      if (providerId === null) continue;
      const holding = this.#holding(threadId, providerId, null, now);
      const named = longest(holding);
      if (named === undefined) continue;
      const paused = await this.#deps.pause(threadId).catch((failure: unknown) => {
        this.#deps.logger?.warn("usage_pause.pause_failed", { threadId, error: String(failure) });
        return false;
      });
      if (!paused || !this.#watched(threadId)) continue;
      const next: UsagePauseHold = {
        providerId,
        until: named.until,
        reason: named.reason,
        ...(named.rule === undefined ? {} : { rule: named.rule }),
        since: this.#deps.now(),
      };
      this.#holds.set(threadId, next);
      this.#log(threadId, "paused", next);
      if (!this.#order.includes(threadId)) this.#order.push(threadId);
      const at = earliest(holding);
      if (at !== null) this.#schedule(threadId, at);
      this.#deps.logger?.info("usage_pause.held", {
        threadId,
        providerId,
        reason: named.reason,
        rule: named.rule ?? null,
        until: named.until === null ? null : new Date(named.until).toISOString(),
      });
      this.#keep();
      this.#notifyHold(threadId);
    }
    await this.#continueNext();
  }

  /** A held chat some condition still holds: the hold names the one expected to last longest, judged again at the first end. */
  #rehold(threadId: ThreadId, hold: UsagePauseHold, holding: readonly RuleHolding[]): void {
    const named = longest(holding);
    if (named === undefined) return;
    const at = earliest(holding);
    if (at !== null) this.#schedule(threadId, at);
    else this.#clearTimer(threadId);
    if (hold.reason === named.reason && hold.rule === named.rule && hold.until === named.until)
      return;
    this.#holds.set(threadId, {
      providerId: hold.providerId,
      until: named.until,
      reason: named.reason,
      ...(named.rule === undefined ? {} : { rule: named.rule }),
      ...(hold.since === undefined ? {} : { since: hold.since }),
    });
    this.#keep();
    this.#notifyHold(threadId);
  }

  /** Ends the chat's hold and resumes it, if the rule holds it and it is still paused; the activity says so. */
  async #release(
    threadId: ThreadId,
    reason: string,
    action: "continued" | "continued_now" = "continued",
  ): Promise<void> {
    const hold = this.#holds.get(threadId);
    if (hold === undefined) return;
    this.#log(threadId, action, hold);
    this.#endHold(threadId, reason);
    if (!this.#deps.isPaused(threadId)) return;
    const resumed = await this.#deps.resume(threadId).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.resume_failed", { threadId, error: String(failure) });
      return false;
    });
    this.#deps.logger?.info("usage_pause.resumed", { threadId, reason, resumed });
  }

  #endHold(threadId: ThreadId, reason: string): void {
    if (!this.#holds.delete(threadId)) return;
    this.#clearTimer(threadId);
    this.#order = this.#order.filter((id) => id !== threadId);
    this.#due.delete(threadId);
    this.#deps.logger?.info("usage_pause.hold_ended", { threadId, reason });
    this.#keep();
    this.#notifyHold(threadId);
  }

  /**
   * Continues the first due chat in the queue's order that no condition holds any more, if no chat continued in the last
   * `USAGE_CONTINUE_STAGGER_MS`; the others wait their turn, and one held again meanwhile stays held.
   */
  async #continueNext(): Promise<void> {
    if (this.#due.size === 0) return;
    const now = this.#deps.now();
    const wait = this.#lastContinue + USAGE_CONTINUE_STAGGER_MS - now;
    if (wait > 0) {
      this.#dispatchIn(wait);
      return;
    }
    for (const threadId of [...this.#order]) {
      if (!this.#due.has(threadId)) continue;
      const hold = this.#holds.get(threadId);
      if (hold === undefined) {
        this.#due.delete(threadId);
        continue;
      }
      const holding = this.#holding(threadId, hold.providerId, heldFor(hold), now);
      if (holding.length > 0) {
        this.#due.delete(threadId);
        this.#log(threadId, "held_again", hold);
        this.#rehold(threadId, hold, holding);
        continue;
      }
      this.#lastContinue = now;
      await this.#release(threadId, "clear");
      break;
    }
    if (this.#due.size > 0) this.#dispatchIn(USAGE_CONTINUE_STAGGER_MS);
  }

  /** Continues the next due chat in `ms`. */
  #dispatchIn(ms: number): void {
    if (this.#closed || this.#dispatch !== null) return;
    this.#dispatch = this.#deps.timer.setTimeout(() => {
      this.#dispatch = null;
      void this.#queue(() => this.#continueNext());
    }, ms);
  }

  /**
   * Judges the chat again at `at`: a condition expected to end then, or a resume due while the server was down. Chats due
   * at the same moment (one window's reset) are judged together, so the queue's order decides which continues first.
   */
  #schedule(threadId: ThreadId, at: number): void {
    if (this.#closed) return;
    this.#clearTimer(threadId);
    const handle = this.#deps.timer.setTimeout(
      () => {
        this.#timers.delete(threadId);
        const now = this.#deps.now();
        const together = [threadId];
        for (const [id, timer] of this.#timers) if (timer.at <= now) together.push(id);
        for (const id of together) this.#clearTimer(id);
        void this.#queue(() => this.#judge(together));
      },
      Math.max(0, at - this.#deps.now()),
    );
    this.#timers.set(threadId, { handle, at });
  }

  #clearTimer(threadId: ThreadId): void {
    const timer = this.#timers.get(threadId);
    if (timer === undefined) return;
    this.#deps.timer.clearTimeout(timer.handle);
    this.#timers.delete(threadId);
  }

  /** While a rule has hours, every chat is judged each minute, so it pauses as the hours start. */
  #ticking(): void {
    const needed = [...this.#rules.values()].some((rule) => rule.enabled && rule.hours !== null);
    if (!needed || this.#closed) {
      if (this.#tick !== null) this.#deps.timer.clearTimeout(this.#tick);
      this.#tick = null;
      return;
    }
    if (this.#tick !== null) return;
    const now = this.#deps.now();
    this.#tick = this.#deps.timer.setTimeout(
      () => {
        this.#tick = null;
        void this.#queue(() => this.#judge(this.#watchedChats())).then(() => this.#ticking());
      },
      USAGE_RULES_TICK_MS - (now % USAGE_RULES_TICK_MS),
    );
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const next = this.#judging.then(work).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.failed", { error: String(failure) });
    });
    this.#judging = next;
    return next;
  }

  /** Tells the listeners the chat's hold changed, in its folder: its mark's, or the one the server runs it in. */
  #notifyHold(threadId: ThreadId): void {
    const folder = this.#marks.get(threadId)?.folder ?? this.#deps.folderOf?.(threadId);
    if (folder !== undefined) this.#notify(threadId, folder);
  }

  #notify(
    threadId: ThreadId,
    folder: string,
    percent: number | null = this.#marks.get(threadId)?.percent ?? null,
    hold: UsagePauseHold | null = this.#holds.get(threadId) ?? null,
  ): void {
    for (const listener of [...this.#listeners]) listener(threadId, folder, percent, hold);
  }

  /** Writes the marks, rules, holds and hand resumes after the writes before it, so the file holds the last ones. */
  #keep(): void {
    const kept: UsagePauseKept = {
      marks: new Map(this.#marks),
      holds: new Map(this.#holds),
      rules: [...this.#rules.values()],
      overrides: new Map([...this.#overrides].map(([id, reasons]) => [id, new Map(reasons)])),
      order: [...this.#order],
      activity: [...this.#activity],
    };
    this.#saving = this.#saving
      .then(() => this.#deps.save(kept))
      .catch((failure: unknown) => {
        this.#deps.logger?.warn("usage_pause.save_failed", { error: String(failure) });
      });
  }
}

/** A kept hold, or undefined when the file's is not one. */
function keptHold(hold: Record<string, unknown>): UsagePauseHold | undefined {
  const { providerId, until, reason, rule, since } = hold;
  if (typeof providerId !== "string" || providerId.length === 0) return undefined;
  if (until !== null && (typeof until !== "number" || !Number.isFinite(until))) return undefined;
  const reasonOk = UsagePauseReason.safeParse(reason);
  return {
    providerId,
    until: until === null ? null : Math.round(until),
    ...(reasonOk.success ? { reason: reasonOk.data } : {}),
    ...(typeof rule === "string" && rule.length > 0 && rule.length <= 64 ? { rule } : {}),
    ...(typeof since === "number" && Number.isInteger(since) && since >= 0 ? { since } : {}),
  };
}

/**
 * The usage pause's file: `{ "version": 2, "marks": { "<thread id>": { "percent": 95, "folder": "…" } }, "holds":
 * { "<thread id>": { "providerId": "anthropic", "until": <epoch ms or null>, "reason": "five_hour", "rule": "…" } },
 * "rules": [<UsageRule>…], "overrides": { "<thread id>": { "<reason>": <epoch ms> } } }`. A version 1 file (marks and
 * holds only, before the rules) is read as one with no rules.
 */
export function usagePauseFile(path: string): Pick<UsagePauseDeps, "load" | "save"> {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
        throw failure;
      }
      const saved = JSON.parse(text) as {
        readonly version?: unknown;
        readonly marks?: Record<string, { readonly percent?: unknown; readonly folder?: unknown }>;
        readonly holds?: Record<string, Record<string, unknown>>;
        readonly rules?: unknown;
        readonly overrides?: Record<string, Record<string, unknown>>;
        readonly order?: unknown;
        readonly activity?: unknown;
      };
      if (saved.version !== 1 && saved.version !== 2) return EMPTY;
      const marks = new Map<ThreadId, UsagePauseMark>();
      for (const [threadId, mark] of Object.entries(saved.marks ?? {})) {
        const { percent, folder } = mark;
        if (
          typeof percent !== "number" ||
          !Number.isInteger(percent) ||
          percent < 1 ||
          percent > 100
        )
          continue;
        if (typeof folder !== "string" || folder.length === 0) continue;
        marks.set(threadId as ThreadId, { percent, folder });
      }
      const holds = new Map<ThreadId, UsagePauseHold>();
      for (const [threadId, hold] of Object.entries(saved.holds ?? {})) {
        const kept = keptHold(hold);
        if (kept !== undefined) holds.set(threadId as ThreadId, kept);
      }
      const rules = (Array.isArray(saved.rules) ? saved.rules : []).flatMap((rule: unknown) => {
        const parsed = UsageRule.safeParse(rule);
        return parsed.success ? [parsed.data] : [];
      });
      const overrides = new Map<ThreadId, Map<UsagePauseReason, number>>();
      for (const [threadId, reasons] of Object.entries(saved.overrides ?? {})) {
        const kept = new Map<UsagePauseReason, number>();
        for (const [reason, until] of Object.entries(reasons)) {
          const parsed = UsagePauseReason.safeParse(reason);
          if (parsed.success && typeof until === "number" && Number.isFinite(until))
            kept.set(parsed.data, until);
        }
        if (kept.size > 0) overrides.set(threadId as ThreadId, kept);
      }
      const order = (Array.isArray(saved.order) ? saved.order : []).filter(
        (id: unknown): id is ThreadId => typeof id === "string" && holds.has(id as ThreadId),
      );
      const activity = (Array.isArray(saved.activity) ? saved.activity : []).flatMap(
        (entry: unknown) => {
          const parsed = UsageActivityEntry.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        },
      );
      return { marks, holds, rules, overrides, order, activity };
    },
    save: async (kept) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      const file = {
        version: 2,
        marks: Object.fromEntries(kept.marks),
        holds: Object.fromEntries(kept.holds),
        rules: kept.rules,
        overrides: Object.fromEntries(
          [...kept.overrides].map(([id, reasons]) => [id, Object.fromEntries(reasons)]),
        ),
        order: kept.order,
        activity: kept.activity,
      };
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
}

/**
 * The chats' budgets and who each rule pauses (#14), in a file of their own: `{ "version": 1, "budgets": { "<thread>":
 * { "percent", "folder" } }, "scopes": { "<rule>": { "everyChat", "provider" } } }`. Kept apart from the pause's file,
 * so a server from before them reads its own file as it always did.
 */
export function usagePauseExtrasFile(
  path: string,
): Pick<UsagePauseDeps, "loadExtras" | "saveExtras"> {
  return {
    loadExtras: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return NO_EXTRAS;
        throw failure;
      }
      const saved = JSON.parse(text) as {
        readonly version?: unknown;
        readonly budgets?: Record<
          string,
          { readonly percent?: unknown; readonly folder?: unknown }
        >;
        readonly scopes?: Record<string, unknown>;
      };
      if (saved.version !== 1) return NO_EXTRAS;
      const budgets = new Map<ThreadId, UsageBudget>();
      for (const [threadId, { percent, folder }] of Object.entries(saved.budgets ?? {})) {
        if (
          typeof percent !== "number" ||
          !Number.isInteger(percent) ||
          percent < 1 ||
          percent > 100
        )
          continue;
        if (typeof folder !== "string" || folder.length === 0) continue;
        budgets.set(threadId as ThreadId, { percent, folder });
      }
      const scopes = new Map<string, UsageRuleScope>();
      for (const [id, scope] of Object.entries(saved.scopes ?? {})) {
        const parsed = UsageRuleScope.safeParse(scope);
        if (parsed.success) scopes.set(id, parsed.data);
      }
      return { budgets, scopes };
    },
    saveExtras: async ({ budgets, scopes }) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      const file = {
        version: 1,
        budgets: Object.fromEntries(budgets),
        scopes: Object.fromEntries(scopes),
      };
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
}
