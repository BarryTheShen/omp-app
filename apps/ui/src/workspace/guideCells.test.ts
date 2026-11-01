import type { Position } from "dockview-react";
import { describe, expect, it } from "vitest";
import { edgeGuides, GUIDE_PX, guideAt, guideResolver, paneGuides } from "./guideCells";

const ALL: ReadonlySet<Position> = new Set(["top", "bottom", "left", "right", "center"]);
const SIDES: ReadonlySet<Position> = new Set(["top", "bottom", "left", "right"]);
const drag = {} as DragEvent;

describe("the docking guides (#2771)", () => {
  it("a pane's guides make a plus around its middle; between and around them nothing counts", () => {
    const guides = paneGuides(800, 600, true);
    const middle = { x: 400, y: 300 };
    expect(guideAt(guides, middle.x, middle.y)).toBe("center");
    expect(guideAt(guides, middle.x + 40, middle.y)).toBe("right");
    expect(guideAt(guides, middle.x - 40, middle.y)).toBe("left");
    expect(guideAt(guides, middle.x, middle.y - 40)).toBe("top");
    expect(guideAt(guides, middle.x, middle.y + 40)).toBe("bottom");
    // The gap between two guides, a corner of the plus, and the pane's old edge zones.
    expect(guideAt(guides, middle.x + 20, middle.y)).toBeNull();
    expect(guideAt(guides, middle.x + 40, middle.y + 40)).toBeNull();
    expect(guideAt(guides, 790, 300)).toBeNull();
  });

  it("the middle guide is there for a chat only", () => {
    expect(guideAt(paneGuides(800, 600, false), 400, 300)).toBeNull();
    expect(paneGuides(800, 600, false).map((guide) => guide.position)).toEqual([
      "top",
      "left",
      "right",
      "bottom",
    ]);
  });

  it("the window's guides sit in the middle of each side, inside it", () => {
    const guides = edgeGuides(1200, 800);
    expect(guideAt(guides, 12 + GUIDE_PX / 2, 400)).toBe("left");
    expect(guideAt(guides, 1200 - 12 - GUIDE_PX / 2, 400)).toBe("right");
    expect(guideAt(guides, 600, 12 + GUIDE_PX / 2)).toBe("top");
    expect(guideAt(guides, 600, 800 - 12 - GUIDE_PX / 2)).toBe("bottom");
    expect(guideAt(guides, 4, 400)).toBeNull();
    expect(guideAt(guides, 600, 400)).toBeNull();
  });

  it("with two panes the whole layout answers nothing, its edges included, and a pane its plus", () => {
    const resolver = guideResolver(
      () => ({ width: 1200, height: 800, panes: 2 }),
      () => true,
    );
    const at = (x: number, y: number, width = 1200, height = 800) =>
      resolver.resolve({ x, y, width, height, zones: ALL, event: drag })?.position ?? null;
    // The window's guides take their own drops: on the left one the layout's target answers nothing.
    expect(at(12 + GUIDE_PX / 2, 400)).toBeNull();
    // WebKit measures the layout's box a pixel or two off: still the layout.
    expect(at(600, 400, 1198, 801)).toBeNull();
    // A pane's box, even as wide as the layout (panes stacked), is smaller by its title bar: its plus.
    expect(at(600, 370, 1200, 740)).toBe("center");
    expect(at(300, 300, 600, 600)).toBe("center");
    expect(at(340, 300, 600, 600)).toBe("right");
  });

  it("a lone pane, or an empty tab, is answered on the plus; a position the target refuses is no drop", () => {
    const lone = guideResolver(
      () => ({ width: 1200, height: 800, panes: 1 }),
      () => false,
    );
    const box = { width: 1200, height: 800, event: drag };
    expect(lone.resolve({ ...box, x: 30, y: 400, zones: ALL })).toBeNull();
    expect(lone.resolve({ ...box, x: 640, y: 400, zones: ALL })?.position).toBe("right");
    const empty = guideResolver(
      () => ({ width: 1200, height: 800, panes: 0 }),
      () => true,
    );
    expect(empty.resolve({ ...box, x: 600, y: 400, zones: ALL })?.position).toBe("center");
    expect(empty.resolve({ ...box, x: 600, y: 400, zones: SIDES })).toBeNull();
  });
});
