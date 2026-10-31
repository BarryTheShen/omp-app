import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import { desktopBridge } from "../desktop/bridge";
import { KEYS, keycap } from "../keys/table";
import type { WorkspaceHandle } from "../workspace/Workspace";
import { matchesHotkey } from "./keys";
import { markDone } from "./seen";
import type { KeyId, Tour, TourAction } from "./tours";
import "./tour.css";

const POLL_MS = 100;
/** How long a step waits for its target to be on the page before it shows centred. */
const TARGET_WAIT_MS = 3000;

/** Stops the tour that is running, if one is. */
let stopCurrent: (() => void) | null = null;

/**
 * The element a selector names: of several, the one in the focused pane, else the last. A match that is not drawn (a
 * pane of another tab, or one a zoomed pane hides) is not a match.
 */
function pick(selector: string): Element | null {
  const found = [...document.querySelectorAll(selector)].filter(
    (element) =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
  );
  const pane = document.activeElement?.closest("[data-chat-pane]") ?? null;
  const inPane =
    pane === null ? undefined : found.find((el) => el.closest("[data-chat-pane]") === pane);
  return inPane ?? found.at(-1) ?? null;
}

/**
 * Calls `hit` when the step's action is done, and returns what stops the watching. A click and a key give the app a
 * frame to act first, so the next step starts from what the action did.
 */
function watch(action: TourAction, element: Element | null, hit: () => void): () => void {
  let frame = 0;
  const later = (): void => {
    if (frame === 0) frame = requestAnimationFrame(hit);
  };
  const stop = (): void => cancelAnimationFrame(frame);
  switch (action.kind) {
    case "next":
      return stop;
    case "click": {
      if (element === null) return stop;
      element.addEventListener("click", later, { capture: true, once: true });
      return () => {
        element.removeEventListener("click", later, true);
        stop();
      };
    }
    case "keys": {
      const { hotkey } = KEYS[action.key];
      // The app's own handler runs too: this only listens.
      const onKey = (event: KeyboardEvent): void => {
        if (matchesHotkey(event, hotkey)) later();
      };
      document.addEventListener("keydown", onKey, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        stop();
      };
    }
    case "appears":
    case "disappears": {
      const wanted = action.kind === "appears";
      const timer = setInterval(() => {
        // A dialog that is closing (its popup says so) is gone already, though it stays drawn while it animates out.
        const present = [...document.querySelectorAll(action.selector)].some(
          (element) => element.closest("[data-closed], [data-ending-style]") === null,
        );
        if (present === wanted) hit();
      }, POLL_MS);
      return () => clearInterval(timer);
    }
  }
}

/** How a tour runs as one of several in a row: where it stands, whether it opens the sandbox tab, what comes next. */
interface InRow {
  readonly index: number;
  readonly total: number;
  /** False when an earlier tour of the row opened the sandbox tab already. */
  readonly sandbox: boolean;
  readonly onDone: () => void;
}

/**
 * Runs a tour: each step is drawn by driver.js (a highlight and a popover) and waits for its action. The app is used
 * for real, so every key and click does what it always does; the tour only watches. A second tour ends the first. A
 * sandbox tour opens its own tab with a new chat first.
 */
