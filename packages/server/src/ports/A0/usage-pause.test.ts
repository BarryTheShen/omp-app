import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ThreadId,
  USAGE_BUDGET_HOLD_RULE,
  type UsageActivityEntry,
  type UsageLimitsResult,
  type UsagePaceResult,
  type UsagePauseHold,
  type UsageRule,
} from "@omp-app/contracts";
import type { ProcessTimer } from "../../process/omp-process";
import {
  USAGE_CONTINUE_STAGGER_MS,
  USAGE_PAUSE_AFTER_START_MS,
  USAGE_PAUSE_RESUME_GRACE_MS,
  USAGE_PAUSE_WINDOW_MS,
  type UsageBudget,
  UsagePause,
  type UsagePauseDeps,
  type UsagePauseKept,
  usagePauseExtrasFile,
  usagePauseFile,
} from "./usage-pause";

const A = "01a18633-f642-75c0-b0bd-ad38cbbf851a" as ThreadId;
const B = "01a18633-f642-75c0-b0bd-ad38cbbf851b" as ThreadId;
const C = "01a18633-f642-75c0-b0bd-ad38cbbf851c" as ThreadId;
const FOLDER = "/work/project";
const HOUR = 3_600_000;

/** A clock and timers the test moves by hand. */
class FakeTimer implements ProcessTimer {
  now = 1_790_000_000_000;
  #next = 1;
  readonly timers = new Map<number, { at: number; handler: () => void }>();
  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { at: this.now + delayMs, handler });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Moves the clock on by `ms`, running each timer that comes due, in order, and what it awaits. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].handler();
      await settle();
    }
    this.now = end;
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const NOTHING_KEPT: UsagePauseKept = {
  marks: new Map(),
  holds: new Map(),
  rules: [],
  overrides: new Map(),
  order: [],
  activity: [],
};

/** The test's name for a chat. */
const nameOf = (threadId: ThreadId): string => (threadId === A ? "A" : threadId === B ? "B" : "C");

/** The rules' hours in a time zone with daylight saving: Central time. */
const ZONE = "America/Chicago";

/** The chats that run (and on which provider), which are paused, and every pause and resume sent, in order. */
function setup(
  kept: UsagePauseKept = NOTHING_KEPT,
  pace?: () => UsagePaceResult,
  more: Partial<UsagePauseDeps> = {},
) {
  const timer = new FakeTimer();
  const running = new Map<ThreadId, string>();
  const paused = new Set<ThreadId>();
  const sent: string[] = [];
  const saved: UsagePauseKept[] = [];
  const changes: [ThreadId, number | null, UsagePauseHold | null][] = [];
  const rule = new UsagePause({
    now: () => timer.now,
    timer,
    load: async () => kept,
    save: async (next) => {
      saved.push(next);
    },
    providerOf: async (threadId) => running.get(threadId) ?? null,
    pause: async (threadId) => {
      if (!running.has(threadId)) return false;
      paused.add(threadId);
      sent.push(`pause ${nameOf(threadId)}`);
      return true;
    },
    resume: async (threadId) => {
      if (!running.has(threadId)) return false;
      paused.delete(threadId);
      sent.push(`resume ${nameOf(threadId)}`);
      return true;
    },
    isPaused: (threadId) => paused.has(threadId),
    folderOf: () => FOLDER,
    timeZone: ZONE,
    ...(pace === undefined ? {} : { pace }),
    ...more,
  });
  rule.onChange((threadId, _folder, percent, hold) => changes.push([threadId, percent, hold]));
  return { timer, running, paused, sent, saved, changes, rule };
}

