import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_OLDER_PAGES, type ReadingPlace } from "./reading-place";
import { type ReadingPlaceOptions, useReadingPlace } from "./use-reading-place";

const KEY = "omp.app.reading-place.thread-1";
const saved: ReadingPlace = { threadId: "thread-1", messageId: "msg-7", offset: 30 };

/** The resize callbacks the hook has registered; `resize()` runs them, as a browser does after a layout change. */
let resizeCallbacks: Array<() => void> = [];

class FakeResizeObserver {
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  observe(): void {
    resizeCallbacks.push(this.callback);
  }

  unobserve(): void {}

  disconnect(): void {
    resizeCallbacks = resizeCallbacks.filter((entry) => entry !== this.callback);
  }
}

function resize(): void {
  for (const callback of [...resizeCallbacks]) callback();
}

interface Transcript {
  readonly viewport: HTMLElement;
  readonly state: { scrollTop: number; scrollHeight: number; clientHeight: number };
  addRow(messageId: string, contentTop: number): HTMLElement;
  moveRow(messageId: string, contentTop: number): void;
}

/**
 * A 600 px viewport whose rows keep their place in the content: scrolling moves them on screen, as a
 * browser does, and `moveRow` changes where a row sits in the content, as a row taking its real height does.
 * The viewport's top edge is at 100 px on screen, and the content is 3,000 px tall.
 */
function transcript(rows: Record<string, number>): Transcript {
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const state = { scrollTop: 0, scrollHeight: 3_000, clientHeight: 600 };
  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = Math.min(Math.max(0, value), state.scrollHeight - state.clientHeight);
      },
    },
    scrollHeight: { configurable: true, get: () => state.scrollHeight },
    clientHeight: { configurable: true, get: () => state.clientHeight },
  });
  viewport.getBoundingClientRect = () =>
    ({ top: 100, left: 0, width: 800, height: 600 }) as DOMRect;
  const contentTops = new Map<string, number>();
  const addRow = (messageId: string, contentTop: number): HTMLElement => {
    const row = document.createElement("div");
    row.dataset.messageId = messageId;
    viewport.append(row);
    contentTops.set(messageId, contentTop);
    row.getBoundingClientRect = () =>
      ({
        top: 100 + (contentTops.get(messageId) ?? 0) - state.scrollTop,
        left: 0,
        width: 800,
        height: 200,
      }) as DOMRect;
    return row;
  };
  const moveRow = (messageId: string, contentTop: number): void => {
    contentTops.set(messageId, contentTop);
  };
  for (const [messageId, contentTop] of Object.entries(rows)) addRow(messageId, contentTop);
  return { viewport, state, addRow, moveRow };
}

