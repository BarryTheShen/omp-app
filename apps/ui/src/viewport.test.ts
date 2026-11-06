import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { followVisualViewport, PAN_SETTLE_MS } from "./viewport";

/** A visual viewport the test moves: its height, zoom and offset, and the events the page listens to. */
function visualViewport(height: number) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    scale: 1,
    offsetTop: 0,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) =>
      listeners.get(type)?.delete(listener),
    fire(type: "resize" | "scroll") {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

/** An element as the touch guard reads it: its parent, sizes and overflow. */
class Box {
  parentElement: Box | null = null;
  scrollHeight = 0;
  clientHeight = 0;
  scrollWidth = 0;
  clientWidth = 0;
  overflowX = "visible";
  overflowY = "visible";
  constructor(init: Partial<Box> = {}) {
    Object.assign(this, init);
  }
}
class Field extends Box {
  selectionStart = 0;
  selectionEnd = 0;
}

const style = new Map<string, string>();
const scrolledTo: [number, number][] = [];
const touchListeners = new Map<string, Set<(event: unknown) => void>>();
const page = { activeElement: null as unknown };

/** A touch event on the page: fingers at `points`, on `target`; whether the page stopped it. */
function touch(type: string, target: Box | null, points: readonly (readonly [number, number])[]) {
  const event = {
    target,
    cancelable: true,
    defaultPrevented: false,
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  for (const listener of touchListeners.get(type) ?? []) listener(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  style.clear();
  scrolledTo.length = 0;
  touchListeners.clear();
  page.activeElement = null;
  vi.stubGlobal("window", {
    innerHeight: 874,
    scrollY: 0,
    scrollTo: (x: number, y: number) => scrolledTo.push([x, y]),
  });
  vi.stubGlobal("document", {
    // The layout viewport's height, which the keyboard leaves alone.
    documentElement: {
      clientHeight: 874,
      style: {
        setProperty: (name: string, value: string) => style.set(name, value),
        removeProperty: (name: string) => style.delete(name),
      },
    },
    body: {},
    get activeElement() {
      return page.activeElement;
    },
    getSelection: () => null,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = touchListeners.get(type) ?? new Set();
      set.add(listener);
      touchListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      touchListeners.get(type)?.delete(listener),
  });
  vi.stubGlobal("Element", Box);
  vi.stubGlobal("HTMLTextAreaElement", Field);
  vi.stubGlobal("HTMLInputElement", class extends Field {});
  vi.stubGlobal("getComputedStyle", (box: Box) => ({
    overflowX: box.overflowX,
    overflowY: box.overflowY,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("followVisualViewport", () => {
  test("a keyboard covering the page gives it the visible height and keeps it at the top", () => {
    const viewport = visualViewport(874);
    const stop = followVisualViewport(viewport as unknown as VisualViewport);
    expect(style.has("--app-height")).toBe(false);

    viewport.height = 520.4;
    viewport.offsetTop = 120;
    viewport.fire("resize");
    expect(style.get("--app-height")).toBe("520px");
    // The home indicator is under the keyboard: no space is kept for it.
    expect(style.get("--app-bottom")).toBe("0px");
    expect(scrolledTo).toEqual([[0, 0]]);

    // The keyboard closes: the page has its full height and the home indicator's space back.
    viewport.height = 874;
    viewport.offsetTop = 0;
    viewport.fire("resize");
    expect(style.has("--app-height")).toBe(false);
    expect(style.has("--app-bottom")).toBe(false);
    stop();
  });

  test("a Home Screen app that reports the window as short as the visible area still fits the page to it", () => {
    // An iPhone's Home Screen app (iOS 27) the moment its keyboard opened: the window and the visible area both 478
    // high, the page 812 high and scrolled 334 to the box.
    const viewport = visualViewport(812);
    const root = document.documentElement as unknown as { clientHeight: number };
    root.clientHeight = 812;
    followVisualViewport(viewport as unknown as VisualViewport);
    const view = window as unknown as { innerHeight: number; scrollY: number };
    view.innerHeight = 478;
    view.scrollY = 334;
    viewport.height = 478;
    viewport.offsetTop = 334;
    viewport.fire("resize");
    expect(style.get("--app-height")).toBe("478px");
    expect(style.get("--app-bottom")).toBe("0px");
    expect(scrolledTo).toEqual([[0, 0]]);
  });

  test("a pinch zoom shrinks the visible area, and the page does not follow it", () => {
    const viewport = visualViewport(874);
    followVisualViewport(viewport as unknown as VisualViewport);
    viewport.scale = 2;
    viewport.height = 437;
    viewport.fire("resize");
    viewport.fire("scroll");
    expect(style.has("--app-height")).toBe(false);
    expect(scrolledTo).toEqual([]);
  });

  test("stopping gives the page its full height back and listens no more", () => {
    const viewport = visualViewport(520);
    const stop = followVisualViewport(viewport as unknown as VisualViewport);
    expect(style.get("--app-height")).toBe("520px");
    stop();
    expect(style.has("--app-height")).toBe(false);
    expect(touchListeners.get("touchmove")?.size ?? 0).toBe(0);
    viewport.fire("resize");
    expect(style.has("--app-height")).toBe(false);
  });

  test("a pan under a finger and its momentum is undone once, after the page stopped, not at every step", () => {
    // The iPhone's trace of 2026-11-05 23:21: with the keyboard up, the visible area's top went 32, 43, 5, 9, 14 …
    // for two seconds as a drag and its momentum panned the page and the page was pulled back at every step.
    vi.useFakeTimers();
    const viewport = visualViewport(478);
    (document.documentElement as unknown as { clientHeight: number }).clientHeight = 812;
    followVisualViewport(viewport as unknown as VisualViewport);
    scrolledTo.length = 0;
    const chat = new Box();
    touch("touchstart", chat, [[200, 300]]);
    for (const top of [32, 43, 5, 9, 14]) {
      viewport.offsetTop = top;
      viewport.fire("scroll");
    }
    expect(scrolledTo).toEqual([]);
    // The finger lifts; the momentum goes on a little.
    touch("touchend", chat, []);
    vi.advanceTimersByTime(PAN_SETTLE_MS - 50);
    viewport.offsetTop = 18;
    viewport.fire("scroll");
    vi.advanceTimersByTime(PAN_SETTLE_MS - 1);
    expect(scrolledTo).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(scrolledTo).toEqual([[0, 0]]);
  });

  test("a pan with no finger on the screen, iOS bringing the focused box into view, is undone at once", () => {
    const viewport = visualViewport(478);
    (document.documentElement as unknown as { clientHeight: number }).clientHeight = 812;
    followVisualViewport(viewport as unknown as VisualViewport);
    scrolledTo.length = 0;
    viewport.offsetTop = 150;
    viewport.fire("scroll");
    expect(scrolledTo).toEqual([[0, 0]]);
  });
});

describe("drags while the keyboard is up", () => {
  const keyboardUp = () => {
    const viewport = visualViewport(812);
    (document.documentElement as unknown as { clientHeight: number }).clientHeight = 812;
    const stop = followVisualViewport(viewport as unknown as VisualViewport);
    viewport.height = 478;
    viewport.fire("resize");
    return { viewport, stop };
  };
  const drag = (target: Box, dx: number, dy: number) => {
    touch("touchstart", target, [[200, 300]]);
    const stopped = touch("touchmove", target, [[200 + dx, 300 + dy]]);
    touch("touchend", target, []);
    return stopped;
  };
  /** The page's parts: the top bar, the chat's transcript (a long one), the key row (sideways), the message box. */
  const parts = () => {
    const main = new Box();
    const topBar = new Box({ parentElement: main });
    const transcript = new Box({
      parentElement: main,
      overflowY: "auto",
      scrollHeight: 4000,
      clientHeight: 200,
    });
    const row = new Box({ parentElement: transcript });
    const keys = new Box({
      parentElement: main,
      overflowX: "auto",
      overflowY: "auto",
      scrollWidth: 620,
      clientWidth: 390,
      scrollHeight: 52,
      clientHeight: 52,
    });
    const key = new Box({ parentElement: keys });
    const box = new Field({
      parentElement: main,
      overflowY: "auto",
      scrollHeight: 40,
      clientHeight: 40,
    });
    return { topBar, row, key, box };
  };

  test("a drag no box can take is stopped, and only while the keyboard is up", () => {
    const { topBar, box } = parts();
    const viewport = visualViewport(874);
    (document.documentElement as unknown as { clientHeight: number }).clientHeight = 874;
    followVisualViewport(viewport as unknown as VisualViewport);
    expect(drag(topBar, 0, -40)).toBe(false);

    viewport.height = 478;
    viewport.fire("resize");
    expect(drag(topBar, 0, -40)).toBe(true);
    // A message box with nothing to scroll does not hand the drag to the page either.
    expect(drag(box, 0, 40)).toBe(true);

    viewport.height = 874;
    viewport.fire("resize");
    expect(drag(topBar, 0, -40)).toBe(false);
  });

  test("a box that scrolls along the drag takes it: the transcript up and down, the key row sideways", () => {
    keyboardUp();
    const { row, key } = parts();
    expect(drag(row, 0, -60)).toBe(false);
    expect(drag(row, 0, 60)).toBe(false);
    expect(drag(key, -80, 4)).toBe(false);
    // The key row scrolls only sideways: a drag up or down on it would pan the page.
    expect(drag(key, 3, -50)).toBe(true);
  });

  test("a pinch, and a drag on the focused box (its caret and selection), go on", () => {
    keyboardUp();
    const { topBar, box } = parts();
    touch("touchstart", topBar, [
      [100, 300],
      [200, 300],
    ]);
    expect(
      touch("touchmove", topBar, [
        [90, 310],
        [210, 290],
      ]),
    ).toBe(false);
    touch("touchend", topBar, []);
    // iOS moves the caret with a finger held on the focused box, with or without a selection.
    page.activeElement = box;
    expect(drag(box, 30, 2)).toBe(false);
    expect(drag(box, 0, 40)).toBe(false);
    box.selectionStart = 2;
    box.selectionEnd = 9;
    expect(drag(box, -30, 0)).toBe(false);
  });
});
