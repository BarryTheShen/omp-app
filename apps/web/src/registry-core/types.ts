/**
 * Shared types for the descriptor registry: the `kind`-narrowing helpers, the renderer-component
 * shape, and the validated/indexed `Registry` that `createRegistry` builds and every hook reads.
 */
import type { Descriptor, DescriptorId } from "@omp-app/contracts";
import type { ComponentType } from "react";

/** The `kind` discriminant shared by every registry descriptor. */
export type DescriptorKind = Descriptor["kind"];

/** `Descriptor` narrowed to one `kind`, for example `DescriptorOfKind<"tool">`. */
export type DescriptorOfKind<Kind extends DescriptorKind> = Extract<Descriptor, { kind: Kind }>;

/** Renders one descriptor. `D` defaults to the full union: most renderers narrow internally by `descriptor.kind`. */
export type DescriptorRenderer<D extends Descriptor = Descriptor> = ComponentType<{
  readonly descriptor: D;
}>;

/**
 * Renderer components keyed by descriptor id. Every renderer accepts the whole `Descriptor`
 * union, not just its own kind: one map holds every module's renderers side by side, and each
 * component narrows internally to the kind it was registered under.
 */
export type RendererMap = Readonly<Partial<Record<DescriptorId, DescriptorRenderer>>>;

/**
 * A validated, indexed set of descriptors (`createRegistry`). `validateRegistry` runs only while
 * building one; every hook afterward reads these precomputed indexes.
 */
export interface Registry {
  readonly descriptors: readonly Descriptor[];
  readonly byId: ReadonlyMap<DescriptorId, Descriptor>;
  readonly byKind: ReadonlyMap<DescriptorKind, readonly Descriptor[]>;
}
