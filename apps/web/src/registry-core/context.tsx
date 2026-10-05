/**
 * The React context that makes one built `Registry`, its renderer map, and the live
 * `CapabilityMap` available to the hooks in `hooks.ts`.
 */
import type { CapabilityMap } from "@omp-app/contracts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { createRegistry } from "./create-registry";
import type { Registry, RendererMap } from "./types";

export interface RegistryContextValue {
  readonly registry: Registry;
  readonly renderers: RendererMap;
  readonly capabilities: CapabilityMap;
}

const EMPTY_RENDERERS: RendererMap = Object.freeze({});
const EMPTY_CAPABILITIES: CapabilityMap = Object.freeze({});

/**
 * Defaults to an empty registry and never throws: a tree rendered without `RegistryProvider` (a
 * forgotten wire-up, or a component unit-tested on its own) sees no descriptors and the renderer
 * fallback, not a crash — the same convention the copied `ThreadComponentsContext` uses.
 */
const RegistryContext = createContext<RegistryContextValue>({
  registry: createRegistry([]),
  renderers: EMPTY_RENDERERS,
  capabilities: EMPTY_CAPABILITIES,
});

export interface RegistryProviderProps extends RegistryContextValue {
  readonly children: ReactNode;
}

/**
 * Makes one built `Registry`, its merged renderer map, and the live `CapabilityMap` available to
 * every hook in the tree below it.
 */
export function RegistryProvider({
  registry,
  renderers,
  capabilities,
  children,
}: RegistryProviderProps) {
  const value = useMemo<RegistryContextValue>(
    () => ({ registry, renderers, capabilities }),
    [registry, renderers, capabilities],
  );
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

/** Internal: every hook in `hooks.ts` reads the provider's value through this. */
export function useRegistryContext(): RegistryContextValue {
  return useContext(RegistryContext);
}
