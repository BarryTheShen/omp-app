import { describe, expect, test, vi } from "vitest";
import {
  captureVisibleMessageAnchor,
  claimOwnAnchoring,
  dropPlaceUntilLayout,
  forgetRetainedScroll,
  holdReaderPlace,
  isHoldingPlace,
  keepReaderPlace,
  keepUnheldReaderPlace,
  readerPlaceOf,
  rememberReaderPlace,
  retainVisibleMessageAnchor,
  takePlaceAfterLayout,
  takeRetainedScroll,
} from "./anchor";

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

describe("captureVisibleMessageAnchor", () => {
  test("anchors on the message row in the middle of the view when the top edge shows a control", () => {
    // Issue 1165: the "Show earlier messages" control sits at the top while the reader is at the top of the chat.
    // The old capture found nothing there, so the viewport was never compensated and the row moved on screen.
    const viewport = document.createElement("div");
    const control = document.createElement("button");
    const row = document.createElement("div");
    row.dataset.messageId = "entry:thread:a";
    viewport.append(control, row);
    document.body.append(viewport);
    viewport.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 800, height: 900 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: 400 }) as DOMRect;
    const original = document.elementFromPoint;
    document.elementFromPoint = (_x: number, y: number) => (y < 300 ? control : row);
    try {
      const anchor = captureVisibleMessageAnchor(viewport);
      expect(anchor?.row).toBe(row);
      expect(anchor?.offset).toBe(300);
    } finally {
      document.elementFromPoint = original;
      viewport.remove();
    }
  });
});

describe("the anchor is the row where the reader is", () => {
  test("anchors on the row in the middle of the view, not on the row at the top edge", () => {
    // Issue 1165: a tool card that opens between the top edge and the reader's row moves that row. An anchor on the
    // top edge does not see that change, so the reader's row jumped.
    const viewport = document.createElement("div");
    const topRow = document.createElement("div");
    const middleRow = document.createElement("div");
    topRow.dataset.messageId = "entry:thread:top";
    middleRow.dataset.messageId = "entry:thread:middle";
    viewport.append(topRow, middleRow);
    document.body.append(viewport);
    viewport.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 800, height: 900 }) as DOMRect;
    topRow.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
    middleRow.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
    const original = document.elementFromPoint;
    document.elementFromPoint = (_x: number, y: number) => (y < 300 ? topRow : middleRow);
    try {
      expect(captureVisibleMessageAnchor(viewport)?.row).toBe(middleRow);
    } finally {
      document.elementFromPoint = original;
      viewport.remove();
    }
  });
});

describe("a retained scroll", () => {
  test("a scroll to the position a retain set is the app's move: it is taken once, and the next one is the reader's", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    state.rowTop += 120;
    retainVisibleMessageAnchor(viewport, { row, offset: 30, scrollTop: 1_000 });
    expect(takeRetainedScroll(viewport)).toBe(true);
    expect(takeRetainedScroll(viewport)).toBe(false);
  });

  test("a scroll to another position is the reader's, even after a retain", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    state.rowTop += 120;
    retainVisibleMessageAnchor(viewport, { row, offset: 30, scrollTop: 1_000 });
    viewport.scrollTop = 1_300;
    expect(takeRetainedScroll(viewport)).toBe(false);
  });

  test("forgetting the retained scroll makes a scroll to its position the reader's", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    state.rowTop += 120;
    retainVisibleMessageAnchor(viewport, { row, offset: 30, scrollTop: 1_000 });
    forgetRetainedScroll(viewport);
    expect(takeRetainedScroll(viewport)).toBe(false);
  });
});

