import { describe, expect, test } from "vitest";
import { retainVisibleMessageAnchor } from "./anchor";

/** A viewport and one message row with a controlled position: the row's top is `rowTop` on screen. */
function fixture(options: { scrollTop: number; rowTop: number }) {
  const viewport = document.createElement("div");
  const row = document.createElement("div");
  viewport.append(row);
  document.body.append(viewport);
  const state = { scrollTop: options.scrollTop, rowTop: options.rowTop };
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      // Scrolling by `value - scrollTop` moves the row by the opposite amount.
      state.rowTop -= value - state.scrollTop;
      state.scrollTop = value;
    },
  });
  viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 100 + state.rowTop }) as DOMRect;
  return { viewport, row, state };
}

describe("retainVisibleMessageAnchor", () => {
  test("moves the viewport by what the layout shifted the row, so the row stays where it was", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    const anchor = { row, offset: 30, scrollTop: 1_000 };
    // Content above the row grew by 120 px: the row is pushed down on screen.
    state.rowTop += 120;
    retainVisibleMessageAnchor(viewport, anchor);
    expect(state.scrollTop).toBe(1_120);
    expect(state.rowTop).toBe(30);
  });

  test("does not undo the reader's own scrolling, such as an animated jump to the latest message", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    const anchor = { row, offset: 30, scrollTop: 1_000 };
    // The reader (or a jump) scrolled down 500 px; no layout changed.
    viewport.scrollTop = 1_500;
    retainVisibleMessageAnchor(viewport, anchor);
    expect(state.scrollTop).toBe(1_500);
  });

  test("when the reader scrolled and the layout shifted too, it undoes only the shift", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    const anchor = { row, offset: 30, scrollTop: 1_000 };
    viewport.scrollTop = 1_300;
    state.rowTop += 80;
    retainVisibleMessageAnchor(viewport, anchor);
    expect(state.scrollTop).toBe(1_380);
  });

  test("does nothing without an anchor or when its row left the page", () => {
    const { viewport, row, state } = fixture({ scrollTop: 400, rowTop: 10 });
    retainVisibleMessageAnchor(viewport, null);
    row.remove();
    retainVisibleMessageAnchor(viewport, { row, offset: 10, scrollTop: 0 });
    expect(state.scrollTop).toBe(400);
  });
});