/** A usage read: each provider's 5-hour window (and, if given, its weekly one) at a share, resetting at `resetsAt`. */
function usage(
  providers: Record<
    string,
    { readonly fiveHour: number; readonly weekly?: number; readonly resetsAt?: number | null }
  >,
): UsageLimitsResult {
  return {
    state: "ready",
    fetchedAt: new Date(0).toISOString(),
    providers: Object.entries(providers).map(([providerId, read]) => {
      const resetsAt =
        read.resetsAt === undefined || read.resetsAt === null
          ? null
          : new Date(read.resetsAt).toISOString();
      return {
        providerId,
        windows: [
          {
            label: "5 Hour",
            usedPercent: read.fiveHour,
            resetsAt,
            accounts: 1,
            durationMs: USAGE_PAUSE_WINDOW_MS,
          },
          ...(read.weekly === undefined
            ? []
            : [
                {
                  label: "7 Day",
                  usedPercent: read.weekly,
                  resetsAt,
                  accounts: 1,
                  durationMs: 7 * 24 * HOUR,
                },
              ]),
        ],
      };
    }),
  };
}

describe("usage pause (#2781 part 3)", () => {
  test("a marked chat pauses at its limit and resumes a minute after its window resets", async () => {
    const { timer, running, sent, rule } = setup();
    running.set(A, "anthropic");
    await rule.setMark(A, FOLDER, 95);
    const reset = timer.now + 2 * HOUR;

    await rule.onUsage(usage({ anthropic: { fiveHour: 94.9, resetsAt: reset } }));
    expect(sent).toEqual([]);
    await rule.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);
    expect(rule.marksIn(FOLDER)).toEqual([
      {
        id: A,
        percent: 95,
        hold: {
          providerId: "anthropic",
          until: reset + USAGE_PAUSE_RESUME_GRACE_MS,
          reason: "five_hour",
          since: timer.now,
        },
      },
    ]);

    // Still at the limit before the reset: nothing more.
    await rule.onUsage(usage({ anthropic: { fiveHour: 99, resetsAt: reset } }));
    await timer.advance(2 * HOUR);
    expect(sent).toEqual(["pause A"]);
    await timer.advance(USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "resume A"]);
    expect(rule.marksIn(FOLDER)).toEqual([{ id: A, percent: 95, hold: null }]);
  });

  test("only marked chats pause, each at its own limit, on its own provider's 5-hour window", async () => {
    const { running, sent, rule } = setup();
    running.set(A, "anthropic");
    running.set(B, "openai-codex");
    await rule.setMark(A, FOLDER, 80);

    // B is not marked: it runs on at 100%. The weekly window at 99% never pauses anything.
    await rule.onUsage(
      usage({ anthropic: { fiveHour: 79, weekly: 99 }, "openai-codex": { fiveHour: 100 } }),
    );
    expect(sent).toEqual([]);

    // Anthropic at 97% holds A (80%); B, marked at 95% after this read, runs on OpenAI at 90% and is left running.
    await rule.onUsage(usage({ anthropic: { fiveHour: 97 }, "openai-codex": { fiveHour: 90 } }));
    await rule.setMark(B, FOLDER, 95);
    expect(sent).toEqual(["pause A"]);
    // OpenAI reaching 96% passes B's own 95%.
    await rule.onUsage(usage({ anthropic: { fiveHour: 97 }, "openai-codex": { fiveHour: 96 } }));
    expect(sent).toEqual(["pause A", "pause B"]);
  });

  test("a chat the reader paused or resumed stays as the reader left it", async () => {
    const { timer, running, paused, sent, rule } = setup();
    running.set(A, "anthropic");
    running.set(B, "anthropic");
    await rule.setMark(A, FOLDER, 90);
    await rule.setMark(B, FOLDER, 90);
    paused.add(B);
    const reset = timer.now + HOUR;

    await rule.onUsage(usage({ anthropic: { fiveHour: 92, resetsAt: reset } }));
    // B was paused already: no hold on it, so the reset doesn't resume it either.
    expect(sent).toEqual(["pause A"]);

    // The reader resumes A before the reset: the rule lets it run, and the reset sends nothing.
    paused.delete(A);
    rule.onPauseChanged(A, null);
    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A"]);
    expect(paused.has(B)).toBe(true);
  });

  test("a read under the chat's limit again ends a hold that has no reset time", async () => {
    const { timer, running, sent, rule } = setup();
    running.set(A, "anthropic");
    await rule.setMark(A, FOLDER, 95);
    await rule.onUsage(usage({ anthropic: { fiveHour: 97, resetsAt: null } }));
    expect(rule.marksIn(FOLDER)[0]?.hold).toEqual({
      providerId: "anthropic",
      until: null,
      reason: "five_hour",
      since: timer.now,
    });

    await rule.onUsage(usage({ anthropic: { fiveHour: 96 } }));
    expect(sent).toEqual(["pause A"]);
    await rule.onUsage(usage({ anthropic: { fiveHour: 3 } }));
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("a changed limit is judged at once against the last read; unmarking a held chat resumes it", async () => {
    const { running, sent, rule } = setup();
    running.set(A, "anthropic");
    await rule.setMark(A, FOLDER, 95);
    await rule.onUsage(usage({ anthropic: { fiveHour: 90 } }));
    expect(sent).toEqual([]);

    await rule.setMark(A, FOLDER, 85);
    expect(sent).toEqual(["pause A"]);
    await rule.setMark(A, FOLDER, 99);
    expect(sent).toEqual(["pause A", "resume A"]);

    await rule.setMark(A, FOLDER, 50);
    expect(sent).toEqual(["pause A", "resume A", "pause A"]);
    await rule.setMark(A, FOLDER, null);
    expect(sent).toEqual(["pause A", "resume A", "pause A", "resume A"]);
    expect(rule.marksIn(FOLDER)).toEqual([]);
  });

  test("a chat whose omp is not running is not held; it pauses at the first read after it starts", async () => {
    const { running, sent, rule } = setup();
    await rule.setMark(A, FOLDER, 95);
    await rule.onUsage(usage({ anthropic: { fiveHour: 98 } }));
    expect(sent).toEqual([]);
    expect(rule.marksIn(FOLDER)[0]?.hold).toBeNull();

    running.set(A, "anthropic");
    await rule.onUsage(usage({ anthropic: { fiveHour: 98 } }));
    expect(sent).toEqual(["pause A"]);
  });

  test("a chat moved to its new id keeps its mark and its hold", async () => {
    const { timer, running, sent, changes, rule } = setup();
    running.set(A, "anthropic");
    await rule.setMark(A, FOLDER, 90);
    const reset = timer.now + HOUR;
    await rule.onUsage(usage({ anthropic: { fiveHour: 91, resetsAt: reset } }));

    running.delete(A);
    running.set(B, "anthropic");
    rule.move(A, B);
    expect(rule.marksIn(FOLDER)).toEqual([
      {
        id: B,
        percent: 90,
        hold: {
          providerId: "anthropic",
          until: reset + USAGE_PAUSE_RESUME_GRACE_MS,
          reason: "five_hour",
          since: timer.now,
        },
      },
    ]);
    expect(changes.slice(-2)).toEqual([
      [A, null, null],
      [
        B,
        90,
        {
          providerId: "anthropic",
          until: reset + USAGE_PAUSE_RESUME_GRACE_MS,
          reason: "five_hour",
          since: timer.now,
        },
      ],
    ]);
    // The moved chat is not paused in this fake: the reset sends nothing for it.
    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A"]);
  });

  test("marks and holds outlive a restart; a resume that fell due meanwhile runs once the hosts are back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-pause-"));
    try {
      const file = usagePauseFile(join(directory, "usage-pause.json"));
      const first = setup();
      first.running.set(A, "anthropic");
      first.running.set(B, "anthropic");
      await first.rule.setMark(A, FOLDER, 90);
      await first.rule.setMark(B, FOLDER, 95);
      const reset = first.timer.now + HOUR;
      await first.rule.onUsage(usage({ anthropic: { fiveHour: 92, resetsAt: reset } }));
      expect(first.sent).toEqual(["pause A"]);
      const last = first.saved.at(-1);
      if (last === undefined) throw new Error("nothing was saved");
      await file.save(last);
      first.rule.close();

      const text = await readFile(join(directory, "usage-pause.json"), "utf8");
      expect(JSON.parse(text)).toEqual({
        version: 2,
        marks: { [A]: { percent: 90, folder: FOLDER }, [B]: { percent: 95, folder: FOLDER } },
        holds: {
          [A]: {
            providerId: "anthropic",
            until: reset + USAGE_PAUSE_RESUME_GRACE_MS,
            reason: "five_hour",
            since: first.timer.now,
          },
        },
        rules: [],
        overrides: {},
        order: [A],
        activity: [
          { at: first.timer.now, id: A, action: "paused", reason: "five_hour", rule: null },
        ],
      });

      // The server is back two hours later: A's resume fell due while it was down.
      const second = setup(await file.load());
      second.timer.now = first.timer.now + 2 * HOUR;
      second.running.set(A, "anthropic");
      second.paused.add(A);
      await second.rule.restore();
      expect(second.rule.marksIn(FOLDER).map((mark) => mark.id)).toEqual([A, B]);
      await second.timer.advance(USAGE_PAUSE_AFTER_START_MS - 1);
      expect(second.sent).toEqual([]);
      await second.timer.advance(1);
      expect(second.sent).toEqual(["resume A"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** A rule for `chats` with the given conditions, the rest unused. */
function rule(chats: readonly ThreadId[], conditions: Partial<UsageRule>): UsageRule {
  return {
    id: "night",
    name: "Night work",
    chats: [...chats],
    fiveHourAt: null,
    weeklyAt: null,
    paceAt: null,
    hours: null,
    enabled: true,
    ...conditions,
  };
}

/** The pace of anthropic's 5-hour window: how full it would be at its reset, as the server's readings say. */
function paceOf(atReset: () => number | null): () => UsagePaceResult {
  return () => ({
    windows: [
      {
        providerId: "anthropic",
        label: "5 Hour",
        perHour: 20,
        fullAt: null,
        atReset: atReset(),
        readings: 12,
      },
    ],
  });
}

const MINUTE = 60_000;

describe("usage rules (#2836)", () => {
  test("a rule's hours pause its chats when they start and continue them when they end, past midnight", async () => {
    const { timer, running, sent, rule: pause } = setup();
    // Friday 6 November 2026, 22:58 in Chicago.
    timer.now = Date.UTC(2026, 10, 7, 4, 58);
    running.set(A, "anthropic");
    await pause.setRule(rule([A], { hours: { from: "23:00", to: "08:00" } }));
    expect(sent).toEqual([]);

    await timer.advance(2 * MINUTE);
    expect(sent).toEqual(["pause A"]);
    const eight = Date.UTC(2026, 10, 7, 14, 0);
    expect(pause.rules()[0]?.held).toEqual([{ id: A, reason: "hours", until: eight }]);

    await timer.advance(eight - timer.now - 1);
    expect(sent).toEqual(["pause A"]);
    await timer.advance(1);
    expect(sent).toEqual(["pause A", "resume A"]);
    expect(pause.rules()[0]?.held).toEqual([]);
  });

  test("a rule pauses at its percent of the weekly window and continues a minute after the window resets", async () => {
    const { timer, running, sent, rule: pause } = setup();
    running.set(A, "anthropic");
    await pause.setRule(rule([A], { weeklyAt: 90 }));
    const reset = timer.now + 3 * HOUR;

    await pause.onUsage(usage({ anthropic: { fiveHour: 10, weekly: 89, resetsAt: reset } }));
    expect(sent).toEqual([]);
    await pause.onUsage(usage({ anthropic: { fiveHour: 10, weekly: 91, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);
    expect(pause.rules()[0]?.held).toEqual([
      { id: A, reason: "weekly", until: reset + USAGE_PAUSE_RESUME_GRACE_MS },
    ]);

    await timer.advance(3 * HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("a rule's pace pauses a chat heading past its percent, and continues it only 5 points under", async () => {
    let atReset: number | null = 92;
    const {
      timer,
      running,
      sent,
      rule: pause,
    } = setup(
      NOTHING_KEPT,
      paceOf(() => atReset),
    );
    running.set(A, "anthropic");
    await pause.setRule(rule([A], { paceAt: 80 }));
    const reset = timer.now + 2 * HOUR;

    await pause.onUsage(usage({ anthropic: { fiveHour: 50, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);
    expect(pause.rules()[0]?.held).toEqual([
      { id: A, reason: "pace", until: reset + USAGE_PAUSE_RESUME_GRACE_MS },
    ]);

    // Under 80 but not 5 under: it stays held, so it does not pause and continue on every reading.
    atReset = 78;
    await pause.onUsage(usage({ anthropic: { fiveHour: 51, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);
    atReset = 74;
    await pause.onUsage(usage({ anthropic: { fiveHour: 51, resetsAt: reset } }));
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("a stale reading continues nothing: a chat held for its pace waits for a fresh one", async () => {
    let atReset: number | null = 92;
    const {
      timer,
      running,
      sent,
      rule: pause,
    } = setup(
      NOTHING_KEPT,
      paceOf(() => atReset),
    );
    running.set(A, "anthropic");
    const reset = timer.now + 4 * HOUR;
    await pause.onUsage(usage({ anthropic: { fiveHour: 50, resetsAt: reset } }));
    await pause.setRule(rule([A], { paceAt: 80 }));
    expect(sent).toEqual(["pause A"]);

    // Twenty minutes without a reading, and the pace's hour of readings has run out: no pace, but nothing fresh.
    await timer.advance(20 * MINUTE);
    atReset = null;
    await pause.setRule(rule([A], { paceAt: 80, name: "Night work, renamed" }));
    expect(sent).toEqual(["pause A"]);
    atReset = 60;
    await pause.onUsage(usage({ anthropic: { fiveHour: 52, resetsAt: reset } }));
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("a chat resumed by hand while over its limit is not paused again until its window resets", async () => {
    const { timer, running, paused, sent, rule: pause } = setup();
    running.set(A, "anthropic");
    await pause.setMark(A, FOLDER, 90);
    const reset = timer.now + HOUR;
    await pause.onUsage(usage({ anthropic: { fiveHour: 92, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);

    paused.delete(A);
    pause.onPauseChanged(A, null);
    await pause.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);

    // The next window reaching the limit pauses it again.
    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    await pause.onUsage(usage({ anthropic: { fiveHour: 93, resetsAt: timer.now + 5 * HOUR } }));
    expect(sent).toEqual(["pause A", "pause A"]);
  });

  test("a disabled or removed rule continues the chats it held; enabled again, it holds them again", async () => {
    const { timer, running, sent, rule: pause } = setup();
    // 10:00 in Chicago, inside the rule's day hours.
    timer.now = Date.UTC(2026, 10, 6, 16, 0);
    running.set(A, "anthropic");
    running.set(B, "anthropic");
    const day = rule([A, B], { hours: { from: "08:00", to: "23:00" } });
    await pause.setRule(day);
    expect(sent).toEqual(["pause A", "pause B"]);

    await pause.setRule({ ...day, enabled: false });
    expect(sent).toEqual(["pause A", "pause B", "resume A", "resume B"]);
    await pause.setRule({ ...day, chats: [B] });
    expect(sent).toEqual(["pause A", "pause B", "resume A", "resume B", "pause B"]);
    await pause.removeRule(day.id);
    expect(sent).toEqual(["pause A", "pause B", "resume A", "resume B", "pause B", "resume B"]);
    expect(pause.rules()).toEqual([]);
  });

  test("rules, holds and hand resumes outlive a restart, and a file from before the rules still loads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-rules-"));
    try {
      const path = join(directory, "usage-pause.json");
      const file = usagePauseFile(path);
      const first = setup();
      first.timer.now = Date.UTC(2026, 10, 6, 16, 0);
      first.running.set(A, "anthropic");
      first.running.set(B, "anthropic");
      const day = rule([A, B], { hours: { from: "08:00", to: "23:00" } });
      await first.rule.setRule(day);
      first.paused.delete(B);
      first.rule.onPauseChanged(B, null);
      await settle();
      const last = first.saved.at(-1);
      if (last === undefined) throw new Error("nothing was saved");
      await file.save(last);
      first.rule.close();

      const kept = await file.load();
      expect(kept.rules).toEqual([day]);
      const eleven = Date.UTC(2026, 10, 7, 5, 0);
      expect([...kept.holds]).toEqual([
        [
          A,
          {
            providerId: "anthropic",
            until: eleven,
            reason: "hours",
            rule: "night",
            since: Date.UTC(2026, 10, 6, 16, 0),
          },
        ],
      ]);
      expect([...kept.overrides].map(([id, reasons]) => [id, [...reasons]])).toEqual([
        [B, [["hours", eleven]]],
      ]);

      await Bun.write(
        path,
        JSON.stringify({
          version: 1,
          marks: { [A]: { percent: 90, folder: FOLDER } },
          holds: { [A]: { providerId: "anthropic", until: null } },
        }),
      );
      const before = await file.load();
      expect([...before.marks]).toEqual([[A, { percent: 90, folder: FOLDER }]]);
      expect([...before.holds]).toEqual([[A, { providerId: "anthropic", until: null }]]);
      expect(before.rules).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("the usage queue (#2836)", () => {
  test("after a reset, held chats continue one at a time, three minutes apart, in the queue's order", async () => {
    const { timer, running, sent, rule: pause } = setup();
    for (const id of [A, B]) {
      running.set(id, "anthropic");
      await pause.setMark(id, FOLDER, 90);
    }
    const reset = timer.now + HOUR;
    await pause.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: reset } }));
    expect(sent).toEqual(["pause A", "pause B"]);
    await pause.setOrder([B, A]);
    expect(pause.queue().map(({ id, continuesAt }) => [id, continuesAt])).toEqual([
      [B, null],
      [A, null],
    ]);

    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "pause B", "resume B"]);
    expect(pause.queue().map(({ id, continuesAt }) => [id, continuesAt])).toEqual([
      [A, timer.now + USAGE_CONTINUE_STAGGER_MS],
    ]);
    await timer.advance(USAGE_CONTINUE_STAGGER_MS - 1);
    expect(sent).toEqual(["pause A", "pause B", "resume B"]);
    await timer.advance(1);
    expect(sent).toEqual(["pause A", "pause B", "resume B", "resume A"]);
    expect(pause.queue()).toEqual([]);
  });

  test("a chat waiting for its turn that the new window holds again stays held", async () => {
    const { timer, running, sent, rule: pause } = setup();
    for (const id of [A, B]) {
      running.set(id, "anthropic");
      await pause.setMark(id, FOLDER, 90);
    }
    const reset = timer.now + HOUR;
    await pause.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: reset } }));
    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "pause B", "resume A"]);

    // A used the new window up before B's turn.
    await pause.onUsage(usage({ anthropic: { fiveHour: 91, resetsAt: timer.now + 5 * HOUR } }));
    await timer.advance(USAGE_CONTINUE_STAGGER_MS);
    expect(sent).toEqual(["pause A", "pause B", "resume A", "pause A"]);
    expect(pause.queue().map(({ id, continuesAt }) => [id, continuesAt])).toEqual([
      [B, null],
      [A, null],
    ]);
  });

  test("Continue now continues a held chat out of its turn; Skip leaves it paused and the rules let it be", async () => {
    const { timer, running, paused, sent, rule: pause } = setup();
    for (const id of [A, B, C]) {
      running.set(id, "anthropic");
      await pause.setMark(id, FOLDER, 90);
    }
    const reset = timer.now + HOUR;
    await pause.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: reset } }));
    expect(sent).toEqual(["pause A", "pause B", "pause C"]);

    await pause.continueNow(B);
    await pause.skip(C);
    expect(sent).toEqual(["pause A", "pause B", "pause C", "resume B"]);
    expect(paused.has(C)).toBe(true);
    expect(pause.queue().map(({ id }) => id)).toEqual([A]);
    // Still over the limit: B was continued by hand and C is the reader's now; neither is paused or held again.
    await pause.onUsage(usage({ anthropic: { fiveHour: 97, resetsAt: reset } }));
    await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "pause B", "pause C", "resume B", "resume A"]);
    expect(paused.has(C)).toBe(true);
  });

  test("the activity says what the pause did, newest first, with what held each chat, and outlives a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-activity-"));
    try {
      const file = usagePauseFile(join(directory, "usage-pause.json"));
      const { timer, running, paused, saved, rule: pause } = setup();
      for (const id of [A, B, C]) {
        running.set(id, "anthropic");
        await pause.setMark(id, FOLDER, 90);
      }
      const start = timer.now;
      await pause.onUsage(usage({ anthropic: { fiveHour: 95, resetsAt: start + HOUR } }));
      await pause.continueNow(A);
      await pause.skip(B);
      await timer.advance(HOUR + USAGE_PAUSE_RESUME_GRACE_MS);
      const reset = timer.now;
      // A minute into the new window the chats running are over the limit again; C is resumed by hand.
      await timer.advance(60_000);
      const again = timer.now;
      await pause.onUsage(usage({ anthropic: { fiveHour: 92, resetsAt: again + 5 * HOUR } }));
      paused.delete(C);
      pause.onPauseChanged(C, null);
      await settle();

      const five = { reason: "five_hour", rule: null } as const;
      const activity: UsageActivityEntry[] = [
        { at: again, id: C, action: "resumed_by_hand", ...five },
        { at: again, id: C, action: "paused", ...five },
        { at: again, id: A, action: "paused", ...five },
        { at: reset, id: C, action: "continued", ...five },
        { at: start, id: B, action: "skipped", ...five },
        { at: start, id: A, action: "continued_now", ...five },
        { at: start, id: C, action: "paused", ...five },
        { at: start, id: B, action: "paused", ...five },
        { at: start, id: A, action: "paused", ...five },
      ];
      expect(pause.activity()).toEqual(activity);
      // A's hold, newer than its first, began when it was paused again.
      expect(pause.queue().map(({ id, hold }) => [id, hold.since])).toEqual([[A, again]]);

      const last = saved.at(-1);
      if (last === undefined) throw new Error("nothing was saved");
      await file.save(last);
      pause.close();
      const second = setup(await file.load());
      await second.rule.restore();
      expect(second.rule.activity()).toEqual(activity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the activity keeps the last 200 things", async () => {
    const old = Array.from({ length: 200 }, (_, at) => ({
      at,
      id: A,
      action: "paused" as const,
      reason: "five_hour" as const,
      rule: null,
    }));
    const { timer, running, rule: pause } = setup({ ...NOTHING_KEPT, activity: old });
    await pause.restore();
    running.set(B, "anthropic");
    await pause.setMark(B, FOLDER, 90);
    await pause.onUsage(usage({ anthropic: { fiveHour: 95 } }));

    const activity = pause.activity();
    expect(activity).toHaveLength(200);
    expect(activity[0]).toEqual({
      at: timer.now,
      id: B,
      action: "paused",
      reason: "five_hour",
      rule: null,
    });
    // The oldest went.
    expect(activity.at(-1)?.at).toBe(1);
  });
});

describe("a chat's own budget (#14)", () => {
  test("a chat pauses once its own part of the window reaches its budget, and continues a minute after the reset", async () => {
    const parts = new Map<ThreadId, number>();
    const { timer, running, sent, rule } = setup(NOTHING_KEPT, undefined, {
      shareOf: (threadId) => parts.get(threadId) ?? null,
    });
    running.set(A, "anthropic");
    running.set(B, "anthropic");
    await rule.setBudget(A, FOLDER, 40);
    const reset = timer.now + 2 * HOUR;

    // The window is at 70%; A's own part is 39%, under its budget. B has no budget: its part never pauses it.
    parts.set(A, 39);
    parts.set(B, 31);
    await rule.onUsage(usage({ anthropic: { fiveHour: 70, resetsAt: reset } }));
    expect(sent).toEqual([]);
    parts.set(A, 40);
    await rule.onUsage(usage({ anthropic: { fiveHour: 72, resetsAt: reset } }));
    expect(sent).toEqual(["pause A"]);
    expect(rule.queue()).toEqual([
      {
        id: A,
        hold: {
          providerId: "anthropic",
          until: reset + USAGE_PAUSE_RESUME_GRACE_MS,
          reason: "five_hour",
          rule: USAGE_BUDGET_HOLD_RULE,
          since: timer.now,
        },
        continuesAt: null,
      },
    ]);

    await timer.advance(2 * HOUR);
    expect(sent).toEqual(["pause A"]);
    await timer.advance(USAGE_PAUSE_RESUME_GRACE_MS);
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("a budget set under the chat's part pauses it at once; removing the budget continues it", async () => {
    const parts = new Map<ThreadId, number>([[A, 50]]);
    const { timer, running, sent, rule } = setup(NOTHING_KEPT, undefined, {
      shareOf: (threadId) => parts.get(threadId) ?? null,
    });
    running.set(A, "anthropic");
    await rule.onUsage(usage({ anthropic: { fiveHour: 60, resetsAt: timer.now + HOUR } }));
    await rule.setBudget(A, FOLDER, 60);
    expect(sent).toEqual([]);
    await rule.setBudget(A, FOLDER, 45);
    expect(sent).toEqual(["pause A"]);
    await rule.setBudget(A, FOLDER, null);
    expect(sent).toEqual(["pause A", "resume A"]);
  });

  test("budgets and rules' scopes are kept in a file of their own and outlive a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-app-usage-extras-"));
    try {
      const path = join(dir, "usage-pause-extras.json");
      const first = setup(NOTHING_KEPT, undefined, usagePauseExtrasFile(path));
      await first.rule.restore();
      await first.rule.setBudget(A, FOLDER, 40);
      await first.rule.setRuleScope("all-anthropic", { everyChat: true, provider: "anthropic" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        version: 1,
        budgets: { [A]: { percent: 40, folder: FOLDER } },
        scopes: { "all-anthropic": { everyChat: true, provider: "anthropic" } },
      });

      const again = setup(NOTHING_KEPT, undefined, usagePauseExtrasFile(path));
      await again.rule.restore();
      const kept: [ThreadId, UsageBudget][] = [[A, { percent: 40, folder: FOLDER }]];
      expect([...again.rule.budgets()]).toEqual(kept);
      expect([...again.rule.scopes()]).toEqual([
        ["all-anthropic", { everyChat: true, provider: "anthropic" }],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a rule for every chat (#14)", () => {
  const everyChat = (id: string, fiveHourAt: number): UsageRule => ({
    id,
    name: id,
    chats: [],
    fiveHourAt,
    weeklyAt: null,
    paceAt: null,
    hours: null,
    enabled: true,
  });

  test("a rule for every chat on one provider pauses each running chat on it, one started later too, and none on another", async () => {
    const live: ThreadId[] = [A, B];
    const { timer, running, sent, rule } = setup(NOTHING_KEPT, undefined, { chats: () => live });
    running.set(A, "anthropic");
    running.set(B, "openai-codex");
    await rule.setRule(everyChat("all-anthropic", 90));
    await rule.setRuleScope("all-anthropic", { everyChat: true, provider: "anthropic" });
    const reset = timer.now + HOUR;
    const read = (anthropic: number) =>
      usage({
        anthropic: { fiveHour: anthropic, resetsAt: reset },
        "openai-codex": { fiveHour: 99, resetsAt: reset },
      });

    await rule.onUsage(read(89));
    expect(sent).toEqual([]);
    await rule.onUsage(read(90));
    expect(sent).toEqual(["pause A"]);
    // C starts later on anthropic: the next reading pauses it too.
    running.set(C, "anthropic");
    live.push(C);
    await rule.onUsage(read(91));
    expect(sent).toEqual(["pause A", "pause C"]);

    // Back to the chats it lists, which are none: both go on at once.
    await rule.setRuleScope("all-anthropic", { everyChat: false, provider: null });
    expect(sent).toEqual(["pause A", "pause C", "resume A", "resume C"]);
    expect([...rule.scopes()]).toEqual([]);
  });

  test("removing a rule for every chat continues the chats it held and forgets its scope", async () => {
    const { timer, running, sent, rule } = setup(NOTHING_KEPT, undefined, { chats: () => [A] });
    running.set(A, "anthropic");
    await rule.setRule(everyChat("all", 50));
    await rule.setRuleScope("all", { everyChat: true, provider: null });
    await rule.onUsage(usage({ anthropic: { fiveHour: 60, resetsAt: timer.now + HOUR } }));
    expect(sent).toEqual(["pause A"]);
    await rule.removeRule("all");
    expect(sent).toEqual(["pause A", "resume A"]);
    expect([...rule.scopes()]).toEqual([]);
  });
});
