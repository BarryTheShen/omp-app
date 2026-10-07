import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { type AppLayout, LAYOUT, type LayoutAreaName, type SurfaceId } from "./layout";

/** One placeable piece of UI. The layout decides where it goes; the surface only renders it. */
export interface Surface {
  /** Shown on a panel's tab, and to assistive tech when a surface renders nothing visible itself. */
  readonly title: string;
  /** Capabilities it needs; without them the surface is left out of its area. */
  readonly requires?: readonly CapabilityKey[];
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
  composerToolbar: "flex min-w-0 flex-wrap items-center gap-2 px-(--space-md) py-(--space-xs)",
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

/** The surfaces an area shows, in layout order: known ids whose capabilities are available. */
export function areaSurfaces(
  area: LayoutAreaName,
  surfaces: SurfaceMap,
  capabilities?: CapabilityMap,
  layout: AppLayout = LAYOUT,
): readonly (readonly [SurfaceId, Surface])[] {
  return layout[area].flatMap((id) => {
    const surface = surfaces[id];
    return surface && available(surface, capabilities) ? [[id, surface] as const] : [];
  });
}

function PanelTabs({ panels }: { readonly panels: readonly (readonly [SurfaceId, Surface])[] }) {
  const [active, setActive] = useState<SurfaceId | undefined>(panels[0]?.[0]);
  const current = panels.find(([id]) => id === active) ?? panels[0];
  if (!current) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        aria-label="Panels"
        className="border-border flex gap-1 border-b px-2 py-1"
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
  if (area === "panels" && shown.length > 1) return <PanelTabs panels={shown} />;
  return (
    <div className={AREA_CLASSES[area]} data-layout-area={area}>
      {shown.map(([id, surface]) => (
        <div
          className={cn(
            "min-w-0",
            surface.grow && (ROW_AREAS[area] === true ? "flex-1" : "flex min-h-0 flex-1 flex-col"),
          )}
          data-surface={id}
          key={id}
        >
          {surface.render()}
        </div>
      ))}
    </div>
  );
}
