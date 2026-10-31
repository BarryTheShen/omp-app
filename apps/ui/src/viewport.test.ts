import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { followVisualViewport } from "./viewport";

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

const style = new Map<string, string>();
const scrolledTo: [number, number][] = [];

beforeEach(() => {
  style.clear();
  scrolledTo.length = 0;
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
  });
});
afterEach(() => vi.unstubAllGlobals());

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
    const page = document.documentElement as unknown as { clientHeight: number };
    page.clientHeight = 812;
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
    viewport.fire("resize");
    expect(style.has("--app-height")).toBe(false);
  });
});