function options(overrides: Partial<ReadingPlaceOptions>): ReadingPlaceOptions {
  return {
    viewportRef: { current: null },
    threadId: "thread-1",
    resumeAt: saved,
    historyLoading: false,
    messageOrder: ["msg-7"],
    hasOlder: false,
    loadOlder: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  window.localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("useReadingPlace on a reload", () => {
  test("places the saved message at its saved offset once it is on screen, and holds it there", () => {
    const { viewport } = transcript({ "msg-7": 500 });
    const { result } = renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport } })),
    );
    // The message sat 500 px into the content; the reader was 30 px below the viewport's top edge.
    expect(viewport.scrollTop).toBe(470);
    expect(result.current).toEqual({ startsAtPlace: true, resuming: true });
  });

  test("waits for the history to finish loading before placing the reader", () => {
    const { viewport } = transcript({ "msg-7": 500 });
    const { result, rerender } = renderHook(
      (props: ReadingPlaceOptions) => useReadingPlace(props),
      {
        initialProps: options({ viewportRef: { current: viewport }, historyLoading: true }),
      },
    );
    expect(viewport.scrollTop).toBe(0);
    expect(result.current.resuming).toBe(true);

    rerender(options({ viewportRef: { current: viewport }, historyLoading: false }));
    expect(viewport.scrollTop).toBe(470);
  });

  test("places the reader once the saved message is drawn a moment after the history arrives", async () => {
    const { viewport, addRow } = transcript({});
    renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport }, messageOrder: ["msg-7"] })),
    );
    // The store has the message; assistant-ui draws its row only a moment later.
    requestAnimationFrame(() => addRow("msg-7", 500));
    await waitFor(() => expect(viewport.scrollTop).toBe(470));
  });

  test("waits until the transcript has drawn its oldest and newest messages before giving up on the saved one", async () => {
    const { viewport, addRow } = transcript({ "msg-9": 2_000 });
    renderHook(() =>
      useReadingPlace(
        options({
          viewportRef: { current: viewport },
          messageOrder: ["msg-0", "msg-7", "msg-9"],
        }),
      ),
    );
    // A long transcript draws its older rows a few frames after the store has them, in one batch.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          addRow("msg-0", 0);
          addRow("msg-7", 500);
        }),
      ),
    );
    await waitFor(() => expect(viewport.scrollTop).toBe(470));
  });

  test("pages in older history until the saved message is loaded, then places the reader", async () => {
    const { viewport, addRow } = transcript({ "msg-9": 2_000 });
    let finishPage: () => void = () => undefined;
    const loadOlder = vi.fn(() => {
      const { promise, resolve } = Promise.withResolvers<void>();
      finishPage = () => {
        addRow("msg-7", 500);
        resolve();
      };
      return promise;
    });
    const { rerender } = renderHook((props: ReadingPlaceOptions) => useReadingPlace(props), {
      initialProps: options({
        viewportRef: { current: viewport },
        messageOrder: ["msg-9"],
        hasOlder: true,
        loadOlder,
      }),
    });
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));

    await act(async () => {
      finishPage();
    });
    rerender(
      options({
        viewportRef: { current: viewport },
        messageOrder: ["msg-7", "msg-9"],
        hasOlder: false,
        loadOlder,
      }),
    );
    await waitFor(() => expect(viewport.scrollTop).toBe(470));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  test("opens at the newest message when an older page adds nothing, instead of paging forever", async () => {
    const { viewport } = transcript({ "msg-9": 2_000 });
    const loadOlder = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useReadingPlace(
        options({
          viewportRef: { current: viewport },
          messageOrder: ["msg-9"],
          hasOlder: true,
          loadOlder,
        }),
      ),
    );
    await waitFor(() => expect(viewport.scrollTop).toBe(2_400));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(result.current.resuming).toBe(false);
  });

  test("opens at the newest message when no older history is left and the saved message is not there", async () => {
    const { viewport } = transcript({ "msg-9": 2_000 });
    const { result } = renderHook(() =>
      useReadingPlace(
        options({ viewportRef: { current: viewport }, messageOrder: ["msg-9"], hasOlder: false }),
      ),
    );
    await waitFor(() => expect(viewport.scrollTop).toBe(2_400));
    expect(result.current.resuming).toBe(false);
  });

  test("stops paging after the page limit and opens at the newest message", async () => {
    const { viewport, addRow } = transcript({ "msg-9": 2_000 });
    let pages = 0;
    const { result } = renderHook(() => {
      const [order, setOrder] = useState<string[]>(["msg-9"]);
      const loadOlder = useCallback(async () => {
        pages += 1;
        const messageId = `older-${pages}`;
        addRow(messageId, 0);
        setOrder((previous) => [messageId, ...previous]);
      }, []);
      return useReadingPlace(
        options({
          viewportRef: { current: viewport },
          messageOrder: order,
          hasOlder: true,
          loadOlder,
        }),
      );
    });
    await waitFor(() => expect(viewport.scrollTop).toBe(2_400), { timeout: 10_000 });
    expect(pages).toBe(MAX_OLDER_PAGES);
    expect(result.current.resuming).toBe(false);
  });

  test("a place saved for another chat is never applied to this one", () => {
    const { viewport } = transcript({ "msg-7": 500 });
    const { result } = renderHook(() =>
      useReadingPlace(
        options({
          viewportRef: { current: viewport },
          resumeAt: { ...saved, threadId: "thread-2" },
        }),
      ),
    );
    expect(viewport.scrollTop).toBe(0);
    expect(result.current).toEqual({ startsAtPlace: false, resuming: false });
  });

  test("keeps the saved message at its offset while the rows above it take their real heights", () => {
    const { viewport, moveRow } = transcript({ "msg-7": 500 });
    renderHook(() => useReadingPlace(options({ viewportRef: { current: viewport } })));
    expect(viewport.scrollTop).toBe(470);

    // Rows above the message grew by 120 px once they were laid out: the message moved down on screen.
    moveRow("msg-7", 620);
    resize();
    expect(viewport.scrollTop).toBe(590);
  });

  test("stops keeping the place once the reader scrolls", () => {
    const { viewport, moveRow } = transcript({ "msg-7": 500 });
    const { result } = renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport } })),
    );
    act(() => {
      viewport.dispatchEvent(new Event("wheel"));
    });
    expect(result.current.resuming).toBe(false);

    moveRow("msg-7", 620);
    resize();
    expect(viewport.scrollTop).toBe(470);
  });
});

describe("useReadingPlace while the reader scrolls", () => {
  test("saves the message at the top of the transcript, and forgets it again at the bottom", async () => {
    const { viewport, addRow, state } = transcript({});
    const row = addRow("msg-7", 500);
    // The browser reports the row under the point 5% down the viewport: this stands in for it.
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => row });
    renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport }, resumeAt: null })),
    );

    viewport.scrollTop = 470;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(window.localStorage.getItem(KEY)).toBe(
        JSON.stringify({ threadId: "thread-1", messageId: "msg-7", offset: 30 }),
      ),
    );

    state.scrollTop = state.scrollHeight - state.clientHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull());
  });

  test("does not save anything while the saved place is still being restored", async () => {
    const { viewport, addRow } = transcript({});
    const row = addRow("msg-7", 500);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => row });
    renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport }, historyLoading: true })),
    );
    viewport.scrollTop = 470;
    viewport.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("never saves a message that is still streaming, whose id does not exist after a reload", async () => {
    const { viewport, addRow } = transcript({});
    const row = addRow("msg-7", 500);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => row });
    renderHook(() =>
      useReadingPlace(options({ viewportRef: { current: viewport }, resumeAt: null })),
    );
    viewport.scrollTop = 470;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(window.localStorage.getItem(KEY)).not.toBeNull());

    const streaming = addRow("stream:reply-1", 900);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => streaming,
    });
    viewport.scrollTop = 900;
    viewport.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")?.messageId).toBe("msg-7");
  });
});
