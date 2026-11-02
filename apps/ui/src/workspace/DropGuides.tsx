import { cn } from "cn";
import { type DockviewApi, getPanelData, type Position } from "dockview-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { carriesChat } from "./chatDrag";
import { regionAt, windowEdgeAt } from "./dropRegions";

/**
 * No `dragover` for this long: the drag ended where nothing told the page. Above the 350 ± 200 ms at which a browser
 * repeats `dragover` while the pointer holds still, so what is lit stays while the pointer rests.
 */
const GONE_MS = 1_000;

/** What a drop now would do, said where it will land. */
const PANE_WORDS: Record<Position, string> = {
  center: "Open here",
  left: "Split left",
  right: "Split right",
  top: "Split above",
  bottom: "Split below",
};
const EDGE_WORDS: Record<Position, string> = {
  center: "",
  left: "Whole left side",
  right: "Whole right side",
  top: "Whole top",
  bottom: "Whole bottom",
};

/** Where a drop on a pane's region lands, as a share of the pane: the middle of the half that region gives. */
const PANE_LABEL_AT: Record<Position, { readonly x: number; readonly y: number }> = {
  center: { x: 0.5, y: 0.5 },
  left: { x: 0.25, y: 0.5 },
  right: { x: 0.75, y: 0.5 },
  top: { x: 0.5, y: 0.25 },
  bottom: { x: 0.5, y: 0.75 },
};
/** The middle of the strip of the window a drop on its edge gives (30% of it, `SHADE_PLACES`). */
const EDGE_LABEL_AT: Record<Position, { readonly x: number; readonly y: number }> = {
  center: { x: 0.5, y: 0.5 },
  left: { x: 0.15, y: 0.5 },
  right: { x: 0.85, y: 0.5 },
  top: { x: 0.5, y: 0.15 },
  bottom: { x: 0.5, y: 0.85 },
};

/** What a drop now would do: the window's edge (its band lies above the panes), or a region of the pane under it. */
interface Lit {
  readonly where: "pane" | "edge";
  readonly position: Position;
  /** The label's middle, from the tab's top-left. */
  readonly x: number;
  readonly y: number;
}

/**
 * What a drop would do, shown over a tab while a chat from the list or a pane is dragged (#2790). Anywhere on a pane
 * counts: its middle rectangle opens a chat from the list in its place, anywhere else its nearest edge splits it
 * (`dropRegions.ts`, the geometry the drop resolver answers with, so what is said is where the drop lands); dockview
 * shades the half the pane gives. With two panes or more, a band along the window's edges makes a column or row the whole
 * length of that side: shaded here, and its drops taken here, by where the pointer is, since where the band falls (a
 * divider, a title bar) no target of dockview's takes a drop in WebKit. A label names the drop either way. A pane dragged
 * over itself has nowhere to go there. Mounted inside the tab's own box, which it covers; the pointer goes through it.
 */
