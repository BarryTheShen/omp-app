/** The least time between the end of one highlight run of a growing code block and the start of the next. */
export const RETOKENIZE_INTERVAL_MS = 150;

export interface ThrottledRunOptions<T> {
  readonly intervalMs: number;
  /** Runs one request. A run that returns a promise holds the next run until that promise settles. */
  readonly run: (value: T) => void | Promise<void>;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
}

export interface ThrottledRun<T> {
  /**
   * Asks for a run with `value`. Requests that arrive while a run is waiting or running share one run after
   * it, and that run uses the newest value, so the last value always runs.
   */
  readonly request: (value: T) => void;
  /** Drops a run that is waiting for its turn. A run already started finishes. */
  readonly cancel: () => void;
}

/**
 * At most one run at a time, and the next run starts `intervalMs` after the previous one ENDED. Measured
 * from the start instead, a run longer than the interval would be followed at once by the next one, and the
 * thread would never be idle. The clock and the timer are injected, so the timing is tested without real waits.
 */
export function createThrottledRun<T>(options: ThrottledRunOptions<T>): ThrottledRun<T> {
  let pending: { readonly value: T } | undefined;
  let timer: number | undefined;
  let running = false;
  let lastRunEnd = Number.NEGATIVE_INFINITY;

  const schedule = (): void => {
    const wait = Math.max(0, lastRunEnd + options.intervalMs - options.now());
    timer = options.setTimer(fire, wait);
  };

  const finish = (): void => {
    running = false;
    lastRunEnd = options.now();
    if (pending !== undefined) schedule();
  };

  const fire = (): void => {
    timer = undefined;
    if (pending === undefined || running) return;
    const { value } = pending;
    pending = undefined;
    const outcome = options.run(value);
    if (outcome instanceof Promise) {
      running = true;
      void outcome.finally(finish);
    } else {
      finish();
    }
  };

  return {
    request(value) {
      pending = { value };
      if (running || timer !== undefined) return;
      schedule();
    },
    cancel() {
      if (timer !== undefined) options.clearTimer(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
