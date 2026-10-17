/**
 * The motion audit recorder (#1173 part 7, #1649): what the page records in a real omp run, and the helpers a spec
 * uses to measure a step and assert its criterion. The specs are motion-audit-flow, -session-row, -notices,
 * -short-chat and -files.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { finishStep, type StepResult } from "./motion-metrics";

interface AuditProbe {
  /** A selector; "last:" then a selector means the last element that matches it. */
  readonly selector: string;
  /** What to read in each frame in which it changes. */
  readonly read:
    | "animationDuration"
    | "height"
    | "opacity"
    | "rotate"
    | "scrollHeight"
    | "scrollTop"
    | "top"
    | "transitionDuration"
    | "width";
}

interface ProbeSample {
  readonly at: number;
  readonly value: string;
}

interface LongTask {
  readonly at: number;
  readonly duration: number;
}

/** A transition or an animation that ended: its element, the property (or animation) and its length in seconds. */
interface EndEvent {
  readonly at: number;
  readonly name: string;
  readonly property: string;
  readonly elapsed: number;
}

/** A CSS animation or a transition as the page reports it: started, ended, cancelled or run. */
interface AnimationRecord {
  readonly at: number;
  readonly kind: "cancel" | "end" | "run" | "start" | "transition-cancel";
  readonly name: string;
  readonly animation: string;
  readonly elapsed: number;
}

/** An opacity transition that started on a message or a session row: its kind and direction, and the row's text. */
interface FadeEvent {
  readonly at: number;
  readonly key: string;
  readonly label: string;
}

/** A session or running row the page drew (added to the document), with its text. */
interface InsertEvent {
  readonly at: number;
  readonly kind: string;
  readonly label: string;
}

interface AuditLog {
  readonly longTasks: LongTask[];
  readonly ends: EndEvent[];
  readonly animations: AnimationRecord[];
  readonly fades: FadeEvent[];
  readonly inserts: InsertEvent[];
  /** Batches of changes inside the session list: each one is an update of the list (see the recorder). */
  listUpdates: number;
  readonly series: Record<string, ProbeSample[]>;
}

declare global {
  interface Window {
    __audit?: AuditLog;
  }
}

/** The base motion token (`--duration-base`, 180 ms), as the computed style reports it. */
export const BASE = "0.18s";

/** The motion token lengths in seconds, and the zero token that reduced motion declares. */
export const TOKEN_SECONDS = ["0s", "0.12s", "0.18s", "0.26s"];

export const TRACKED = {
  composer: '[data-shell-region="composer"]',
  viewport: '[data-slot="u1-thread-viewport"]',
  cardTrigger: 'last:[data-slot="u3-tool-card-trigger"]',
} as const;

export const PALETTE = '[role="dialog"][aria-label="Command palette"]';
export const MODEL_DIALOG = '[role="dialog"][aria-label="Model and thinking"]';
export const REASONING_TRIGGER = "[data-u1-reasoning-trigger]";
export const CHEVRON = `${REASONING_TRIGGER} svg.transition-transform`;

export const PROBES = {
  sessionsSidebar: { selector: '[data-shell-sidebar="left"]', read: "width" },
  panelsSidebar: { selector: '[data-shell-sidebar="right"]', read: "width" },
  viewport: { selector: '[data-slot="u1-thread-viewport"]', read: "scrollTop" },
  viewportHeight: { selector: '[data-slot="u1-thread-viewport"]', read: "scrollHeight" },
  cardTrigger: { selector: 'last:[data-slot="u3-tool-card-trigger"]', read: "top" },
  cardContent: { selector: 'last:[data-slot="u3-tool-card-content"]', read: "height" },
  cardDuration: { selector: 'last:[data-slot="u3-tool-card-content"]', read: "transitionDuration" },
  chevron: { selector: CHEVRON, read: "rotate" },
  palette: { selector: PALETTE, read: "opacity" },
  paletteDuration: { selector: PALETTE, read: "animationDuration" },
  modelDialog: { selector: MODEL_DIALOG, read: "opacity" },
  modelDialogDuration: { selector: MODEL_DIALOG, read: "animationDuration" },
} satisfies Record<string, AuditProbe>;

export const NOTICE_PROBES = {
  quiet: { selector: '[data-testid="n1-quiet"]', read: "opacity" },
  quietDuration: { selector: '[data-testid="n1-quiet"]', read: "transitionDuration" },
  toast: { selector: "article[data-notification-placement]", read: "opacity" },
  toastDuration: { selector: "article[data-notification-placement]", read: "transitionDuration" },
} satisfies Record<string, AuditProbe>;

