/**
 * Motion measurements (#1173). The page reports its own layout shifts (Performance API) and, every
 * frame in which a tracked part changes, where that part sits. `recordMotion` runs in the page before
 * any script (`beforeLoad: (page) => page.addInitScript(recordMotion, tracked)`); `measureStep` reads
 * what the page recorded during one scripted step, from its start until its animations have finished.
 *
 * `layoutShift` is what Chrome counts for CLS (shifts that no input caused). `shiftAll` adds the shifts
 * that came right after a click or key press, which a person still sees as a jump.
 */
import type { Page } from "@playwright/test";
import { waitForFiniteAnimations } from "./real-omp";

export interface ShiftEntry {
  readonly at: number;
  readonly value: number;
  readonly afterInput: boolean;
  readonly nodes: readonly string[];
}

/** A tracked part's position in one frame in which it changed: its top, height and scroll offset. */
export interface GeometrySample {
  readonly at: number;
  readonly name: string;
  readonly top: number;
  readonly height: number;
  readonly scrollTop: number;
}

export interface MotionLog {
  readonly shifts: readonly ShiftEntry[];
  readonly geometry: readonly GeometrySample[];
}

export interface StepResult {
  readonly step: string;
  /** Page time (`performance.now()`) when the step began and when its animations had finished. */
  readonly startMs: number;
  readonly endMs: number;
  readonly layoutShift: number;
  readonly shiftAll: number;
  readonly shiftCount: number;
  /** Up to three elements that moved most in this step, with their summed shift. */
  readonly shiftNodes: readonly string[];
  /** The largest vertical move of each tracked part in this step, in px (absent when it did not move). */
  readonly movedPx: Readonly<Record<string, number>>;
  /** Per tracked part that changed: how many frames it changed in, and the largest move in px. */
  readonly moves: readonly string[];
}

interface MotionWindow {
  __motion?: MotionLog;
}

/**
 * Runs in the page before any script. Self-contained on purpose: Playwright sends its source to the
 * page, so it must not refer to anything outside this function. `tracked` maps a name to a selector;
 * a selector starting with "last:" means the last element that matches the rest of it.
 */
export function recordMotion(tracked: Readonly<Record<string, string>>): void {
  const target = window as unknown as MotionWindow;
  if (target.__motion !== undefined) return;
  const log: { shifts: ShiftEntry[]; geometry: GeometrySample[] } = { shifts: [], geometry: [] };
  target.__motion = log;
  const describe = (node: unknown): string => {
    if (!(node instanceof Element)) return "(no element)";
    const slot = node.getAttribute("data-slot");
    const label = node.getAttribute("aria-label");
    const role = node.getAttribute("role");
    const name = slot ?? label ?? role ?? node.tagName.toLowerCase();
    return name.slice(0, 80);
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as Array<{
      startTime: number;
      value: number;
      hadRecentInput: boolean;
      sources?: Array<{ node: Node | null }>;
    }>) {
      log.shifts.push({
        at: entry.startTime,
        value: entry.value,
        afterInput: entry.hadRecentInput,
        nodes: (entry.sources ?? []).map((source) => describe(source.node)),
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
  const last = new Map<string, string>();
  const sample = (): void => {
    for (const [name, selector] of Object.entries(tracked)) {
      const found = selector.startsWith("last:")
        ? [...document.querySelectorAll(selector.slice(5))].at(-1)
        : document.querySelector(selector);
      if (!(found instanceof Element)) continue;
      const rect = found.getBoundingClientRect();
      const top = Math.round(rect.top * 10) / 10;
      const height = Math.round(rect.height * 10) / 10;
      const scrollTop = Math.round(found.scrollTop);
      const key = `${top}/${height}/${scrollTop}`;
      if (last.get(name) === key) continue;
      last.set(name, key);
      log.geometry.push({ at: performance.now(), name, top, height, scrollTop });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

/** The motion log of the page so far. */
export async function readLog(page: Page): Promise<MotionLog> {
  const log = await page.evaluate(() => (window as unknown as MotionWindow).__motion);
  if (log === undefined)
    throw new Error("motion observers were not installed before the page loaded");
  return log;
}

/**
 * Waits until the step's effects have landed: the page has painted two frames, its finite
 * animations have finished, and the observer has delivered what it recorded (a short flush, because
 * layout-shift entries arrive after the frame that caused them).
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await waitForFiniteAnimations(page);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
}

/** Runs one scripted step and summarises what the page recorded during it. */
export async function measureStep(
  page: Page,
  step: string,
  action: () => Promise<void>,
): Promise<StepResult> {
  const startMs = await page.evaluate(() => performance.now());
  await action();
  return finishStep(page, step, startMs);
}

/** Ends a window that began at `startMs` (page time) once its effects have landed. */
export async function finishStep(page: Page, step: string, startMs: number): Promise<StepResult> {
  await settle(page);
  const endMs = await page.evaluate(() => performance.now());
  return summarize(step, startMs, endMs, await readLog(page));
}

/** Pure summary of the entries inside one step's window. */
export function summarize(
  step: string,
  startMs: number,
  endMs: number,
  log: MotionLog,
): StepResult {
  const shifts = log.shifts.filter((shift) => shift.at >= startMs && shift.at <= endMs);
  const byNode = new Map<string, number>();
  for (const shift of shifts) {
    for (const node of shift.nodes) byNode.set(node, (byNode.get(node) ?? 0) + shift.value);
  }
  const shiftNodes = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([node, value]) => `${node} ${value.toFixed(3)}`);
  // Each change of a tracked part is compared with the change before it, so a move that began before
  // the step is still measured in full.
  const moves = new Map<string, { changes: number; top: number; scroll: number }>();
  const previous = new Map<string, GeometrySample>();
  for (const sample of log.geometry) {
    const before = previous.get(sample.name);
    previous.set(sample.name, sample);
    if (before === undefined || sample.at < startMs || sample.at > endMs) continue;
    const entry = moves.get(sample.name) ?? { changes: 0, top: 0, scroll: 0 };
    moves.set(sample.name, {
      changes: entry.changes + 1,
      top: Math.max(entry.top, Math.abs(sample.top - before.top)),
      scroll: Math.max(entry.scroll, Math.abs(sample.scrollTop - before.scrollTop)),
    });
  }
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    step,
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    layoutShift: round(
      shifts.filter((shift) => !shift.afterInput).reduce((sum, shift) => sum + shift.value, 0),
    ),
    shiftAll: round(shifts.reduce((sum, shift) => sum + shift.value, 0)),
    shiftCount: shifts.length,
    shiftNodes,
    movedPx: Object.fromEntries(
      [...moves.entries()].map(([name, move]) => [name, Math.round(move.top)]),
    ),
    moves: [...moves.entries()].map(
      ([name, move]) =>
        `${name}: ${move.changes} frame${move.changes === 1 ? "" : "s"}, up to ${Math.round(move.top)}px, scroll ${Math.round(move.scroll)}px`,
    ),
  };
}
