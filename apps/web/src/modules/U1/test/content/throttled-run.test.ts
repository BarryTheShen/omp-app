import { describe, expect, test } from "vitest";
import { createThrottledRun, type ThrottledRunOptions } from "../../markdown/throttled-run";

interface Timer {
  readonly id: number;
  readonly due: number;
  readonly callback: () => void;
}

interface FakeClock {
  readonly now: () => number;
  readonly setTimer: ThrottledRunOptions<string>["setTimer"];
  readonly clearTimer: ThrottledRunOptions<string>["clearTimer"];
  /** Moves time forward, running every timer that comes due on the way, in order. */
  readonly advance: (ms: number) => void;
}

/** A clock that only moves when a test advances it, so the timing is exact and no test waits for real time. */
function fakeClock(): FakeClock {
  let time = 0;
  let nextId = 1;
  let timers: Timer[] = [];
  const earliestDue = (end: number): Timer | undefined =>
    timers.reduce<Timer | undefined>(
      (earliest, timer) =>
        timer.due <= end && (earliest === undefined || timer.due < earliest.due) ? timer : earliest,
      undefined,
    );
  return {
    now: () => time,
    setTimer(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers = [...timers, { id, due: time + delayMs, callback }];
      return id;
    },
    clearTimer(id) {
      timers = timers.filter((timer) => timer.id !== id);
    },
    advance(ms) {
      const end = time + ms;
      for (let next = earliestDue(end); next !== undefined; next = earliestDue(end)) {
        time = next.due;
        const { id, callback } = next;
        timers = timers.filter((timer) => timer.id !== id);
        callback();
      }
      time = end;
    },
  };
}

function recorder(clock: FakeClock) {
  const runs: { readonly value: string; readonly at: number }[] = [];
  const scheduler = createThrottledRun<string>({
    intervalMs: 150,
    run: (value) => {
      runs.push({ value, at: clock.now() });
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { runs, scheduler };
}

describe("createThrottledRun", () => {
  test("a first request runs as soon as its turn comes", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);

    scheduler.request("a");
    expect(runs).toEqual([]);

    clock.advance(0);
    expect(runs).toEqual([{ value: "a", at: 0 }]);
  });

  test("requests inside one interval share one run, which uses the newest value", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);
    scheduler.request("a");
    clock.advance(0);

    clock.advance(40);
    scheduler.request("b");
    clock.advance(50);
    scheduler.request("c");

    clock.advance(59);
    expect(runs.map((run) => run.value)).toEqual(["a"]);
    clock.advance(1);
    expect(runs).toEqual([
      { value: "a", at: 0 },
      { value: "c", at: 150 },
    ]);
  });

  test("never runs twice inside one interval", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);
    scheduler.request("a");
    clock.advance(0);

    clock.advance(10);
    scheduler.request("b");
    clock.advance(10);
    scheduler.request("c");
    clock.advance(10);
    scheduler.request("d");
    clock.advance(1000);

    expect(runs.map((run) => run.at)).toEqual([0, 150]);
    expect(runs.at(-1)?.value).toBe("d");
  });

  test("a request after a quiet gap longer than the interval runs straight away", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);
    scheduler.request("a");
    clock.advance(0);

    clock.advance(1000);
    scheduler.request("b");
    clock.advance(0);

    expect(runs).toEqual([
      { value: "a", at: 0 },
      { value: "b", at: 1000 },
    ]);
  });

  test("cancel drops a run that is waiting for its turn", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);
    scheduler.request("a");
    scheduler.cancel();

    clock.advance(1000);
    expect(runs).toEqual([]);
  });

  test("after a cancel, the next request still runs", () => {
    const clock = fakeClock();
    const { runs, scheduler } = recorder(clock);
    scheduler.request("a");
    clock.advance(0);
    scheduler.request("b");
    scheduler.cancel();

    scheduler.request("c");
    clock.advance(1000);

    expect(runs.map((run) => run.value)).toEqual(["a", "c"]);
  });
});

/** Lets a finished run's promise reach the scheduler, which hears about the end on a later microtask. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createThrottledRun when a run takes time", () => {
  test("the next run waits for the interval after the previous run ends, not after it starts", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const scheduler = createThrottledRun<string>({
      intervalMs: 150,
      run: () => {
        starts.push(clock.now());
        const { promise, resolve } = Promise.withResolvers<void>();
        clock.setTimer(resolve, 400);
        return promise;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.request("a");
    clock.advance(100);
    scheduler.request("b");
    clock.advance(300);
    await settle();

    // The first run ended at 400, so the second waits until 550, not until 150 (the start-based time).
    clock.advance(149);
    expect(starts).toEqual([0]);
    clock.advance(1);
    expect(starts).toEqual([0, 550]);
  });

  test("runs never overlap, and requests during a run share one run after it with the newest value", async () => {
    const clock = fakeClock();
    const runs: { readonly value: string; readonly at: number }[] = [];
    const scheduler = createThrottledRun<string>({
      intervalMs: 150,
      run: (value) => {
        runs.push({ value, at: clock.now() });
        const { promise, resolve } = Promise.withResolvers<void>();
        clock.setTimer(resolve, 400);
        return promise;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.request("a");
    clock.advance(50);
    scheduler.request("b");
    clock.advance(50);
    scheduler.request("c");
    clock.advance(300);
    await settle();
    clock.advance(150);

    expect(runs).toEqual([
      { value: "a", at: 0 },
      { value: "c", at: 550 },
    ]);
  });
});
