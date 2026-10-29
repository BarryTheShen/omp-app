import type { SerializedDockview } from "dockview-react";
import { describe, expect, test } from "vitest";
import { equalized, swappedWithNext } from "./layout";

const leaf = (id: string, size: number) => ({
  type: "leaf",
  data: { id, views: [`p-${id}`] },
  size,
});

/** Two panes side by side, the right one split top and bottom: 1000 × 600. */
const layout = (): SerializedDockview =>
  ({
    grid: {
      orientation: "HORIZONTAL",
      width: 1000,
      height: 600,
      root: {
        type: "branch",
        size: 600,
        data: [
          leaf("a", 700),
          { type: "branch", size: 300, data: [leaf("b", 100), leaf("c", 500)] },
        ],
      },
    },
    panels: {},
  }) as unknown as SerializedDockview;

type Node = { readonly size?: number; readonly data: unknown };
const parts = (node: unknown): Node[] => (node as { data: Node[] }).data;
const idOf = (node: Node | undefined): string | undefined =>
  (node?.data as { readonly id?: string } | undefined)?.id;

describe("workspace layouts", () => {
  test("equalize shares every split's length among its panes, down the nested splits", () => {
    const root = equalized(layout()).grid.root;
    const [left, right] = parts(root);
    expect([left?.size, right?.size]).toEqual([500, 500]);
    // The right column's split runs top to bottom, over the whole height.
    expect(parts(right).map((part) => part.size)).toEqual([300, 300]);
  });

  test("equalize keeps whole pixels that add up to the length", () => {
    const three = {
      ...layout(),
      grid: {
        ...layout().grid,
        width: 1001,
        root: { type: "branch", size: 600, data: [leaf("a", 1), leaf("b", 1), leaf("c", 999)] },
      },
    } as unknown as SerializedDockview;
    expect(parts(equalized(three).grid.root).map((part) => part.size)).toEqual([333, 333, 335]);
  });

  test("swap trades a pane with the next one in reading order, wrapping round; sizes stay where they were", () => {
    const swapped = swappedWithNext(layout(), "b");
    const [left, right] = parts(swapped?.grid.root);
    expect(idOf(left)).toBe("a");
    expect(parts(right).map((part) => [idOf(part), part.size])).toEqual([
      ["c", 100],
      ["b", 500],
    ]);
    const wrapped = swappedWithNext(layout(), "c");
    expect(idOf(parts(wrapped?.grid.root)[0])).toBe("c");
    expect(swappedWithNext(layout(), "gone")).toBeNull();
  });
});
