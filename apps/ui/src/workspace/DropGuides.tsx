import { cn } from "cn";
import { type DockviewApi, getPanelData, type Position } from "dockview-react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { carriesChat } from "./chatDrag";
import { edgeGuides, GUIDE_PX, type GuideCell, guideAt, paneGuides } from "./guideCells";

const PANE_ICONS: Record<Position, LucideIcon> = {
  top: ArrowUp,
  bottom: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
  center: CircleDot,
};
const EDGE_ICONS: Record<Position, LucideIcon> = {
  top: ArrowUpToLine,
  bottom: ArrowDownToLine,
  left: ArrowLeftToLine,
  right: ArrowRightToLine,
  center: CircleDot,
};

/**
 * No `dragover` for this long: the drag ended where nothing told the page. Above the 350 ± 200 ms at which a browser
 * repeats `dragover` while the pointer holds still, so the guides stay while the pointer rests on one.
 */
const GONE_MS = 1_000;

interface Shown {
  /** The pane under the pointer: its content's box from the tab's top-left, and its guides. */
  readonly pane: {
    readonly left: number;
    readonly top: number;
    readonly guides: readonly GuideCell[];
  } | null;
  /** The window's own guides; none while it holds a single pane. */
  readonly edges: readonly GuideCell[];
  /** The guide a drop now would take: the window's first, as its guides lie above the panes. */
  readonly lit: { readonly where: "pane" | "edge"; readonly position: Position } | null;
}

/**
 * The docking guides over a tab while a chat from the list or a pane is dragged (#2771). The pane under the pointer
 * shows its plus, the window its four edge guides (with two panes or more), and the guide a drop would take is lit. They
 * come from the same geometry as the drop resolver (`guideCells.ts`), so what is lit is where the drop lands. A pane
 * dragged over itself shows no plus: it has nowhere to go there. The pane's guides leave the drop to dockview; a drop on
 * one of the window's is taken here (`onEdgeDrop`), by where the pointer is, as no target of dockview's takes it where it
 * falls in WebKit (a divider, a title bar), and the lit one shades the strip the pane will be. Mounted inside the tab's
 * own box, which it covers; the pointer goes through it.
 */
