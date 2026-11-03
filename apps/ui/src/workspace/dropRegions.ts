import type { Position, PositionResolver } from "dockview-react";

/** The middle rectangle of a pane: the inner half of its width and of its height. */
const MIDDLE_FROM = 0.25;
const MIDDLE_TO = 0.75;

/**
 * Where a drop on a pane lands (#2790), by where the pointer is on it: anywhere counts. A chat from the list let go in the
 * pane's middle rectangle shows in that pane's place; anywhere else, the pane's nearest edge splits it on that side. A
 * pane being moved has no middle: everywhere is its nearest edge. The zones are fixed and the strip a drop takes is lit
 * and named (`DropGuides`), where dockview's own zones could not be seen. Null outside the pane.
 */
export function regionAt(
  width: number,
  height: number,
  x: number,
  y: number,
  middle: boolean,
): Position | null {
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return null;
  const across = x / width;
  const down = y / height;
  if (
    middle &&
    across >= MIDDLE_FROM &&
    across < MIDDLE_TO &&
    down >= MIDDLE_FROM &&
    down < MIDDLE_TO
  )
    return "center";
  return nearest([
    ["left", across],
    ["right", 1 - across],
    ["top", down],
    ["bottom", 1 - down],
  ])[0];
}

/** How far in from the window's edges a drop makes a column or row the whole length of that side. */
export const WINDOW_EDGE_PX = 28;

/** The window's edge whose band a point of the window is in; null elsewhere. Only with two panes or more (the caller). */
export function windowEdgeAt(width: number, height: number, x: number, y: number): Position | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const [position, distance] = nearest([
    ["left", x],
    ["right", width - 1 - x],
    ["top", y],
    ["bottom", height - 1 - y],
  ]);
  return distance < WINDOW_EDGE_PX ? position : null;
}

function nearest(sides: readonly (readonly [Position, number])[]): readonly [Position, number] {
  return sides.reduce((best, side) => (side[1] < best[1] ? side : best));
}

/** What the resolver needs of the tab it serves: its box on the page and how many panes it holds. */
export interface DropLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly panes: number;
}

/**
 * How far a drop target's box may be from the tab's and still be the whole layout: WebKit measures it a pixel or two
 * off. With two panes or more a pane's box is smaller by its title bar at least (about 30 px).
 */
const LAYOUT_SLACK_PX = 8;

/**
 * dockview's drop resolver: the pane under the pointer answers by its region. With two panes or more the whole layout
 * answers nothing, and neither does a pane in the window's edge band: those drops are the window's own (`DropGuides`
 * takes them, since where they fall, a divider or a title bar, no target of dockview's takes a drop in WebKit). A lone
 * pane, or none, answers as a pane. A blank window (#2791) is filled from anywhere in it: `blankAt` tells whether the
 * pointer is over one, since dockview gives the resolver no group. A position the target does not take now is null, so
 * the pane under it gets the drag.
 */
export function regionResolver(
  layout: () => DropLayout | null,
  carriesChat: (event: DragEvent | PointerEvent) => boolean,
  blankAt: (event: DragEvent | PointerEvent) => boolean,
): PositionResolver {
  return {
    resolve: ({ x, y, width, height, zones, event }) => {
      const tab = layout();
      if (tab !== null && tab.panes >= 2) {
        const whole =
          Math.abs(width - tab.width) <= LAYOUT_SLACK_PX &&
          Math.abs(height - tab.height) <= LAYOUT_SLACK_PX;
        if (whole) return null;
        const edge = windowEdgeAt(
          tab.width,
          tab.height,
          event.clientX - tab.left,
          event.clientY - tab.top,
        );
        if (edge !== null) return null;
      }
      const position = blankAt(event)
        ? "center"
        : regionAt(width, height, x, y, carriesChat(event));
      return position !== null && zones.has(position) ? { position } : null;
    },
  };
}
