import type { Position } from "dockview-react";
import { describe, expect, it } from "vitest";
import { regionAt, regionResolver, WINDOW_EDGE_PX, windowEdgeAt } from "./dropRegions";

const ALL: ReadonlySet<Position> = new Set(["top", "bottom", "left", "right", "center"]);
const SIDES: ReadonlySet<Position> = new Set(["top", "bottom", "left", "right"]);
const at = (clientX: number, clientY: number) => ({ clientX, clientY }) as DragEvent;

describe("where a drop lands (#2790)", () => {
  it("a chat lands in a pane's place in its middle rectangle, and on its nearest edge anywhere else", () => {
    expect(regionAt(800, 600, 400, 300, true)).toBe("center");
    expect(regionAt(800, 600, 210, 160, true)).toBe("center");
    expect(regionAt(800, 600, 199, 300, true)).toBe("left");
    expect(regionAt(800, 600, 700, 300, true)).toBe("right");
    expect(regionAt(800, 600, 400, 50, true)).toBe("top");
    expect(regionAt(800, 600, 400, 560, true)).toBe("bottom");
    // A corner goes to the nearer edge, as a share of the pane's size: 5% from the left beats 10% from the top.
    expect(regionAt(800, 600, 40, 60, true)).toBe("left");
    expect(regionAt(800, 600, 760, 590, true)).toBe("bottom");
  });

  it("a pane being moved has no middle: everywhere is its nearest edge", () => {
    expect(regionAt(800, 600, 420, 300, false)).toBe("right");
    expect(regionAt(800, 600, 380, 300, false)).toBe("left");
    expect(regionAt(800, 600, 400, 280, false)).toBe("top");
  });

  it("nothing outside the pane", () => {
    expect(regionAt(800, 600, -1, 300, true)).toBeNull();
    expect(regionAt(800, 600, 800, 300, true)).toBeNull();
    expect(regionAt(0, 0, 0, 0, true)).toBeNull();
  });

  it("the window's edges are a band of their own, and its inside is no window drop", () => {
    expect(windowEdgeAt(1200, 800, 0, 400)).toBe("left");
    expect(windowEdgeAt(1200, 800, WINDOW_EDGE_PX - 1, 400)).toBe("left");
    expect(windowEdgeAt(1200, 800, WINDOW_EDGE_PX, 400)).toBeNull();
    expect(windowEdgeAt(1200, 800, 1199, 400)).toBe("right");
    expect(windowEdgeAt(1200, 800, 600, 3)).toBe("top");
    expect(windowEdgeAt(1200, 800, 600, 790)).toBe("bottom");
    expect(windowEdgeAt(1200, 800, 600, 400)).toBeNull();
  });

  it("with two panes, the whole layout and the window's edge band answer nothing, and a pane its region", () => {
    const resolver = regionResolver(
      () => ({ left: 100, top: 50, width: 1200, height: 800, panes: 2 }),
      () => true,
      () => false,
    );
    const resolve = (
      x: number,
      y: number,
      width: number,
      height: number,
      clientX: number,
      clientY: number,
    ) =>
      resolver.resolve({ x, y, width, height, zones: ALL, event: at(clientX, clientY) })
        ?.position ?? null;
    // The whole layout, also measured a pixel or two off as WebKit does.
    expect(resolve(600, 400, 1200, 800, 700, 450)).toBeNull();
    expect(resolve(600, 400, 1198, 801, 700, 450)).toBeNull();
    // The left pane (600 × 770 under its title), in its middle and near its right edge.
    expect(resolve(300, 385, 600, 770, 400, 465)).toBe("center");
    expect(resolve(560, 385, 600, 770, 660, 465)).toBe("right");
    // Its left edge lies in the window's band: the window takes that drop, not the pane.
    expect(resolve(10, 385, 600, 770, 110, 465)).toBeNull();
  });

  it("a lone pane, or an empty tab, answers by region, and a position the target refuses is no drop", () => {
    const lone = regionResolver(
      () => ({ left: 0, top: 0, width: 1200, height: 800, panes: 1 }),
      () => false,
      () => false,
    );
    const box = { width: 1200, height: 800 };
    // No window band with one pane: its own edges split it.
    expect(lone.resolve({ ...box, x: 10, y: 400, zones: ALL, event: at(10, 400) })?.position).toBe(
      "left",
    );
    expect(
      lone.resolve({ ...box, x: 640, y: 400, zones: ALL, event: at(640, 400) })?.position,
    ).toBe("right");
    const empty = regionResolver(
      () => ({ left: 0, top: 0, width: 1200, height: 800, panes: 0 }),
      () => true,
      () => false,
    );
    expect(
      empty.resolve({ ...box, x: 600, y: 400, zones: ALL, event: at(600, 400) })?.position,
    ).toBe("center");
    expect(empty.resolve({ ...box, x: 600, y: 400, zones: SIDES, event: at(600, 400) })).toBeNull();
  });

  it("a blank window is filled from anywhere in it, also near its edges; the window's edge band still wins (#2791)", () => {
    const blank = regionResolver(
      () => ({ left: 0, top: 0, width: 1200, height: 800, panes: 2 }),
      () => true,
      (event) => event.clientX >= 600,
    );
    const right = { width: 600, height: 770 };
    // The right window is blank: its middle and its own edges all fill it.
    for (const [x, y] of [
      [300, 385],
      [20, 385],
      [300, 10],
    ] as const)
      expect(
        blank.resolve({ ...right, x, y, zones: ALL, event: at(600 + x, 30 + y) })?.position,
      ).toBe("center");
    // At the window's right edge the band takes it, and a target that takes no middle has no drop.
    expect(
      blank.resolve({ ...right, x: 590, y: 385, zones: ALL, event: at(1190, 415) }),
    ).toBeNull();
    expect(
      blank.resolve({ ...right, x: 300, y: 385, zones: SIDES, event: at(900, 415) }),
    ).toBeNull();
  });
});