export function DropGuides({
  api,
  onEdgeDrop,
}: {
  readonly api: DockviewApi | undefined;
  readonly onEdgeDrop: (position: Position, event: DragEvent) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [lit, setLit] = useState<Lit | null>(null);
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
      setLit(null);
    };
    /** The window's edge at a point of the page, while the tab holds two panes or more. */
    const edgeAt = (clientX: number, clientY: number): Position | null => {
      if (api.groups.length < 2) return null;
      const box = tab.getBoundingClientRect();
      return windowEdgeAt(box.width, box.height, clientX - box.left, clientY - box.top);
    };
    const draw = (): void => {
      frame = 0;
      const pointer = last;
      if (pointer === null) return;
      const pane = getPanelData();
      if (!pointer.chat && pane === undefined) {
        setLit(null);
        return;
      }
      const box = tab.getBoundingClientRect();
      const edge = edgeAt(pointer.x, pointer.y);
      if (edge !== null) {
        setLit({
          where: "edge",
          position: edge,
          x: EDGE_LABEL_AT[edge].x * box.width,
          y: EDGE_LABEL_AT[edge].y * box.height,
        });
        return;
      }
      for (const group of api.groups) {
        if (pane?.groupId === group.id) continue;
        const content = group.element.querySelector(".dv-content-container");
        if (content === null) continue;
        const area = content.getBoundingClientRect();
        const region = regionAt(
          area.width,
          area.height,
          pointer.x - area.left,
          pointer.y - area.top,
          pointer.chat,
        );
        if (region === null) continue;
        setLit({
          where: "pane",
          position: region,
          x: area.left - box.left + PANE_LABEL_AT[region].x * area.width,
          y: area.top - box.top + PANE_LABEL_AT[region].y * area.height,
        });
        return;
      }
      setLit(null);
    };
    const docks = (event: DragEvent): boolean => carriesChat(event) || getPanelData() !== undefined;
    /** Whether the pointer is over this tab: a hidden tab has no box, so only the one shown counts. */
    const inside = (event: DragEvent): boolean => {
      const box = tab.getBoundingClientRect();
      return (
        event.clientX > box.left &&
        event.clientX < box.right &&
        event.clientY > box.top &&
        event.clientY < box.bottom
      );
    };
    // Every drag event of the page is read here, by where the pointer is, not by the element it went to: over a divider
    // a browser can send a `dragenter` and then no `dragover` at all, and WebKit sends the events of a drag whose
    // `dragenter` was not taken to the page's body. So a `dragenter` updates what is lit as a `dragover` does, and every
    // one over the tab is taken (WebKit's rule, which Chromium follows by itself); a `dragover` is allowed over the band.
    const track = (event: DragEvent): void => {
      if (!inside(event) || !docks(event)) {
        if (last !== null) clear();
        return;
      }
      last = { x: event.clientX, y: event.clientY, chat: carriesChat(event) };
      if (event.type === "dragenter" || edgeAt(event.clientX, event.clientY) !== null)
        event.preventDefault();
      clearTimeout(gone);
      gone = setTimeout(clear, GONE_MS);
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    // The band takes its drops itself, by where the pointer is: it falls on a pane, a divider or a title bar, where no
    // target of dockview's takes a drop in WebKit. Taken here, before dockview sees it; any other drop goes on to dockview.
    const drop = (event: DragEvent): void => {
      const edge = inside(event) && docks(event) ? edgeAt(event.clientX, event.clientY) : null;
      if (edge !== null) {
        event.preventDefault();
        event.stopPropagation();
        edgeDrop.current(edge, event);
      }
      clear();
    };
    window.addEventListener("dragenter", track, true);
    window.addEventListener("dragover", track, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("dragenter", track, true);
      window.removeEventListener("dragover", track, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", clear, true);
      cancelAnimationFrame(frame);
      clearTimeout(gone);
    };
  }, [api]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-drop-guides={lit === null ? undefined : ""}
      // Above dockview's drop overlay, which shades the half of a pane a drop gives; the pointer goes through to dockview.
      className="pointer-events-none absolute inset-0 z-[1000]"
    >
      {lit?.where === "edge" && (
        <div
          data-drop-shade={lit.position}
          className={cn(
            "absolute bg-[color-mix(in_oklab,var(--accent)_16%,transparent)]",
            SHADE_PLACES[lit.position],
          )}
        />
      )}
      {lit !== null && (
        <div
          data-drop-label={lit.where === "edge" ? `edge-${lit.position}` : `pane-${lit.position}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-ring bg-popover px-2.5 py-1 font-medium text-t1 text-xs shadow-md"
          style={{ left: lit.x, top: lit.y }}
        >
          {lit.where === "edge" ? EDGE_WORDS[lit.position] : PANE_WORDS[lit.position]}
        </div>
      )}
    </div>
  );
}

/** The strip of the window a drop on its edge gives the pane: 30%, as dockview shades a side (`EDGE_SHADE`). */
const SHADE_PLACES: Record<Position, string> = {
  left: "inset-y-0 left-0 w-[30%]",
  right: "inset-y-0 right-0 w-[30%]",
  top: "inset-x-0 top-0 h-[30%]",
  bottom: "inset-x-0 bottom-0 h-[30%]",
  center: "inset-0",
};
