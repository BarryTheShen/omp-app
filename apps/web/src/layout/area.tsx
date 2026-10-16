import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { isUsable } from "@/registry-core/hooks";
import { type AppLayout, LAYOUT, type LayoutAreaName, type SurfaceId } from "./layout";

/** One placeable piece of UI. The layout decides where it goes; the surface only renders it. */
export interface Surface {
  /** Shown on a panel's tab, and to assistive tech when a surface renders nothing visible itself. */
  readonly title: string;
  /** Capabilities it needs; without them the surface is left out of its area. */
  readonly requires?: readonly CapabilityKey[];
  /**
   * An on-demand panel is listed in its area only while it is open. The default is open, so a
   * surface that does not say otherwise is always listed.
   */
  readonly open?: boolean;
  /**
   * Change this number to bring an open panel to the front of its tabs, for example when a command
   * opens a panel that is already open.
   */
  readonly reveal?: number;
  /** In a row area, take the free space (e.g. the header title). */
  readonly grow?: boolean;
  readonly render: () => ReactNode;
}

export type SurfaceMap = Readonly<Partial<Record<SurfaceId, Surface>>>;

/** How each area arranges its pieces: the one place area spacing and direction are set. */
const AREA_CLASSES: Readonly<Record<LayoutAreaName, string>> = {
  sidebar: "flex min-h-0 flex-1 flex-col gap-(--space-md)",
  header: "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1",
  panels: "flex min-h-0 flex-1 flex-col",
  composerToolbar: "flex min-w-0 flex-wrap items-center gap-(--space-xs)",
  composerQueue: "flex min-w-0 flex-col",
  composerFooter: "flex min-w-0 flex-col",
  threadFooter: "flex min-w-0 flex-1 flex-wrap items-center justify-end gap-(--space-sm)",
  // Above the transcript's sticky footer, so it follows that footer. It takes no pointer events itself:
  // only what is drawn in it (the notices) catches them, so the footer and the transcript stay usable.
  threadOverlay: "pointer-events-none absolute inset-x-0 bottom-full flex min-w-0 flex-col px-6",
  // A size container: the context meter asks how wide the status bar is (a container query), not the viewport (issue 1607).
  statusBar: "@container flex min-w-0 flex-1 flex-nowrap items-center gap-3",
};

/** Areas that lay pieces out left to right; the rest stack top to bottom. */
const ROW_AREAS: Readonly<Partial<Record<LayoutAreaName, true>>> = {
  header: true,
  composerToolbar: true,
  threadFooter: true,
  statusBar: true,
};

function available(surface: Surface, capabilities: CapabilityMap | undefined): boolean {
  if (!surface.requires || surface.requires.length === 0) return true;
  if (capabilities === undefined) return false;
  return surface.requires.every((key) => isUsable(capabilities, key));
}

/** The surfaces an area shows, in layout order: known ids that are open and whose capabilities are available. */
export function areaSurfaces(
  area: LayoutAreaName,
  surfaces: SurfaceMap,
  capabilities?: CapabilityMap,
  layout: AppLayout = LAYOUT,
): readonly (readonly [SurfaceId, Surface])[] {
  return layout[area].flatMap((id) => {
    const surface = surfaces[id];
    return surface && surface.open !== false && available(surface, capabilities)
      ? [[id, surface] as const]
      : [];
  });
}

function surfaceClass(area: LayoutAreaName, surface: Surface): string {
  // The status bar is one line that never wraps (issue 1607). Its growing surface, the segments, takes the room that is left and
  // truncates inside itself; other row areas give growing surfaces a readable 12rem basis, then let them shrink and truncate.
  if (area === "statusBar") return cn("min-w-0", surface.grow ? "flex-1" : "flex-none");
  const row = ROW_AREAS[area] === true;
  return cn("min-w-0", surface.grow && (row ? "flex-[1_1_12rem]" : "flex min-h-0 flex-1 flex-col"));
}

type ListedPanels = readonly (readonly [SurfaceId, Surface])[];

/**
 * The tab that an arrow, Home or End key moves to from `from`, or undefined for any other key.
 * Arrows wrap around the row.
 */
