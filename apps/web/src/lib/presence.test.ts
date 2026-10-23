import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENTER_MS, LEAVE_MS } from "./motion";
import { mergePresence, type Presence, useEnteringItems, usePresentItems } from "./presence";

type Row = { readonly id: string };
const key = (row: Row): string => row.id;

/** The rows as text: a leaving row ends in "-leaving", an entering one in "+". */
function labels(list: readonly Presence<Row>[]): string[] {
  return list.map(
    (entry) => `${entry.item.id}${entry.leaving ? "-leaving" : ""}${entry.entering ? "+" : ""}`,
  );
}

/** The frames the hooks have asked the browser to draw. A test draws one by running the callbacks queued so far. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function drawFrame(): void {
  const pending = [...frames.values()];
  frames = new Map();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  frames = new Map();
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mergePresence", () => {
  test("the first draw keeps the list's order and enters nothing", () => {
    const first = mergePresence<Row>(null, [{ id: "a" }, { id: "b" }], key, true);
    expect(labels(first)).toEqual(["a", "b"]);
  });

  test("a row that joins after the first draw enters, in its place in the list", () => {
    const before = mergePresence<Row>(null, [{ id: "a" }, { id: "c" }], key, true);
    const after = mergePresence(before, [{ id: "a" }, { id: "b" }, { id: "c" }], key, true);
    expect(labels(after)).toEqual(["a", "b+", "c"]);
  });

  test("a row that leaves stays where it was, marked leaving, while leaving is kept", () => {
    const before = mergePresence<Row>(null, [{ id: "a" }, { id: "b" }, { id: "c" }], key, true);
    const after = mergePresence(before, [{ id: "a" }, { id: "c" }], key, true);
    expect(labels(after)).toEqual(["a", "b-leaving", "c"]);
  });

  test("a row that leaves is dropped at once when leaving is not kept (reduced motion)", () => {
    const before = mergePresence<Row>(null, [{ id: "a" }, { id: "b" }], key, true);
    const after = mergePresence(before, [{ id: "a" }], key, false);
    expect(labels(after)).toEqual(["a"]);
  });

  test("a row that comes back while it leaves is present again, and does not enter", () => {
    const before = mergePresence<Row>(null, [{ id: "a" }, { id: "b" }], key, true);
    const gone = mergePresence(before, [{ id: "a" }], key, true);
    const back = mergePresence(gone, [{ id: "a" }, { id: "b" }], key, true);
    expect(labels(back)).toEqual(["a", "b"]);
  });
});

describe("useEnteringItems", () => {
  test("once the list has loaded, a row that joins enters, and a row that leaves is dropped at once", () => {
    const { result, rerender } = renderHook(
      ({ items }: { readonly items: readonly Row[] }) => useEnteringItems(items, key, true),
      { initialProps: { items: [{ id: "a" }] } },
    );
    expect(labels(result.current)).toEqual(["a"]);

    rerender({ items: [{ id: "a" }, { id: "b" }] });
    expect(labels(result.current)).toEqual(["a", "b+"]);

    // The list changes again before b's fade has been drawn: a is dropped at once, and b still enters.
    rerender({ items: [{ id: "b" }] });
    expect(labels(result.current)).toEqual(["b+"]);

    // Two frames draw the fade's start, then its time runs: b is an ordinary row again.
    act(() => {
      drawFrame();
      drawFrame();
    });
    act(() => {
      vi.advanceTimersByTime(ENTER_MS);
    });
    expect(labels(result.current)).toEqual(["b"]);
  });

  test("the rows a list loads with enter nothing, including when they arrive with the load itself", () => {
    const { result, rerender } = renderHook(
      ({ items, armed }: { readonly items: readonly Row[]; readonly armed: boolean }) =>
        useEnteringItems(items, key, armed),
      { initialProps: { items: [] as Row[], armed: false } },
    );
    rerender({ items: [{ id: "a" }, { id: "b" }], armed: true });
    expect(labels(result.current)).toEqual(["a", "b"]);

    rerender({ items: [{ id: "a" }, { id: "b" }, { id: "c" }], armed: true });
    expect(labels(result.current)).toEqual(["a", "b", "c+"]);
  });
});

describe("usePresentItems", () => {
  test("rows loaded while the catalog is unarmed do not enter, but later rows do", () => {
    const { result, rerender } = renderHook(
      ({ items, armed }: { readonly items: readonly Row[]; readonly armed: boolean }) =>
        usePresentItems(items, key, LEAVE_MS, armed),
      { initialProps: { items: [] as Row[], armed: false } },
    );
    rerender({ items: [{ id: "a" }], armed: true });
    expect(labels(result.current)).toEqual(["a"]);

    rerender({ items: [{ id: "a" }, { id: "b" }], armed: true });
    expect(labels(result.current)).toEqual(["a", "b+"]);
  });

  test("a row that joins keeps its entering class until its fade has been drawn, though the list changes first", () => {
    const { result, rerender } = renderHook(
      ({ items }: { readonly items: readonly Row[] }) => usePresentItems(items, key, LEAVE_MS),
      { initialProps: { items: [{ id: "a" }] } },
    );
    rerender({ items: [{ id: "a" }, { id: "b" }] });
    expect(labels(result.current)).toEqual(["a", "b+"]);

    rerender({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(labels(result.current)).toEqual(["a", "b+", "c+"]);

    act(() => {
      drawFrame();
      drawFrame();
    });
    act(() => {
      vi.advanceTimersByTime(ENTER_MS);
    });
    expect(labels(result.current)).toEqual(["a", "b", "c"]);
  });

  test("a leaving row is removed only after two frames have been drawn and its fade has run", () => {
    const { result, rerender } = renderHook(
      ({ items }: { readonly items: readonly Row[] }) => usePresentItems(items, key, LEAVE_MS),
      { initialProps: { items: [{ id: "a" }, { id: "b" }] } },
    );
    rerender({ items: [{ id: "a" }] });
    expect(labels(result.current)).toEqual(["a", "b-leaving"]);

    // A timer alone does not remove the row: its fade must have been drawn first.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(labels(result.current)).toEqual(["a", "b-leaving"]);

    act(() => {
      drawFrame();
      drawFrame();
    });
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS - 1);
    });
    expect(labels(result.current)).toEqual(["a", "b-leaving"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(labels(result.current)).toEqual(["a"]);
  });
});