export function startTour(tour: Tour, workspace: WorkspaceHandle, row?: InRow): void {
  stopCurrent?.();

  let stopped = false;
  /** What each wait in progress does to end itself, for `stop`. */
  const waits = new Set<() => void>();
  /** The Next, Skip or Done button of the step shown: advances it. */
  let advance: (() => void) | null = null;
  /** The last focused element outside the popover, which gets the focus back when driver takes it for the popover. */
  let lastFocus: Element | null = null;

  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Element && !event.target.closest(".driver-popover"))
      lastFocus = event.target;
  };
  document.addEventListener("focusin", onFocusIn, true);

  const overlay = driver({
    animate: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    overlayOpacity: 0.45,
    stagePadding: 6,
    stageRadius: 10,
    smoothScroll: true,
    // Esc and the arrows belong to the app: Esc stops omp.
    allowKeyboardControl: false,
    overlayClickBehavior: "none",
    disableActiveInteraction: false,
    popoverClass: "omp-tour",
    showProgress: true,
    onNextClick: () => advance?.(),
    onCloseClick: () => stop(),
    // Driver puts the focus in the popover as it draws it; the box, the list or the pane the person was in keeps it.
    onPopoverRender: ({ wrapper }) => {
      requestAnimationFrame(() => {
        if (stopped || !(lastFocus instanceof HTMLElement) || !lastFocus.isConnected) return;
        if (wrapper.contains(document.activeElement)) lastFocus.focus({ preventScroll: true });
      });
    },
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const end of [...waits]) end();
    document.removeEventListener("focusin", onFocusIn, true);
    overlay.destroy();
    delete document.documentElement.dataset.tourThrough;
    if (stopCurrent === stop) stopCurrent = null;
  }
  stopCurrent = stop;

  /**
   * Waits for `setup` to call `done`; `stopped` is the value when the tour ends first. `setup` returns what undoes it,
   * which runs once whichever comes first.
   */
  function until<T>(ended: T, setup: (done: (value: T) => void) => () => void): Promise<T> {
    return new Promise<T>((resolve) => {
      let finished = false;
      let undo: () => void = () => undefined;
      const done = (value: T): void => {
        if (finished) return;
        finished = true;
        undo();
        waits.delete(cancel);
        resolve(value);
      };
      const cancel = (): void => done(ended);
      waits.add(cancel);
      undo = setup(done);
      if (finished) undo();
    });
  }

  const frames = (count: number): Promise<void> =>
    until<void>(undefined, (done) => {
      let left = count;
      let frame = 0;
      const tick = (): void => {
        left -= 1;
        if (left <= 0) done();
        else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    });

  /** The step's element, polled for; null when it did not come. */
  const find = (selector: string): Promise<Element | null> =>
    until<Element | null>(null, (done) => {
      const since = Date.now();
      const look = (): void => {
        const element = pick(selector);
        if (element !== null) done(element);
        else if (Date.now() - since >= TARGET_WAIT_MS) done(null);
      };
      look();
      const timer = setInterval(look, POLL_MS);
      return () => clearInterval(timer);
    });

  async function play(): Promise<void> {
    if (tour.sandbox && row?.sandbox !== false) {
      workspace.command("newTab");
      await frames(2);
    }
    const steps = tour.steps.filter(
      (step) => step.desktopOnly !== true || desktopBridge() !== null,
    );
    for (const [index, step] of steps.entries()) {
      if (stopped) return;
      const element = step.target === null ? null : await find(step.target);
      if (stopped) return;
      // A target that never came leaves the popover centred, and the Next button the way on.
      const action: TourAction =
        step.target !== null && element === null ? { kind: "next" } : step.action;
      // The last step ends the tour; in a row of tours, it goes on to the next one.
      const last = row !== undefined && row.index < row.total - 1 ? "Next tour" : "Done";
      const label = index === steps.length - 1 ? last : action.kind === "next" ? "Next" : "Skip";
      // A step whose action ends outside its highlighted element leaves the dimmed page usable (tour.css).
      if (step.throughOverlay === true) document.documentElement.dataset.tourThrough = "";
      else delete document.documentElement.dataset.tourThrough;
      overlay.highlight({
        ...(element === null ? {} : { element }),
        popover: {
          title: step.title,
          description: step.text.replace(/\{(\w+)\}/g, (placeholder, id: string) =>
            Object.hasOwn(KEYS, id) ? `<kbd>${keycap(KEYS[id as KeyId])}</kbd>` : placeholder,
          ),
          showButtons: ["next", "close"],
          showProgress: true,
          // Driver fills in its own {{current}} and {{total}} only for the steps it drives itself.
          progressText:
            row === undefined || row.total < 2
              ? `Step ${index + 1} of ${steps.length}`
              : `Tour ${row.index + 1} of ${row.total} · step ${index + 1} of ${steps.length}`,
          nextBtnText: label,
          // A step's class replaces the driver's, so a centred one names both.
          ...(step.centred === true ? { popoverClass: "omp-tour omp-tour-centred" } : {}),
        },
      });
      await until<void>(undefined, (done) => {
        advance = done;
        const unwatch = watch(action, element, done);
        return () => {
          advance = null;
          unwatch();
        };
      });
    }
    if (stopped) return;
    markDone(tour.id);
    stop();
    row?.onDone();
  }

  play().catch((failure: unknown) => {
    stop();
    throw failure;
  });
}

/**
 * Runs tours one after another: the next starts when one is done, and closing one ends the rest. The first sandbox tour
 * opens the sandbox tab, and the later ones use it.
 */
export function startTours(tours: readonly Tour[], workspace: WorkspaceHandle): void {
  const run = (index: number, sandboxOpen: boolean): void => {
    const tour = tours[index];
    if (tour === undefined) return;
    startTour(tour, workspace, {
      index,
      total: tours.length,
      sandbox: !sandboxOpen,
      onDone: () => run(index + 1, sandboxOpen || tour.sandbox),
    });
  };
  run(0, false);
}
