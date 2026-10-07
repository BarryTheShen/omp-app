import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scrollToLatest } from "./scroll-to-latest";

type Frame = () => void;
let frames: Frame[] = [];

function runFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const due = frames;
    frames = [];
    for (const frame of due) frame();
  }
}

/** A viewport whose content grows each time it is scrolled, like rows drawn lazily on the way down. */
function growingViewport(growth: readonly number[]) {
  const viewport = document.createElement("div");
  const state = { scrollHeight: 1_000, scrollTop: 0, scrolls: 0 };
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => state.scrollHeight,
  });
  Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => state.scrollTop });
  viewport.scrollTo = ((options: ScrollToOptions) => {
    state.scrollTop = Math.min(options.top ?? 0, state.scrollHeight - 200);
    state.scrolls += 1;
    state.scrollHeight += growth[state.scrolls - 1] ?? 0;
  }) as typeof viewport.scrollTo;
  return { viewport, state };
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: Frame) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("scrollToLatest", () => {
  test("keeps scrolling while the bottom keeps moving, and lands on the real bottom", () => {
    const { viewport, state } = growingViewport([300, 200, 0]);
    scrollToLatest(viewport);
    runFrames(10);
    // 1,000 + 300 + 200 = 1,500 px of content in a 200 px viewport: the bottom is at 1,300.
    expect(state.scrollTop).toBe(1_300);
  });

  test("stops by itself once the bottom has stayed put", () => {
    const { viewport, state } = growingViewport([]);
    scrollToLatest(viewport);
    runFrames(20);
    expect(state.scrolls).toBeLessThanOrEqual(4);
    expect(frames).toHaveLength(0);
  });

  test("gives up on a bottom that never stops moving", () => {
    const { viewport, state } = growingViewport(Array.from({ length: 100 }, () => 50));
    scrollToLatest(viewport);
    runFrames(100);
    expect(state.scrolls).toBe(30);
  });

  test.each(["wheel", "touchstart", "touchmove", "pointerdown", "keydown"])(
    "stops when the reader takes over (%s), so it never fights them",
    (input) => {
      const { viewport, state } = growingViewport(Array.from({ length: 100 }, () => 50));
      scrollToLatest(viewport);
      runFrames(2);
      viewport.dispatchEvent(new Event(input));
      const scrollsWhenTheyTookOver = state.scrolls;
      runFrames(10);
      expect(state.scrolls).toBe(scrollsWhenTheyTookOver);
    },
  );

  test("the function it returns stops it", () => {
    const { viewport, state } = growingViewport(Array.from({ length: 100 }, () => 50));
    const stop = scrollToLatest(viewport);
    runFrames(2);
    stop();
    const scrolls = state.scrolls;
    runFrames(10);
    expect(state.scrolls).toBe(scrolls);
  });
});