describe("captureVisibleMessageAnchor when no probe point lands on a row", () => {
  test("the first message row that reaches into the view is the anchor, so a short row at the top of an empty view holds", () => {
    // Issue 1165, review of PR 1193: the newest message is short and sits at the top of the view, with empty space below it.
    // Neither probe point lands on it. A row wholly above the view is skipped.
    const viewport = document.createElement("div");
    const above = document.createElement("div");
    const row = document.createElement("div");
    above.dataset.messageId = "entry:thread:earlier";
    row.dataset.messageId = "entry:thread:newest";
    viewport.append(above, row);
    document.body.append(viewport);
    viewport.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 800, height: 900, bottom: 1000 }) as DOMRect;
    above.getBoundingClientRect = () => ({ top: 40, bottom: 90 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: 120, bottom: 200 }) as DOMRect;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => viewport;
    try {
      const anchor = captureVisibleMessageAnchor(viewport);
      expect(anchor?.row).toBe(row);
      expect(anchor?.offset).toBe(20);
    } finally {
      document.elementFromPoint = original;
      viewport.remove();
    }
  });
});

describe("keepReaderPlace", () => {
  test("keeps the place a retain gave through a later layout change", () => {
    const { viewport, row, state } = fixture({ scrollTop: 1_000, rowTop: 30 });
    rememberReaderPlace(viewport, { row, offset: 30, scrollTop: 1_000 });
    state.rowTop += 120;
    keepReaderPlace(viewport);
    expect(state.rowTop).toBe(30);
    state.rowTop += 50;
    keepReaderPlace(viewport);
    expect(state.rowTop).toBe(30);
  });
});

describe("keepReaderPlace after the reader jumps away", () => {
  /** A place 355 px below the view's top, in a view that spans 100 to 600 on screen. */
  function jumpFixture() {
    const fixed = fixture({ scrollTop: 7_305, rowTop: 355 });
    fixed.viewport.getBoundingClientRect = () =>
      ({ left: 0, top: 100, width: 800, height: 500, bottom: 600 }) as DOMRect;
    fixed.row.getBoundingClientRect = () =>
      ({ top: 100 + fixed.state.rowTop, bottom: 172 + fixed.state.rowTop }) as DOMRect;
    return fixed;
  }

  test("a Home jump not yet reported does not pull the reader back to the old place", () => {
    const { viewport, row, state } = jumpFixture();
    const currentRow = document.createElement("div");
    currentRow.dataset.messageId = "entry:thread:current";
    viewport.append(currentRow);
    currentRow.getBoundingClientRect = () => ({ top: 280, bottom: 352 }) as DOMRect;
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => currentRow;
    try {
      rememberReaderPlace(viewport, { row, offset: 355, scrollTop: 7_305 });
      // The view moves to the top, and the rows drawn there grow by 676 px above the old place, which is now far below.
      viewport.scrollTop = 173;
      state.rowTop += 676;
      keepReaderPlace(viewport);
      expect(state.scrollTop).toBe(173);
      expect(readerPlaceOf(viewport)?.row).toBe(currentRow);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
      viewport.remove();
    }
  });

  test("while the place is held, a scroll away does not replace it and layout compensation still runs", () => {
    const { viewport, row, state } = jumpFixture();
    rememberReaderPlace(viewport, { row, offset: 355, scrollTop: 7_305 });
    const release = holdReaderPlace(viewport, 60_000);
    try {
      expect(isHoldingPlace(viewport)).toBe(true);
      viewport.scrollTop = 6_500;
      state.rowTop += 80;
      keepReaderPlace(viewport);
      expect(state.scrollTop).toBe(6_580);
      expect(state.rowTop).toBe(1_160);
      expect(readerPlaceOf(viewport)?.row).toBe(row);
    } finally {
      release();
      viewport.remove();
    }
  });

  test("a small scroll that keeps the place on screen still has a layout change above it undone", () => {
    const { viewport, row, state } = jumpFixture();
    rememberReaderPlace(viewport, { row, offset: 355, scrollTop: 7_305 });
    viewport.scrollTop = 7_405;
    state.rowTop += 80;
    keepReaderPlace(viewport);
    expect(state.scrollTop).toBe(7_485);
    expect(state.rowTop).toBe(255);
  });
});

