/**
 * The public hooks every module uses to read the registry: lookups by kind and by id, renderer
 * lookup with a visible fallback, and capability-gating helpers.
 */
import type {
  CapabilityKey,
  CapabilityMap,
  CapabilityStatus,
  Descriptor,
  DescriptorId,
} from "@omp-app/contracts";
import { useRegistryContext } from "./context";
import { MissingRendererFallback } from "./renderers";
import type { DescriptorKind, DescriptorOfKind, DescriptorRenderer } from "./types";

const EMPTY_DESCRIPTORS: readonly Descriptor[] = Object.freeze([]);

/** Every registered descriptor of one `kind`; an empty array when none are registered. */
export function useDescriptors<Kind extends DescriptorKind>(
  kind: Kind,
): readonly DescriptorOfKind<Kind>[] {
  const { registry } = useRegistryContext();
  const bucket = registry.byKind.get(kind) ?? EMPTY_DESCRIPTORS;
  return bucket as readonly DescriptorOfKind<Kind>[];
}

/** The descriptor with this id, or `undefined` when the registry has none. */
export function useDescriptor(id: DescriptorId): Descriptor | undefined {
  const { registry } = useRegistryContext();
  return registry.byId.get(id);
}

/** The renderer registered for `id`, or a visible fallback when none is registered. */
export function useRenderer<D extends Descriptor = Descriptor>(
  id: DescriptorId,
): DescriptorRenderer<D> {
  const { renderers } = useRegistryContext();
  const renderer = renderers[id];
  return (renderer ?? MissingRendererFallback) as DescriptorRenderer<D>;
}

/**
 * Whether a capability can be used now: `available`, or `fallback` (it works with the limits its
 * `detail` states, which the UI shows; C0 capabilities.ts). Unknown and `unavailable` are false.
 */
export function isUsable(capabilities: CapabilityMap, key: CapabilityKey): boolean {
  const state = capabilities[key]?.state;
  return state === "available" || state === "fallback";
}

/** Whether one capability can be used now (available or fallback); read its `detail` through useCapabilities. */
export function useCapability(key: CapabilityKey): boolean {
  return isUsable(useRegistryContext().capabilities, key);
}

/** The whole live capability map, for gating more than one descriptor at a time (for example a list filter). */
export function useCapabilities(): CapabilityMap {
  return useRegistryContext().capabilities;
}

/** Why an `upstream.*` capability the server did not report is unavailable (C0 capabilities.ts: AP6). */
export const UPSTREAM_UNAVAILABLE: CapabilityStatus = Object.freeze({
  state: "unavailable",
  via: "upstream",
  detail: "Needs a newer version of omp.",
});

/**
 * The status to show for one capability: the server's report, or for an unreported `upstream.*` key
 * the standing upstream reason; `undefined` means unknown (treated as unavailable).
 */
export function capabilityStatus(
  capabilities: CapabilityMap,
  key: CapabilityKey,
): CapabilityStatus | undefined {
  return capabilities[key] ?? (key.startsWith("upstream.") ? UPSTREAM_UNAVAILABLE : undefined);
}

/** The status of one capability, with its `detail`, for showing why a control is disabled. */
export function useCapabilityStatus(key: CapabilityKey): CapabilityStatus | undefined {
  return capabilityStatus(useRegistryContext().capabilities, key);
}

/** A descriptor is available when every capability it `requires` is usable (available or fallback). */
export function isDescriptorAvailable(
  descriptor: Descriptor,
  capabilities: CapabilityMap,
): boolean {
  return descriptor.requires.every((key) => isUsable(capabilities, key));
}

/** Whether the descriptor named by `id` is currently available; `false` when the id is unknown. */
export function useIsDescriptorAvailable(id: DescriptorId): boolean {
  const descriptor = useDescriptor(id);
  const capabilities = useCapabilities();
  return descriptor !== undefined && isDescriptorAvailable(descriptor, capabilities);
}
