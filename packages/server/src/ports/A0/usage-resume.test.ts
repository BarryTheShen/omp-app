import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadId } from "@omp-app/contracts";
import type { ChatEvent } from "@omp-app/contracts/chat-host";
import type { ProcessTimer } from "../../process/omp-process";
import {
  RESUME_AFTER_START_MS,
  RESUME_GRACE_MS,
  RESUME_MOST_IN_ROW,
  type ResumeOutcome,
  UsageResume,
  usageResumeFile,
} from "./usage-resume";

const CHAT = "01a18633-f642-75c0-b0bd-ad38cbbf851a" as ThreadId;
const HOURS = 3_600_000;

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
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.now = end;
  }
}

function setup(outcome: ResumeOutcome = "sent", kept = new Map<ThreadId, number>()) {
  const timer = new FakeTimer();
  const resumed: ThreadId[] = [];
  const saved: Map<ThreadId, number>[] = [];
  const resume = new UsageResume({
    now: () => timer.now,
    timer,
    load: async () => kept,
    save: async (schedule) => {
      saved.push(new Map(schedule));
    },
    resume: async (threadId) => {
      resumed.push(threadId);
      return outcome;
    },
  });
  return { timer, resume, resumed, saved };
}

const waitStart = (delayMs: number): ChatEvent =>
  ({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs,
    errorMessage: "429 rate_limit_error",
  }) as unknown as ChatEvent;
const run = { type: "agent_start" } as unknown as ChatEvent;
const reply = (stopReason: "stop" | "error", errorMessage?: string): ChatEvent =>
  ({
    type: "message_end",
    messageId: "m",
    message: {
      role: "assistant",
      content: [],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  }) as unknown as ChatEvent;

describe("the app's own retry after a usage limit (#2781)", () => {
  test("after omp's long wait, the chat is retried once, a minute past the wait, when omp did not continue it", async () => {
    const { timer, resume, resumed } = setup();
    resume.onEvent(CHAT, waitStart(2.6 * HOURS));
    expect(resume.isWaiting(CHAT)).toBe(true);
    await timer.advance(2.6 * HOURS + RESUME_GRACE_MS - 1);
    expect(resumed).toEqual([]);
    await timer.advance(1);
    expect(resumed).toEqual([CHAT]);
    expect(resume.isWaiting(CHAT)).toBe(false);
    await timer.advance(10 * HOURS);
    expect(resumed).toEqual([CHAT]);
  });

  test("a run before then (omp's own retry, or a message sent) takes the place of the app's retry", async () => {
    const { timer, resume, resumed } = setup();
    resume.onEvent(CHAT, waitStart(2 * HOURS));
    await timer.advance(2 * HOURS);
    resume.onEvent(CHAT, run);
    await timer.advance(RESUME_GRACE_MS + HOURS);
    expect(resumed).toEqual([]);
  });

  test("omp's quick retries, under a minute apart, are omp's alone", async () => {
    const { timer, resume, resumed } = setup();
    resume.onEvent(CHAT, waitStart(8_000));
    expect(resume.isWaiting(CHAT)).toBe(false);
    await timer.advance(HOURS);
    expect(resumed).toEqual([]);
  });

  test("a turn refused with the provider's wait in its error, and no retry of omp's, is retried after that wait", async () => {
    const { timer, resume, resumed } = setup();
    resume.onEvent(CHAT, reply("error", "429 {} retry-after-ms=9385000"));
    await timer.advance(9_385_000 + RESUME_GRACE_MS);
    expect(resumed).toEqual([CHAT]);
  });

  test("Stop drops the app's retry", async () => {
    const { timer, resume, resumed } = setup();
    resume.onEvent(CHAT, waitStart(HOURS));
    resume.cancel(CHAT);
    await timer.advance(2 * HOURS);
    expect(resumed).toEqual([]);
  });

  test("an error that outlives every reset is retried three times in a row at most; a good turn starts the count again", async () => {
    const { timer, resume, resumed } = setup();
    for (let round = 0; round < RESUME_MOST_IN_ROW + 1; round += 1) {
      resume.onEvent(CHAT, waitStart(HOURS));
      await timer.advance(HOURS + RESUME_GRACE_MS);
      resume.onEvent(CHAT, run);
      resume.onEvent(CHAT, reply("error", "429 still refused"));
    }
    expect(resumed).toHaveLength(RESUME_MOST_IN_ROW);
    resume.onEvent(CHAT, reply("stop"));
    resume.onEvent(CHAT, waitStart(HOURS));
    await timer.advance(HOURS + RESUME_GRACE_MS);
    expect(resumed).toHaveLength(RESUME_MOST_IN_ROW + 1);
  });

  test("the schedule outlives a restart: one still ahead runs on time, one already due runs shortly after the start", async () => {
    const later = new FakeTimer().now + 2 * HOURS;
    const { timer, resume, resumed } = setup("sent", new Map([[CHAT, later]]));
    await resume.restore();
    await timer.advance(2 * HOURS - 1);
    expect(resumed).toEqual([]);
    await timer.advance(1);
    expect(resumed).toEqual([CHAT]);

    const overdue = setup("sent", new Map([[CHAT, 0]]));
    await overdue.resume.restore();
    await overdue.timer.advance(RESUME_AFTER_START_MS - 1);
    expect(overdue.resumed).toEqual([]);
    await overdue.timer.advance(1);
    expect(overdue.resumed).toEqual([CHAT]);
  });

  test("the schedule's file keeps what is due and reads back the same", async () => {
    const folder = join(process.cwd(), ".data", `usage-resume-${crypto.randomUUID()}`);
    try {
      const file = usageResumeFile(join(folder, "usage-resume.json"));
      expect(await file.load()).toEqual(new Map());
      await file.save(new Map([[CHAT, 1_790_000_123_456]]));
      expect(await file.load()).toEqual(new Map([[CHAT, 1_790_000_123_456]]));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
