/**
 * The newest rows of a chat mount first, and the rest mount in slices (speed plan step SP-W1). The store keeps every message: this
 * module decides only how many of the newest rows the transcript draws. Rows are counted from the newest, so a row that arrives
 * at the end is drawn at once, and an older page (rows that arrive above the first one) is drawn at once too.
 */

/** The newest rows drawn before anything else: what the reader sees when a chat opens at its newest message. */
export const FIRST_ROWS = 20;

/** Rows the first step mounts; the next steps follow the rows' measured cost. */
export const START_CHUNK = 4;

/**
 * Time one task or animation frame may spend drawing rows, in milliseconds (see drawWithinBudget). Measured against main (SP-W1
 * variant table): 6 ms draws 2,000 rows in 51 s, 30 ms in 6.9 s (main 4.8 s), and 50 ms puts a slice's frame at the 100 ms limit.
 */
export const SLICE_BUDGET_MS = 30;

const MIN_CHUNK = 1;
const MAX_CHUNK = 64;

/** The rows of a chat: the newest `mounted` of its `total` messages. */
export interface RowSlices {
  /** The chat the rows belong to. A different key starts over. */
  readonly key: string | undefined;
  /** The id of the oldest message at the last change: a change of it with more rows is an older page. */
  readonly firstId: string | undefined;
  readonly total: number;
  readonly mounted: number;
}

/** The thread's messages now, and whether every row must be drawn at once (a restored reading place needs them all). */
export interface RowsChange {
  readonly key: string | undefined;
  readonly firstId: string | undefined;
  readonly total: number;
  readonly mountAll: boolean;
}

/** The rows of a chat that is opening: its newest `FIRST_ROWS`, or all of them when the caller needs every row. */
export function openRowSlices(change: RowsChange): RowSlices {
  return {
    key: change.key,
    firstId: change.firstId,
    total: change.total,
    mounted: change.mountAll ? change.total : Math.min(change.total, FIRST_ROWS),
  };
}

/**
 * The rows after the thread's messages changed. Returns `slices` itself when nothing it depends on changed, so a caller that
 * keeps the result in state does not render again for the same messages.
 */
export function changeRowSlices(slices: RowSlices, change: RowsChange): RowSlices {
  if (slices.key !== change.key) return openRowSlices(change);
  if (slices.total === 0) return change.total === 0 ? slices : openRowSlices(change);
  if (change.total === slices.total && change.firstId === slices.firstId) {
    return change.mountAll && slices.mounted < slices.total
      ? { ...slices, mounted: slices.total }
      : slices;
  }
  // An older page lands above the first row: its rows are drawn with the rest, so the reader's rows keep their place.
  const olderPage = change.total > slices.total && change.firstId !== slices.firstId;
  const fullyMounted = slices.mounted >= slices.total;
  const mounted =
    change.mountAll || olderPage || fullyMounted
      ? change.total
      : Math.min(change.total, slices.mounted + Math.max(0, change.total - slices.total));
  return { key: change.key, firstId: change.firstId, total: change.total, mounted };
}

/** The rows after one slice that mounts `rows` more, from the newest down. */
export function mountNextSlice(slices: RowSlices, rows: number): RowSlices {
  const mounted = Math.min(slices.total, slices.mounted + rows);
  return mounted === slices.mounted ? slices : { ...slices, mounted };
}

/**
 * The rows the next slice mounts, from the last slice's cost: `rows` rows took `elapsedMs`, and the next slice gets as many
 * rows as fit the budget at that cost. A slice that mounted nothing keeps the chunk it had.
 */
export function nextChunk(chunk: number, rows: number, elapsedMs: number): number {
  if (rows <= 0 || elapsedMs <= 0) return chunk;
  const perRow = elapsedMs / rows;
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.floor(SLICE_BUDGET_MS / perRow)));
}

/**
 * Runs `step` until it reports that no work is left, or until `budgetMs` has passed since the first step started. Returns
 * whether work remains: a caller that gets true asks for the next task or animation frame to continue. `step` runs at least
 * once per call, so a caller with no work left stops at once.
 */
export function drawWithinBudget(
  step: () => boolean,
  budgetMs: number,
  now: () => number = () => performance.now(),
): boolean {
  const started = now();
  for (;;) {
    if (!step()) return false;
    if (now() - started >= budgetMs) return true;
  }
}

/** The part of the Prioritized Task Scheduling API the slices use; the global may not exist (WebKit has none). */
interface TaskScheduler {
  postTask(task: () => void, options: { readonly priority: "user-visible" }): Promise<void>;
}

function taskSchedulerOf(): TaskScheduler | undefined {
  const scheduler: unknown = Reflect.get(globalThis, "scheduler");
  if (typeof scheduler !== "object" || scheduler === null || !("postTask" in scheduler)) {
    return undefined;
  }
  if (typeof scheduler.postTask !== "function") return undefined;
  // The Prioritized Task Scheduling API is not in this TypeScript lib, and its shape was checked just above.
  const checked = scheduler as TaskScheduler;
  return checked;
}

/**
 * Runs `run` in a later task: through `scheduler.postTask` where the browser has it, else in the next animation frame. Returns
 * the function that cancels it; a task that already ran is not undone.
 */
export function scheduleSlice(run: () => void): () => void {
  const scheduler = taskSchedulerOf();
  if (scheduler !== undefined) {
    let live = true;
    void scheduler.postTask(
      () => {
        if (live) run();
      },
      { priority: "user-visible" },
    );
    return (): void => {
      live = false;
    };
  }
  const frame = requestAnimationFrame(run);
  return (): void => cancelAnimationFrame(frame);
}
