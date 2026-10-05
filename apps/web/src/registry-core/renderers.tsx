/**
 * Renderer-map helpers: `registerRenderers` for a module's own local map, and the visible
 * placeholder `useRenderer` (`hooks.ts`) falls back to when a descriptor has none.
 */
import type { Descriptor } from "@omp-app/contracts";
import type { DescriptorRenderer, RendererMap } from "./types";

/**
 * Type-checks one module's renderer map — a component per descriptor id — and returns it
 * unchanged. Call it once per module and spread the result into the app's merged renderer map, so
 * a component with the wrong props fails at that module's own call site, not somewhere inside the
 * merged map.
 */
export function registerRenderers<M extends RendererMap>(map: M): M {
  return map;
}

/** Shown in place of a crash when a descriptor has no renderer registered for its id. */
export const MissingRendererFallback: DescriptorRenderer<Descriptor> = ({ descriptor }) => (
  <div
    role="alert"
    className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
  >
    No renderer is registered for <code className="font-mono">{descriptor.id}</code>.
  </div>
);
