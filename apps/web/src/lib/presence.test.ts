import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { mergePresence, type Presence, useEnteringItems, usePresentItems } from "./presence";

type Row = { readonly id: string };
const key = (row: Row): string => row.id;

/** The rows as text: a leaving row ends in "-leaving", an entering one in "+". */
function labels(list: readonly Presence<Row>[]): string[] {
  return list.map(
    (entry) => `${entry.item.id}${entry.leaving ? "-leaving" : ""}${entry.entering ? "+" : ""}`,
  );
}

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

    rerender({ items: [{ id: "b" }] });
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
describe("usePresentItems armed state", () => {
  test("rows loaded while the catalog is unarmed do not enter, but later rows do", () => {
    const { result, rerender } = renderHook(
      ({ items, armed }: { readonly items: readonly Row[]; readonly armed: boolean }) =>
        usePresentItems(items, key, 200, armed),
      { initialProps: { items: [] as Row[], armed: false } },
    );
    rerender({ items: [{ id: "a" }], armed: true });
    expect(labels(result.current)).toEqual(["a"]);

    rerender({ items: [{ id: "a" }, { id: "b" }], armed: true });
    expect(labels(result.current)).toEqual(["a", "b+"]);
  });
});
