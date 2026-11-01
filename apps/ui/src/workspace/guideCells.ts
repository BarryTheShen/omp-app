import type { Position, PositionResolver } from "dockview-react";

/** One docking guide: where it sits in the box it belongs to (px from the box's top-left) and where a drop on it goes. */
export interface GuideCell {
  readonly position: Position;
  readonly x: number;
  readonly y: number;
}

/** A guide's side (#2771): a drop counts only on a guide, so each is a square the pointer can find. */
export const GUIDE_PX = 36;
const STEP_PX = GUIDE_PX + 4;
/** How far in from the window's edges its own four guides sit. */
const EDGE_INSET_PX = 12;

/**
 * A pane's guides: a plus around the middle of its content. The middle one, "open it in this pane's place", only for a
 * chat from the list: a pane dropped there would stack as a tab, which the app never shows.
 */
export function paneGuides(width: number, height: number, middle: boolean): GuideCell[] {
  const x = Math.round(width / 2 - GUIDE_PX / 2);
  const y = Math.round(height / 2 - GUIDE_PX / 2);
  return [
    { position: "top", x, y: y - STEP_PX },
    { position: "left", x: x - STEP_PX, y },
    ...(middle ? [{ position: "center" as const, x, y }] : []),
    { position: "right", x: x + STEP_PX, y },
    { position: "bottom", x, y: y + STEP_PX },
  ];
}

/** The window's guides, one in the middle of each side: a drop there runs the whole length of that side. */
export function edgeGuides(width: number, height: number): GuideCell[] {
  const x = Math.round(width / 2 - GUIDE_PX / 2);
  const y = Math.round(height / 2 - GUIDE_PX / 2);
  return [
    { position: "top", x, y: EDGE_INSET_PX },
    { position: "left", x: EDGE_INSET_PX, y },
    { position: "right", x: width - EDGE_INSET_PX - GUIDE_PX, y },
    { position: "bottom", x, y: height - EDGE_INSET_PX - GUIDE_PX },
  ];
}

/** The guide under a point of the box; null between the guides and outside them. */
export function guideAt(guides: readonly GuideCell[], x: number, y: number): Position | null {
  const hit = guides.find(
    (guide) => x >= guide.x && x < guide.x + GUIDE_PX && y >= guide.y && y < guide.y + GUIDE_PX,
  );
  return hit?.position ?? null;
}

/** What the resolver needs of the tab it serves: its size and how many panes it holds. */
export interface GuideLayout {
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
 * dockview's drop resolver for the guides: a drop counts only on one. dockview asks the whole layout's target and the
 * pane under the pointer (told apart by their box), and an answer of null leaves the drag to the other. A pane answers
 * on its plus, as does the layout of a lone pane or of none. The whole layout of two panes or more answers nothing: the
 * window's four guides are drop zones of their own (`DropGuides`), above dockview, since where they fall (a pane's
 * content, a divider, a title bar) no target of dockview's takes the drop in WebKit. A position the target does not
 * take now (the layout takes the middle only while it is empty) is null too, so the pane under it gets the drag.
 */
export function guideResolver(
  layout: () => GuideLayout | null,
  carriesChat: (event: DragEvent | PointerEvent) => boolean,
): PositionResolver {
  return {
    resolve: ({ x, y, width, height, zones, event }) => {
      const tab = layout();
      const whole =
        tab !== null &&
        Math.abs(width - tab.width) <= LAYOUT_SLACK_PX &&
        Math.abs(height - tab.height) <= LAYOUT_SLACK_PX;
      if (whole && tab.panes >= 2) return null;
      const position = guideAt(paneGuides(width, height, carriesChat(event)), x, y);
      return position !== null && zones.has(position) ? { position } : null;
    },
  };
}
