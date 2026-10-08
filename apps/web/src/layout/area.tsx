import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
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
  header: "flex min-w-0 flex-1 items-center gap-3",
  panels: "flex min-h-0 flex-1 flex-col",
  composerToolbar: "flex min-w-0 flex-wrap items-center gap-(--space-xs)",
  composerFooter: "flex min-w-0 flex-col",
  threadFooter: "flex min-w-0 items-center justify-end gap-(--space-sm)",
  statusBar: "flex min-w-0 flex-1 items-center gap-3",
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
  return surface.requires.every((key) => capabilities?.[key]?.state === "available");
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
  return cn(
    "min-w-0",
    surface.grow && (ROW_AREAS[area] === true ? "flex-1" : "flex min-h-0 flex-1 flex-col"),
  );
}

type ListedPanels = readonly (readonly [SurfaceId, Surface])[];

/**
 * The right sidebar's panels: one fills the area, several become tabs. A panel listed for the first
 * time, or revealed again, becomes the tab shown; the other panels keep the tab they had.
 * The tabs wrap onto more rows, so no number of them runs past the sidebar's edge.
 */
function PanelArea({ panels }: { readonly panels: ListedPanels }) {
  const [active, setActive] = useState<SurfaceId | undefined>(undefined);
  const previous = useRef<ReadonlyMap<SurfaceId, number | undefined> | null>(null);
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-layout-area="panels">
      <div
        aria-label="Panels"
        className="border-border flex flex-wrap gap-1 border-b px-2 py-1"
        role="tablist"
      >
        {panels.map(([id, surface]) => (
          <button
            aria-selected={id === current[0]}
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium",
              id === current[0]
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={id}
            role="tab"
            type="button"
            onClick={() => setActive(id)}
          >
            {surface.title}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
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
