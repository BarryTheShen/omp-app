import type { ClientTraceReport } from "@omp-app/contracts";
import { clientTags } from "./frames";

/** At most this many reports per page load: some minutes of typing on a phone, not a stream. */
const MOST_REPORTS = 300;
/** After the focus moves, the page is measured again this long after, once the keyboard's animation has ended. */
const AFTER_FOCUS_MS = [300, 800, 1_500] as const;

/** What made the page measure itself, the most telling first: a frame with several reports the first of them. */
const CAUSES = [
  "load",
  "focus-in",
  "focus-out",
  "turn",
  "shown",
  "after-focus",
  "resize",
  "vv-resize",
  "vv-scroll",
] as const;
type Cause = (typeof CAUSES)[number];

/** A length as the report takes it: whole, and never below 0 (a value above the top is given as its own `_up` mark). */
function px(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** The iPhone's iOS version from the browser's name for itself (`... OS 26_1 like Mac OS X ...`), if it gives one. */
function iosVersion(): string | null {
  const match = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
  return match === null ? null : `ios-${match[1]}-${match[2]}`;
}

/** The heights the browser reports, where the page and its message box end, and where the shown chat is. */
function measure(): Record<string, number> {
  const viewport = window.visualViewport;
  const html = document.documentElement;
  const root = document.getElementById("root");
  const rootBox = root?.getBoundingClientRect();
  const rootStyle = root === null ? null : getComputedStyle(root);
  const appHeight = Number.parseFloat(html.style.getPropertyValue("--app-height"));
  const marks: Record<string, number> = {
    t_ms: px(performance.now()),
    inner_w: px(window.innerWidth),
    inner_h: px(window.innerHeight),
    screen_h: px(window.screen.height),
    doc_client_h: px(html.clientHeight),
    doc_scroll_h: px(html.scrollHeight),
    scroll_y: px(window.scrollY),
    scroll_y_up: px(-window.scrollY),
    vv_h: px(viewport?.height ?? 0),
    vv_top: px(viewport?.offsetTop ?? 0),
    vv_top_up: px(-(viewport?.offsetTop ?? 0)),
    vv_scale_x100: px((viewport?.scale ?? 1) * 100),
    app_h: px(Number.isNaN(appHeight) ? 0 : appHeight),
    root_top: px(rootBox?.top ?? 0),
    root_top_up: px(-(rootBox?.top ?? 0)),
    root_bottom: px(rootBox?.bottom ?? 0),
    root_pad_top: px(Number.parseFloat(rootStyle?.paddingTop ?? "0")),
    root_pad_bottom: px(Number.parseFloat(rootStyle?.paddingBottom ?? "0")),
  };
  const box = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
  if (box !== null) {
    marks.box_focused = document.activeElement === box ? 1 : 0;
    marks.box_bottom = px(box.getBoundingClientRect().bottom);
    const form = box.closest("form");
    if (form !== null) marks.form_bottom = px(form.getBoundingClientRect().bottom);
  }
  const transcript = [
    ...document.querySelectorAll<HTMLElement>("section[aria-label='Transcript']"),
  ].find((element) => element.offsetParent !== null);
  if (transcript !== undefined) {
    marks.tr_bottom = px(transcript.getBoundingClientRect().bottom);
    marks.tr_client_h = px(transcript.clientHeight);
    marks.tr_scroll_h = px(transcript.scrollHeight);
    marks.tr_scroll_top = px(transcript.scrollTop);
    marks.tr_end_gap = px(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight);
    marks.jump_shown = [...(transcript.parentElement?.querySelectorAll("button") ?? [])].some(
      (button) => button.textContent?.trim() === "Jump to latest",
    )
      ? 1
      : 0;
  }
  return marks;
}

/**
 * Measures how a phone's page fits its screen around the on-screen keyboard, for the server's debug log: at each change
 * of what is visible (the keyboard coming up or going down, a field taking or losing the focus, a turn of the phone, the
 * page shown again) and a few moments after the focus moves, so a height left wrong after the keyboard's animation
 * shows. iOS lays its keyboard over the page and has known faults in what it reports after the keyboard goes (WebKit
 * bugs 292603, 300523, 301857); these reports say which a phone has. Only on a touch screen.
 */
export function traceViewport(report: (trace: ClientTraceReport) => void): () => void {
  if (!window.matchMedia("(pointer: coarse)").matches) return () => {};
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  const ios = iosVersion();
  const tags = [...clientTags(), standalone ? "standalone" : "tab", ...(ios === null ? [] : [ios])];
  let sent = 0;
  let pending: Cause | null = null;
  let frame = 0;
  const timers = new Set<number>();
  const send = (): void => {
    frame = 0;
    const cause = pending;
    pending = null;
    if (cause === null || sent >= MOST_REPORTS) return;
    sent += 1;
    report({ marks: measure(), gaps: [], supported: ["viewport", cause, ...tags] });
  };
  const note = (cause: Cause): void => {
    if (pending === null || CAUSES.indexOf(cause) < CAUSES.indexOf(pending)) pending = cause;
    if (frame === 0) frame = requestAnimationFrame(send);
  };
  const focusMoved = (cause: "focus-in" | "focus-out"): void => {
    note(cause);
    for (const delay of AFTER_FOCUS_MS) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        note("after-focus");
      }, delay);
      timers.add(timer);
    }
  };
  const viewport = window.visualViewport;
  const listeners: [EventTarget | null | undefined, string, () => void][] = [
    [viewport, "resize", () => note("vv-resize")],
    [viewport, "scroll", () => note("vv-scroll")],
    [window, "resize", () => note("resize")],
    [window, "orientationchange", () => note("turn")],
    [window, "pageshow", () => note("shown")],
    [document, "focusin", () => focusMoved("focus-in")],
    [document, "focusout", () => focusMoved("focus-out")],
    [
      document,
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") note("shown");
      },
    ],
  ];
  for (const [target, type, listener] of listeners) target?.addEventListener(type, listener);
  note("load");
  return () => {
    for (const [target, type, listener] of listeners) target?.removeEventListener(type, listener);
    for (const timer of timers) window.clearTimeout(timer);
    cancelAnimationFrame(frame);
  };
}
