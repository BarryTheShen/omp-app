/**
 * Public surface of U0's descriptor registry (`modules/U0/README.md`, Plan item 7): build one
 * with `createRegistry`, provide it with `RegistryProvider`, and read it with the hooks below.
 * Every other module registers its own descriptors and renderers from its own folder; only the
 * main agent edits the composition index (`apps/web/src/registry/`) that merges them.
 */

export type { RegistryContextValue, RegistryProviderProps } from "./context";
export { RegistryProvider } from "./context";
export { createRegistry } from "./create-registry";
export {
  isDescriptorAvailable,
  useCapabilities,
  useCapability,
  useDescriptor,
  useDescriptors,
  useIsDescriptorAvailable,
  useRenderer,
} from "./hooks";
export { MissingRendererFallback, registerRenderers } from "./renderers";
export type {
  DescriptorKind,
  DescriptorOfKind,
  DescriptorRenderer,
  Registry,
  RendererMap,
} from "./types";