function tabKeyTarget(
  key: string,
  ids: readonly SurfaceId[],
  from: SurfaceId,
): SurfaceId | undefined {
  const index = ids.indexOf(from);
  switch (key) {
    case "ArrowRight":
      return ids[(index + 1) % ids.length];
    case "ArrowLeft":
      return ids[(index - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids.at(-1);
    default:
      return undefined;
  }
}

/**
 * The right sidebar's panels: one fills the area, several become tabs. A panel listed for the first
 * time, or revealed again, becomes the tab shown; the other panels keep the tab they had.
 * The tabs wrap onto more rows, so no number of them runs past the sidebar's edge.
 * Only the selected tab is in the Tab order; the arrow keys, Home and End move focus and selection.
 */
function PanelArea({ panels }: { readonly panels: ListedPanels }) {
  const [active, setActive] = useState<SurfaceId | undefined>(undefined);
  const previous = useRef<ReadonlyMap<SurfaceId, number | undefined> | null>(null);
  const idPrefix = useId();
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = new Map(panels.map(([id, surface]) => [id, surface.reveal]));
    if (before === null) return;
    const opened = panels.find(
      ([id, surface]) =>
        !before.has(id) || (surface.reveal !== undefined && surface.reveal !== before.get(id)),
    );
    if (opened) setActive(opened[0]);
  });

  const current = panels.find(([id]) => id === active) ?? panels[0];
  if (!current) return null;
  if (panels.length === 1) {
    return (
      <div className={AREA_CLASSES.panels} data-layout-area="panels">
        <div className={surfaceClass("panels", current[1])} data-surface={current[0]}>
          {current[1].render()}
        </div>
      </div>
    );
  }

  const tabId = (id: SurfaceId) => `${idPrefix}-tab-${id}`;
  const panelId = `${idPrefix}-panel`;
  /** Focus and selection move to the tab a key names; any other key is left alone. */
  function moveToTab(event: KeyboardEvent<HTMLButtonElement>, from: SurfaceId): void {
    // Alt, Ctrl, Meta and Shift combinations belong to the browser (Alt+Left is Back), so the tabs keep plain keys only.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = tabKeyTarget(
      event.key,
      panels.map(([id]) => id),
      from,
    );
    if (target === undefined) return;
    event.preventDefault();
    setActive(target);
    document.getElementById(tabId(target))?.focus();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-layout-area="panels">
      <div
        aria-label="Panels"
        className="border-border flex flex-wrap gap-1 border-b px-2 py-1"
        role="tablist"
      >
        {panels.map(([id, surface]) => (
          <button
            aria-controls={panelId}
            aria-selected={id === current[0]}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              id === current[0]
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            id={tabId(id)}
            key={id}
            role="tab"
            tabIndex={id === current[0] ? 0 : -1}
            type="button"
            onClick={() => setActive(id)}
            onKeyDown={(event) => moveToTab(event, id)}
          >
            {surface.title}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={tabId(current[0])}
        className="flex min-h-0 flex-1 flex-col"
        id={panelId}
        role="tabpanel"
      >
        {current[1].render()}
      </div>
    </div>
  );
}

/** Renders one area of the shell from the layout: each surface in order, laid out by the area. */
export function LayoutArea({
  area,
  surfaces,
  capabilities,
  layout = LAYOUT,
}: {
  readonly area: LayoutAreaName;
  readonly surfaces: SurfaceMap;
  readonly capabilities?: CapabilityMap;
  /** Tests and previews pass another layout; the app uses `LAYOUT`. */
  readonly layout?: AppLayout;
}) {
  const shown = areaSurfaces(area, surfaces, capabilities, layout);
  if (shown.length === 0) return null;
  if (area === "panels") return <PanelArea panels={shown} />;
  return (
    <div className={AREA_CLASSES[area]} data-layout-area={area}>
      {shown.map(([id, surface]) => (
        <div className={surfaceClass(area, surface)} data-surface={id} key={id}>
          {surface.render()}
        </div>
      ))}
    </div>
  );
}