/**
 * Runs in the page before any script. Self-contained: Playwright sends its source to the page. Keeps the long tasks;
 * every transition and animation that ends, with its length; every CSS animation's and transition's start, cancellation
 * and run; each opacity transition that starts on a message or a session row; each session or running row the page
 * draws; and, for each probe, its value in every frame in which it changed.
 */
export function recordAudit(probes: Readonly<Record<string, AuditProbe>>): void {
  const log: AuditLog = {
    longTasks: [],
    ends: [],
    animations: [],
    fades: [],
    inserts: [],
    listUpdates: 0,
    series: {},
  };
  window.__audit = log;
  for (const name of Object.keys(probes)) log.series[name] = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      log.longTasks.push({ at: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });

  const nameOf = (element: Element): string => {
    if (element.getAttribute("role") === "dialog")
      return `dialog:${element.getAttribute("aria-label") ?? ""}`;
    const sidebar = element.getAttribute("data-shell-sidebar");
    if (sidebar !== null) return `sidebar:${sidebar}`;
    const placement = element.getAttribute("data-notification-placement");
    if (placement !== null) return `notice:${placement}`;
    const slot = element.getAttribute("data-slot") ?? element.getAttribute("data-testid");
    if (slot !== null) return slot;
    return element.tagName.toLowerCase();
  };
  const labelOf = (element: Element): string =>
    (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const rowKinds: [string, string][] = [
    ['[data-slot="u1-message-row"]', "message"],
    ['[data-slot="r1-session-row"]', "session"],
    ['[data-slot="r1-running-row"]', "running"],
  ];
  const kindOf = (element: Element): string | undefined =>
    rowKinds.find(([selector]) => element.matches(selector))?.[1];

  document.addEventListener(
    "transitionend",
    (event) => {
      if (!(event.target instanceof Element)) return;
      log.ends.push({
        at: performance.now(),
        name: nameOf(event.target),
        property: event.propertyName,
        elapsed: event.elapsedTime,
      });
    },
    true,
  );
  document.addEventListener(
    "animationend",
    (event) => {
      if (!(event.target instanceof Element)) return;
      log.ends.push({
        at: performance.now(),
        name: nameOf(event.target),
        property: event.animationName,
        elapsed: event.elapsedTime,
      });
    },
    true,
  );
  const animationRecorder =
    (kind: AnimationRecord["kind"]) =>
    (event: AnimationEvent): void => {
      if (!(event.target instanceof Element)) return;
      log.animations.push({
        at: performance.now(),
        kind,
        name: nameOf(event.target),
        animation: event.animationName,
        elapsed: event.elapsedTime,
      });
    };
  document.addEventListener("animationstart", animationRecorder("start"), true);
  document.addEventListener("animationcancel", animationRecorder("cancel"), true);
  document.addEventListener("animationend", animationRecorder("end"), true);
  const transitionRecorder =
    (kind: AnimationRecord["kind"]) =>
    (event: TransitionEvent): void => {
      if (!(event.target instanceof Element)) return;
      log.animations.push({
        at: performance.now(),
        kind,
        name: nameOf(event.target),
        animation: event.propertyName,
        elapsed: event.elapsedTime,
      });
    };
  document.addEventListener("transitionrun", transitionRecorder("run"), true);
  document.addEventListener("transitioncancel", transitionRecorder("transition-cancel"), true);
  document.addEventListener(
    "transitionrun",
    (event) => {
      const target = event.target;
      if (event.propertyName !== "opacity" || !(target instanceof Element)) return;
      const kind = kindOf(target);
      if (kind === undefined) return;
      const direction = target.classList.contains("opacity-0") ? "leave" : "enter";
      log.fades.push({
        at: performance.now(),
        key: `${kind}:${direction}`,
        label: labelOf(target),
      });
    },
    true,
  );
  const rowSelector = '[data-slot="r1-session-row"], [data-slot="r1-running-row"]';
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const row of [node, ...node.querySelectorAll(rowSelector)]) {
          const kind = kindOf(row);
          if (kind === "session" || kind === "running")
            log.inserts.push({ at: performance.now(), kind, label: labelOf(row) });
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  // Each batch of changes inside the session list is one update of the list: a render of its rows, a changed time label
  // or a selection. The row 8 check waits on these updates, not on a timer.
  const sessionList = '[role="listbox"][aria-label="Session list"]';
  new MutationObserver((mutations) => {
    const inList = mutations.some((mutation) => {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return target !== null && target.closest(sessionList) !== null;
    });
    if (inList) log.listUpdates += 1;
  }).observe(document, { attributes: true, characterData: true, childList: true, subtree: true });

  const read = (element: Element, what: AuditProbe["read"]): string => {
    if (what === "opacity")
      return String(Math.round(Number(getComputedStyle(element).opacity) * 1000) / 1000);
    if (what === "rotate") return getComputedStyle(element).getPropertyValue("rotate");
    if (what === "animationDuration") return getComputedStyle(element).animationDuration;
    if (what === "transitionDuration") return getComputedStyle(element).transitionDuration;
    if (what === "scrollTop") return String(Math.round(element.scrollTop));
    if (what === "scrollHeight") return String(Math.round(element.scrollHeight));
    const box = element.getBoundingClientRect();
    let px = box.top;
    if (what === "width") px = box.width;
    if (what === "height") px = box.height;
    return String(Math.round(px * 10) / 10);
  };
  const tick = (): void => {
    for (const [name, probe] of Object.entries(probes)) {
      const found = probe.selector.startsWith("last:")
        ? [...document.querySelectorAll(probe.selector.slice(5))].at(-1)
        : document.querySelector(probe.selector);
      const value = found instanceof Element ? read(found, probe.read) : "absent";
      const samples = log.series[name] ?? [];
      if (samples.at(-1)?.value !== value) samples.push({ at: performance.now(), value });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function readAudit(page: Page): Promise<AuditLog> {
  const log = await page.evaluate(() => window.__audit);
  if (log === undefined)
    throw new Error("the audit recorder was not installed before the page loaded");
  return log;
}

/** One scripted step: what the page recorded from the step's start until its effects had landed. */
export interface Measured {
  readonly label: string;
  readonly step: StepResult;
  readonly audit: AuditLog;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * `finishStep` waits on each finite animation's `finished` promise with no limit. On the test machine that wait never returned in a
 * step that had no animation left running (the page was idle), and it held the test for its whole 20-minute timeout.
 * So the step first polls, without frames, until no finite animation is running (at most 10 s), and then finishes with a
 * 30 s limit. Past either limit it fails the step and names what the page holds.
 */
async function finishBounded(page: Page, label: string, startMs: number): Promise<StepResult> {
  const limit = new Promise<never>((_resolve, reject) => {
    AbortSignal.timeout(30_000).addEventListener("abort", () =>
      reject(new Error("the step did not finish within 30 s")),
    );
  });
  try {
    await page.waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.effect?.getComputedTiming().iterations === Infinity ||
              animation.playState === "finished" ||
              animation.playState === "idle",
          ),
      undefined,
      { polling: 100, timeout: 10_000 },
    );
    return await Promise.race([finishStep(page, label, startMs), limit]);
  } catch (error) {
    const state = await page
      .evaluate(() => ({
        stuck: document
          .getAnimations()
          .filter((animation) => animation.playState !== "finished")
          .map((animation) => `${animation.playState}:${animation.constructor.name}`),
        recentLongTasks: (window.__audit?.longTasks ?? [])
          .slice(-3)
          .map((task) => [Math.round(task.at), Math.round(task.duration)]),
        pageMs: Math.round(performance.now()),
      }))
      .catch(() => ({ stuck: ["(the page is gone)"], recentLongTasks: [], pageMs: -1 }));
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${reason}; the page: ${JSON.stringify(state)}`);
  }
}

export async function measure(
  page: Page,
  label: string,
  action: () => Promise<void>,
): Promise<Measured> {
  const startMs = await page.evaluate(() => performance.now());
  await action();
  const step = await finishBounded(page, label, startMs);
  return { label, step, audit: await readAudit(page), startMs, endMs: step.endMs };
}

/**
 * Waits until the transcript's height holds still (a reopened chat lays its rows out over its first frames), and until
 * the reader is at the bottom. Returns how many px short of the bottom the reader is. The wait ends after five seconds
 * even if the height still moves: the returned distance then shows the state, and the caller's own check decides.
 */
export async function settleTranscript(page: Page): Promise<number> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const started = performance.now();
        let last = -1;
        let still = 0;
        const tick = (): void => {
          const viewport = document.querySelector('[data-slot="u1-thread-viewport"]');
          const height = viewport instanceof HTMLElement ? viewport.scrollHeight : -1;
          still = height === last ? still + 1 : 0;
          last = height;
          if (still >= 60 || performance.now() - started > 5_000) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="u1-thread-viewport"]');
    return viewport instanceof HTMLElement
      ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      : -1;
  });
}

/** The centre of a locator's box, for a mouse press that does not scroll the element into view first. */
export async function centreOf(
  locator: Locator,
): Promise<{ readonly x: number; readonly y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element has no box to press");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export const round = (value: number): number => Math.round(value * 1000) / 1000;

export const inWindow = (measured: Measured, at: number): boolean =>
  at >= measured.startMs && at <= measured.endMs;

/** The lengths in ms of the transitions and animations that ended in the step (on `name`, and `property` if given). */
export function endsOf(measured: Measured, name: string | undefined, property?: string): number[] {
  return measured.audit.ends
    .filter(
      (end) =>
        inWindow(measured, end.at) &&
        (name === undefined || end.name === name) &&
        (property === undefined || end.property === property),
    )
    .map((end) => Math.round(end.elapsed * 1000));
}

/** Whether one of those lengths is the base token (180 ms, within 20 ms). */
export const takesBaseToken = (lengths: readonly number[]): boolean =>
  lengths.some((ms) => Math.abs(ms - 180) <= 20);

export function fadesOf(measured: Measured): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fade of measured.audit.fades) {
    if (inWindow(measured, fade.at)) counts[fade.key] = (counts[fade.key] ?? 0) + 1;
  }
  return counts;
}

/** The long tasks (over 50 ms) that ran in the step, longest first, in ms. */
export function longTasksOf(measured: Measured): number[] {
  return measured.audit.longTasks
    .filter((task) => inWindow(measured, task.at))
    .map((task) => Math.round(task.duration))
    .sort((a, b) => b - a);
}

/** The probe's values in the step, and the value it had just before the step. */
function valuesOf(
  measured: Measured,
  probe: string,
): { readonly before: string | undefined; readonly inside: string[] } {
  let before: string | undefined;
  const inside: string[] = [];
  for (const sample of measured.audit.series[probe] ?? []) {
    if (inWindow(measured, sample.at)) inside.push(sample.value);
    else if (sample.at < measured.startMs) before = sample.value;
  }
  return { before, inside };
}

/** Whether the probe held this value at some point in the step (the value before the step counts). */
export function showedIn(measured: Measured, probe: string, value: string): boolean {
  const { before, inside } = valuesOf(measured, probe);
  return before === value || inside.includes(value);
}

/** Frames in the step in which the probe changed. */
export function changesOf(measured: Measured, probe: string): number {
  return valuesOf(measured, probe).inside.length;
}

/** The numbers of a numeric probe in the step, the value before it first. */
function numbersOf(measured: Measured, probe: string): number[] {
  const { before, inside } = valuesOf(measured, probe);
  return [before, ...inside]
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter((value) => !Number.isNaN(value));
}

/** The largest change, in px, of a numeric probe from one frame to the next across the step. */
export function largestMoveOf(measured: Measured, probe: string): number {
  const values = numbersOf(measured, probe);
  let largest = 0;
  for (let index = 1; index < values.length; index += 1) {
    largest = Math.max(largest, Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0)));
  }
  return largest;
}

/** The distance, in px, from the least to the greatest value of a numeric probe across the step. */
export function spanOf(measured: Measured, probe: string): number {
  const values = numbersOf(measured, probe);
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

/** How many different values a probe showed across the step, the value before it included. */
export function distinctOf(measured: Measured, probe: string): number {
  const { before, inside } = valuesOf(measured, probe);
  return new Set([before, ...inside].filter((value) => value !== undefined)).size;
}

/** How long after the step began the probe's element was gone (-1 when it never was). */
function msUntilAbsent(measured: Measured, probe: string): number {
  const gone = (measured.audit.series[probe] ?? []).find(
    (sample) => sample.at >= measured.startMs && sample.value === "absent",
  );
  return gone === undefined ? -1 : Math.round(gone.at - measured.startMs);
}

/** A probe's values in the step, each with its time relative to the step's start (for diagnosis). */
export function trailOf(measured: Measured, probe: string): [number, string][] {
  return (measured.audit.series[probe] ?? [])
    .filter((sample) => inWindow(measured, sample.at))
    .map((sample): [number, string] => [Math.round(sample.at - measured.startMs), sample.value]);
}

export function summaryOf(measured: Measured) {
  return {
    layoutShift: measured.step.layoutShift,
    shiftAll: measured.step.shiftAll,
    movedPx: measured.step.movedPx,
    moves: measured.step.moves,
    fades: fadesOf(measured),
    longTasks: longTasksOf(measured),
    ends: measured.audit.ends
      .filter((end) => inWindow(measured, end.at))
      .map((end) => [end.name, end.property, Math.round(end.elapsed * 1000)]),
    animations: measured.audit.animations
      .filter((animation) => inWindow(measured, animation.at))
      .map((animation) => [
        Math.round(animation.at - measured.startMs),
        animation.kind,
        animation.name,
        animation.animation,
        Math.round(animation.elapsed * 1000),
      ]),
  };
}

/** A tool card's toggle: no layout shift that no input caused, the content moves over several frames, and its motion is the base token. */
export function expectCardAnimates(measured: Measured, what: string, collapsing: boolean): void {
  expect
    .soft(
      measured.step.layoutShift,
      `row 2: layout shift that no input caused while the card ${what}`,
    )
    .toBeLessThan(0.02);
  expect
    .soft(
      changesOf(measured, "cardContent"),
      `row 2: frames in which the card's content changes while it ${what}`,
    )
    .toBeGreaterThanOrEqual(2);
  if (collapsing) {
    expect
      .soft(
        showedIn(measured, "cardDuration", BASE),
        `row 2: the content's height takes the base token while the card ${what}`,
      )
      .toBe(true);
    return;
  }
  expect
    .soft(
      takesBaseToken(endsOf(measured, undefined, "grid-template-rows")),
      `row 2: the content's height takes the base token while the card ${what}`,
    )
    .toBe(true);
}

/** A sidebar slides over the base token, and the transcript's layout shifts nothing that no input caused. */
export function expectSidebarSlides(
  measured: Measured,
  row: string,
  name: string,
  probe: string,
  what: string,
): void {
  expect
    .soft(
      takesBaseToken(endsOf(measured, name, "width")),
      `${row}: the width takes the base token while ${what}`,
    )
    .toBe(true);
  expect
    .soft(
      changesOf(measured, probe),
      `${row}: frames in which the sidebar's width changes while ${what}`,
    )
    .toBeGreaterThanOrEqual(2);
  expect
    .soft(measured.step.layoutShift, `${row}: layout shift that no input caused while ${what}`)
    .toBeLessThan(0.02);
}

/**
 * A popup (a palette or a dialog) animates in and out over the base token and stays mounted for its exit (100 ms). The
 * opening is the animation's own end event; the closing is the exit animation's start and the declared duration of the
 * popup while it exits.
 */
export function expectPopupFades(
  open: Measured,
  close: Measured,
  row: string,
  name: string,
  probe: string,
  durationProbe: string,
  what: string,
): void {
  expect
    .soft(takesBaseToken(endsOf(open, name)), `${row}: ${what} takes the base token to open`)
    .toBe(true);
  expect
    .soft(
      close.audit.animations.some(
        (animation) =>
          animation.kind === "start" && animation.name === name && inWindow(close, animation.at),
      ),
      `${row}: ${what} starts its exit animation`,
    )
    .toBe(true);
  expect
    .soft(showedIn(close, durationProbe, BASE), `${row}: ${what} exits over the base token`)
    .toBe(true);
  expect
    .soft(
      msUntilAbsent(close, probe),
      `${row}: ${what} stays mounted for its exit, at least 100 ms (ms)`,
    )
    .toBeGreaterThanOrEqual(100);
  expect
    .soft(open.step.layoutShift, `${row}: layout shift that no input caused while ${what} opens`)
    .toBeLessThan(0.02);
  expect
    .soft(close.step.layoutShift, `${row}: layout shift that no input caused while ${what} closes`)
    .toBeLessThan(0.02);
}

// The long chat of the audit: 40 exchanges of markdown answers, as the baseline's "40 markdown exchanges" were.
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 10, 9, 0, 0);
const minute = 60_000;
const answer = [
  "Keep the parser stable by checking the grammar tests first.",
  "",
  "- Pin the **token** table before a refactor.",
  "- Run `bun test` before every merge.",
  "",
  "```ts",
  "const stable = parse(input, { strict: true });",
  "```",
].join("\n");
export const LONG_CHAT = Array.from({ length: 40 }, (_, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}: how do I keep the parser stable?` }],
      timestamp: at + index * 2 * minute,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Answer ${index + 1}.\n\n${answer}` }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + (index * 2 + 1) * minute,
    },
  },
]).flat();

/** The newest assistant row: the reply to the last prompt the test sent. */
export function replyRow(page: Page) {
  return page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last();
}
