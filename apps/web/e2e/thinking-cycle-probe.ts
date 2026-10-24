import type { Page } from "@playwright/test";

/**
 * Samples the boxes that a thinking-level change could move (issue #2594), every animation frame, while Alt+K cycles
 * the level. A box is keyed the same from frame to frame. The label of the model (the composer's model button and the
 * status bar's model segment, which show the level) is keyed with a `label:` prefix: it is the one box allowed to
 * change width.
 */

export type ProbeScope = "composer" | "status";

export interface ProbeBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
}

export interface ProbeFrame {
  readonly t: number;
  readonly boxes: Readonly<Record<string, ProbeBox>>;
}

export interface ProbeMark {
  readonly t: number;
  readonly kind: "press" | "resize";
  readonly index: number;
  readonly viewport: string;
}

export interface ProbeRecord {
  readonly frames: readonly ProbeFrame[];
  readonly marks: readonly ProbeMark[];
}

export interface ProbeMove {
  readonly key: string;
  readonly maxDx: number;
  readonly maxDy: number;
  readonly maxDw: number;
  readonly maxDh: number;
  readonly appearsOrDisappears: boolean;
}

interface ProbeState {
  frames: ProbeFrame[];
  marks: ProbeMark[];
  stop: boolean;
}

declare global {
  interface Window {
    __probe?: ProbeState;
  }
}

/** A box that moves by no more than this many pixels has not shifted: it is rounding. */
export const SHIFT_PX = 1;

/** Starts sampling the boxes of one scope, every animation frame, until stopProbe. */
export async function startProbe(page: Page, scope: ProbeScope): Promise<void> {
  await page.evaluate((which) => {
    const state: ProbeState = { frames: [], marks: [], stop: false };
    window.__probe = state;
    const collect = () => {
      const out: Record<string, { x: number; y: number; w: number; h: number; text: string }> = {};
      const seen = new Map<string, number>();
      const put = (base: string, element: Element) => {
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const isLabel =
          element.closest('[data-surface="model"]') !== null ||
          element.getAttribute("data-segment") === "N2.model";
        const r = element.getBoundingClientRect();
        out[`${isLabel ? "label:" : ""}${base}#${n}`] = {
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
          text: (element.textContent ?? "").trim().slice(0, 60),
        };
      };
      if (which === "composer") {
        const toolbar = document.querySelector('[data-layout-area="composerToolbar"]');
        const row = toolbar?.parentElement;
        if (row) {
          put("composer-row", row);
          if (toolbar) put("composer-toolbar", toolbar);
          for (const el of row.querySelectorAll("[data-surface]")) {
            put(`surface:${el.getAttribute("data-surface")}`, el);
          }
          for (const el of row.querySelectorAll("button")) {
            put(`button:${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim()}`, el);
          }
        }
      } else {
        const bar = document.querySelector('[data-layout-area="statusBar"]');
        if (bar) {
          for (const [i, el] of [...bar.querySelectorAll(":scope > *")].entries()) {
            put(`bar-child:${i}`, el);
          }
          for (const el of bar.querySelectorAll("[data-segment]")) {
            put(`segment:${el.getAttribute("data-segment")}`, el);
          }
        }
      }
      return out;
    };
    const loop = () => {
      if (state.stop) return;
      state.frames.push({ t: performance.now(), boxes: collect() });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, scope);
}

/** Records a mark: a press of Alt+K, or a change of viewport, at this moment in the sampled frames. */
export async function markProbe(
  page: Page,
  kind: "press" | "resize",
  index: number,
  viewport: string,
): Promise<void> {
  await page.evaluate(
    ({ kind, index, viewport }) => {
      window.__probe?.marks.push({ t: performance.now(), kind, index, viewport });
    },
    { kind, index, viewport },
  );
}

/** Stops sampling and returns what was recorded. */
export function stopProbe(page: Page): Promise<ProbeRecord> {
  return page.evaluate(() => {
    const state = window.__probe;
    if (state === undefined) throw new Error("The probe was not started.");
    state.stop = true;
    return { frames: state.frames, marks: state.marks };
  });
}

/**
 * The windows of the presses: from each press to the next mark, compared with the settled frame before the press. A
 * resize is not a press, so the window after it is not analysed.
 */
export function pressWindows(record: ProbeRecord): {
  readonly mark: ProbeMark;
  readonly baseline: ProbeFrame;
  readonly frames: readonly ProbeFrame[];
}[] {
  const out: { mark: ProbeMark; baseline: ProbeFrame; frames: ProbeFrame[] }[] = [];
  for (const [i, mark] of record.marks.entries()) {
    if (mark.kind !== "press") continue;
    const end = record.marks[i + 1]?.t ?? Number.POSITIVE_INFINITY;
    const frames = record.frames.filter((frame) => frame.t >= mark.t && frame.t < end);
    const before = record.frames.filter((frame) => frame.t < mark.t);
    const baseline = before[before.length - 1] ?? frames[0];
    if (baseline !== undefined && frames.length > 0) out.push({ mark, baseline, frames });
  }
  return out;
}

/** Every box that moved more than SHIFT_PX, or appeared or disappeared, within one window. */
export function movesIn(baseline: ProbeFrame, frames: readonly ProbeFrame[]): ProbeMove[] {
  const keys = new Set<string>([
    ...Object.keys(baseline.boxes),
    ...frames.flatMap((frame) => Object.keys(frame.boxes)),
  ]);
  const moves: ProbeMove[] = [];
  for (const key of keys) {
    const before = baseline.boxes[key];
    let maxDx = 0;
    let maxDy = 0;
    let maxDw = 0;
    let maxDh = 0;
    let appearsOrDisappears = false;
    for (const frame of frames) {
      const now = frame.boxes[key];
      if (before === undefined || now === undefined) {
        if (before !== now) appearsOrDisappears = true;
        continue;
      }
      maxDx = Math.max(maxDx, Math.abs(now.x - before.x));
      maxDy = Math.max(maxDy, Math.abs(now.y - before.y));
      maxDw = Math.max(maxDw, Math.abs(now.w - before.w));
      maxDh = Math.max(maxDh, Math.abs(now.h - before.h));
    }
    const moved = [maxDx, maxDy, maxDw, maxDh].some((d) => d > SHIFT_PX);
    if (moved || appearsOrDisappears) {
      moves.push({ key, maxDx, maxDy, maxDw, maxDh, appearsOrDisappears });
    }
  }
  return moves;
}

/** The label keys: the boxes that show the level and may change width. */
export const isLabelKey = (key: string): boolean => key.startsWith("label:");