export function DropGuides({
  api,
  onEdgeDrop,
}: {
  readonly api: DockviewApi | undefined;
  readonly onEdgeDrop: (position: Position, event: DragEvent) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  /** The latest `onEdgeDrop`, read at the drop: the listeners are set up once per dockview. */
  const edgeDrop = useRef(onEdgeDrop);
  useEffect(() => {
    edgeDrop.current = onEdgeDrop;
  });
  useEffect(() => {
    const tab = ref.current?.parentElement;
    if (tab === null || tab === undefined || api === undefined) return;
    let frame = 0;
    let gone: ReturnType<typeof setTimeout> | undefined;
    /** The pointer and the drag's kind, taken during the `dragover`: a drag's data reads empty once its event is over. */
    let last: { readonly x: number; readonly y: number; readonly chat: boolean } | null = null;
    const clear = (): void => {
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(gone);
      last = null;
      setShown(null);
    };
    const draw = (): void => {
      frame = 0;
      const pointer = last;
      if (pointer === null) return;
      const pane = getPanelData();
      if (!pointer.chat && pane === undefined) {
        setShown(null);
        return;
      }
      const box = tab.getBoundingClientRect();
      const x = pointer.x - box.left;
      const y = pointer.y - box.top;
      const edges = api.groups.length >= 2 ? edgeGuides(box.width, box.height) : [];
      let hovered: Shown["pane"] = null;
      for (const group of api.groups) {
        if (pane?.groupId === group.id) continue;
        const content = group.element.querySelector(".dv-content-container");
        if (content === null) continue;
        const area = content.getBoundingClientRect();
        if (
          pointer.x < area.left ||
          pointer.x >= area.right ||
          pointer.y < area.top ||
          pointer.y >= area.bottom
        )
          continue;
        hovered = {
          left: area.left - box.left,
          top: area.top - box.top,
          guides: paneGuides(area.width, area.height, pointer.chat),
        };
        break;
      }
      const edge = guideAt(edges, x, y);
      const onPane =
        hovered === null ? null : guideAt(hovered.guides, x - hovered.left, y - hovered.top);
      setShown({
        pane: hovered,
        edges,
        lit:
          edge !== null
            ? { where: "edge", position: edge }
            : onPane !== null
              ? { where: "pane", position: onPane }
              : null,
      });
    };
    /** The window's guide at a point of the window, while the tab holds two panes or more. */
    const edgeAt = (clientX: number, clientY: number): Position | null => {
      if (api.groups.length < 2) return null;
      const box = tab.getBoundingClientRect();
      return guideAt(edgeGuides(box.width, box.height), clientX - box.left, clientY - box.top);
    };
    const docks = (event: DragEvent): boolean => carriesChat(event) || getPanelData() !== undefined;
    // The window's guides take their drops themselves, by where the pointer is, not by the element under it: they fall on
    // a pane, a divider or a title bar, and a drop goes to where the last `dragover` was, which can be before the guides
    // were drawn. So over one the drop is allowed, and taken here before dockview sees it.
    const over = (event: DragEvent): void => {
      last = { x: event.clientX, y: event.clientY, chat: carriesChat(event) };
      if (edgeAt(event.clientX, event.clientY) !== null && docks(event)) event.preventDefault();
      clearTimeout(gone);
      gone = setTimeout(clear, GONE_MS);
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    // WebKit sends a drag's `dragover` and `drop` to the element it entered only when that `dragenter` was taken, else to
    // the page's body, out of the tab: a divider or a title bar takes none, so here every one in the tab is taken, as
    // Chromium does by itself. Where a drop lands is still each `dragover`'s to allow.
    const enter = (event: DragEvent): void => {
      if (docks(event)) event.preventDefault();
    };
    const drop = (event: DragEvent): void => {
      const edge = edgeAt(event.clientX, event.clientY);
      if (edge === null || !docks(event)) return;
      event.preventDefault();
      event.stopPropagation();
      edgeDrop.current(edge, event);
    };
    // A `dragleave` also comes when the pointer only moves onto another element inside: out means past the tab's edges.
    const leave = (event: DragEvent): void => {
      const box = tab.getBoundingClientRect();
      if (
        event.clientX <= box.left ||
        event.clientX >= box.right ||
        event.clientY <= box.top ||
        event.clientY >= box.bottom
      )
        clear();
    };
    tab.addEventListener("dragenter", enter, true);
    tab.addEventListener("dragover", over, true);
    tab.addEventListener("dragleave", leave, true);
    tab.addEventListener("drop", drop, true);
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      tab.removeEventListener("dragenter", enter, true);
      tab.removeEventListener("dragover", over, true);
      tab.removeEventListener("dragleave", leave, true);
      tab.removeEventListener("drop", drop, true);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
      cancelAnimationFrame(frame);
      clearTimeout(gone);
    };
  }, [api]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-drop-guides={shown === null ? undefined : ""}
      // Above dockview's drop overlay, which shades where the pane will go; the pointer goes through to dockview.
      className="pointer-events-none absolute inset-0 z-[1000]"
    >
      {shown?.lit?.where === "edge" && (
        <div
          data-drop-shade={shown.lit.position}
          className={cn(
            "absolute bg-[color-mix(in_oklab,var(--accent)_16%,transparent)]",
            SHADE_PLACES[shown.lit.position],
          )}
        />
      )}
      {shown?.pane?.guides.map((guide) => (
        <Guide
          key={`pane-${guide.position}`}
          name={`pane-${guide.position}`}
          left={(shown.pane?.left ?? 0) + guide.x}
          top={(shown.pane?.top ?? 0) + guide.y}
          Icon={PANE_ICONS[guide.position]}
          lit={shown.lit?.where === "pane" && shown.lit.position === guide.position}
        />
      ))}
      {shown?.edges.map((guide) => (
        <Guide
          key={`edge-${guide.position}`}
          name={`edge-${guide.position}`}
          left={guide.x}
          top={guide.y}
          Icon={EDGE_ICONS[guide.position]}
          lit={shown.lit?.where === "edge" && shown.lit.position === guide.position}
        />
      ))}
    </div>
  );
}

/** The strip of the window a drop on its edge guide gives the pane: 30%, as dockview shades a side (`EDGE_SHADE`). */
const SHADE_PLACES: Record<Position, string> = {
  left: "inset-y-0 left-0 w-[30%]",
  right: "inset-y-0 right-0 w-[30%]",
  top: "inset-x-0 top-0 h-[30%]",
  bottom: "inset-x-0 bottom-0 h-[30%]",
  center: "inset-0",
};

function Guide({
  name,
  left,
  top,
  Icon,
  lit,
}: {
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly Icon: LucideIcon;
  readonly lit: boolean;
}): ReactNode {
  return (
    <div
      data-drop-guide={name}
      data-lit={lit ? "" : undefined}
      className={cn(
        "absolute grid place-items-center rounded-md border shadow-md",
        lit ? "border-ring bg-l2 text-t1 ring-2 ring-ring" : "border-l2 bg-popover text-t2",
      )}
      style={{ left, top, width: GUIDE_PX, height: GUIDE_PX }}
    >
      <Icon className="size-4" />
    </div>
  );
}
