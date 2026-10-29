import type { SerializedDockview } from "dockview-react";

/** A node of dockview's saved grid: a pane (a group of panels) or a split of nodes along one axis. */
interface GridNode {
  readonly type: "leaf" | "branch";
  readonly data: unknown;
  readonly size?: number;
  readonly visible?: boolean;
}

const children = (node: GridNode): readonly GridNode[] =>
  node.type === "branch" && Array.isArray(node.data) ? (node.data as GridNode[]) : [];

/** Whole pixels that add up to `total`: the last share takes what division leaves over. */
function shares(total: number, count: number): number[] {
  const share = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? total - share * (count - 1) : share,
  );
}

function equalize(node: GridNode, along: number, across: number): GridNode {
  const parts = children(node);
  if (parts.length === 0) return node;
  const sizes = shares(along, parts.length);
  return {
    ...node,
    // Each part's own split runs across this one: its length is this split's width across, its width its share.
    data: parts.map((part, index) => ({
      ...equalize(part, across, sizes[index] as number),
      size: sizes[index] as number,
    })),
  };
}

/** Every split shares its space equally among its panes, as kitty's equalize does. */
export function equalized(layout: SerializedDockview): SerializedDockview {
  const { grid } = layout;
  const horizontal = grid.orientation === "HORIZONTAL";
  const root = equalize(
    grid.root as GridNode,
    horizontal ? grid.width : grid.height,
    horizontal ? grid.height : grid.width,
  );
  return { ...layout, grid: { ...grid, root: root as SerializedDockview["grid"]["root"] } };
}

function leaves(node: GridNode): readonly GridNode[] {
  return node.type === "leaf" ? [node] : children(node).flatMap(leaves);
}

const groupId = (leaf: GridNode): string | undefined => (leaf.data as { readonly id?: string }).id;

/**
 * The pane `group` trades places with the next pane in reading order (left to right, top to bottom, wrapping round), as
 * kitty's swap does; each keeps its chats. Null when there is no other pane.
 */
export function swappedWithNext(
  layout: SerializedDockview,
  group: string,
): SerializedDockview | null {
  const all = leaves(layout.grid.root as GridNode);
  const index = all.findIndex((leaf) => groupId(leaf) === group);
  if (index < 0 || all.length < 2) return null;
  const mine = all[index] as GridNode;
  const theirs = all[(index + 1) % all.length] as GridNode;
  const swap = (node: GridNode): GridNode => {
    if (node === mine) return { ...node, data: theirs.data };
    if (node === theirs) return { ...node, data: mine.data };
    const parts = children(node);
    return parts.length === 0 ? node : { ...node, data: parts.map(swap) };
  };
  const root = swap(layout.grid.root as GridNode);
  return {
    ...layout,
    grid: { ...layout.grid, root: root as SerializedDockview["grid"]["root"] },
  };
}