describe("own anchoring claims", () => {
  test("the browser's anchoring stays off until the last claim on a viewport is released, and a claim releases once", () => {
    const viewport = document.createElement("div");
    const first = claimOwnAnchoring(viewport);
    const second = claimOwnAnchoring(viewport);
    expect(viewport.style.overflowAnchor).toBe("none");
    first();
    first();
    expect(viewport.style.overflowAnchor).toBe("none");
    second();
    expect(viewport.style.overflowAnchor).toBe("");
  });

  test("two overlapping holds keep the place held until the second one ends", () => {
    vi.useFakeTimers();
    try {
      const { viewport } = fixture({ scrollTop: 400, rowTop: 10 });
      const endFirst = holdReaderPlace(viewport, 1_000);
      const endSecond = holdReaderPlace(viewport, 5_000);
      endFirst();
      expect(isHoldingPlace(viewport)).toBe(true);
      expect(viewport.style.overflowAnchor).toBe("none");
      endSecond();
      expect(isHoldingPlace(viewport)).toBe(false);
      expect(viewport.style.overflowAnchor).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the place after a scroll the reader did not make", () => {
  /** The fixture's row, with the viewport spanning 100 to 500 on screen so that the probe in its middle finds the row. */
  function probedFixture(options: { scrollTop: number; rowTop: number }) {
    const fixed = fixture(options);
    const { viewport, row, state } = fixed;
    row.dataset.messageId = "entry:thread:row";
    viewport.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 400, width: 400, height: 400 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({
        top: 100 + state.rowTop,
        bottom: 300 + state.rowTop,
        left: 0,
        right: 400,
        width: 400,
        height: 200,
      }) as DOMRect;
    return fixed;
  }

  /** Runs `run` with the probe finding `row` wherever it looks. */
  function withProbe(row: HTMLElement, run: () => void): void {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      run();
    } finally {
      document.elementFromPoint = original;
    }
  }

  test("a dropped place is taken again after the layout that drew the rows, and that layout does not move the view", () => {
    const { viewport, row, state } = probedFixture({ scrollTop: 1_000, rowTop: 30 });
    withProbe(row, () => {
      rememberReaderPlace(viewport, { row, offset: 30, scrollTop: 1_000 });
      dropPlaceUntilLayout(viewport);
      expect(readerPlaceOf(viewport)).toBeNull();
      // The layout drew the rows above the row: they are taller than their estimates.
      state.rowTop += 120;
      keepUnheldReaderPlace(viewport);
      expect(state.scrollTop).toBe(1_000);
      expect(readerPlaceOf(viewport)?.offset).toBe(150);
    });
  });

  test("the place taken after the layout is kept through the layout changes that follow", () => {
    const { viewport, row, state } = probedFixture({ scrollTop: 1_000, rowTop: 30 });
    withProbe(row, () => {
      rememberReaderPlace(viewport, { row, offset: 30, scrollTop: 1_000 });
      dropPlaceUntilLayout(viewport);
      state.rowTop += 120;
      keepUnheldReaderPlace(viewport);
      state.rowTop += 80;
      keepUnheldReaderPlace(viewport);
      expect(state.scrollTop).toBe(1_080);
    });
  });

  test("at the start of the chat a layout change leaves the view at the start", () => {
    const { viewport, row, state } = probedFixture({ scrollTop: 0, rowTop: 30 });
    withProbe(row, () => {
      rememberReaderPlace(viewport, { row, offset: 30, scrollTop: 0 });
      // The rows above the row were drawn at their real heights: 468 px taller than their estimates.
      state.rowTop += 468;
      keepUnheldReaderPlace(viewport);
      expect(state.scrollTop).toBe(0);
    });
  });

  test("while the app holds the place, a layout change at the start is still undone, as before", () => {
    const { viewport, row, state } = probedFixture({ scrollTop: 0, rowTop: 30 });
    withProbe(row, () => {
      rememberReaderPlace(viewport, { row, offset: 30, scrollTop: 0 });
      const endHold = holdReaderPlace(viewport, 60_000);
      state.rowTop += 120;
      keepUnheldReaderPlace(viewport);
      expect(state.scrollTop).toBe(120);
      endHold();
    });
  });

  test("a dropped place is taken once", () => {
    const { viewport } = probedFixture({ scrollTop: 0, rowTop: 30 });
    dropPlaceUntilLayout(viewport);
    expect(takePlaceAfterLayout(viewport)).toBe(true);
    expect(takePlaceAfterLayout(viewport)).toBe(false);
  });
});
