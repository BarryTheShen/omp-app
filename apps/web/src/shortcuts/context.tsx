import type { Descriptor } from "@omp-app/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type PreferenceStore, ShortcutRegistry } from "./registry";

const ShortcutRegistryContext = createContext<ShortcutRegistry | undefined>(undefined);

export interface ShortcutRegistryProviderProps {
  readonly descriptors: readonly Descriptor[];
  readonly preferenceStore?: PreferenceStore;
  readonly children: ReactNode;
}

export function ShortcutRegistryProvider({
  descriptors,
  preferenceStore,
  children,
}: ShortcutRegistryProviderProps) {
  const registry = useMemo(
    () => new ShortcutRegistry(descriptors, { preferenceStore }),
    [descriptors, preferenceStore],
  );
  return (
    <ShortcutRegistryContext.Provider value={registry}>{children}</ShortcutRegistryContext.Provider>
  );
}

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(ShortcutRegistryContext);
  if (registry === undefined)
    throw new Error("useShortcutRegistry must be used inside ShortcutRegistryProvider");
  return registry;
}

export function useShortcutBindings() {
  const registry = useShortcutRegistry();
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const getSnapshot = useCallback(() => registry.bindings(), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function useShortcutError() {
  const registry = useShortcutRegistry();
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const getSnapshot = useCallback(() => registry.lastError(), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
export function useShortcutPreferenceError() {
  const registry = useShortcutRegistry();
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const getSnapshot = useCallback(() => registry.preferenceError(), [registry]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useShortcutScope(scope: string): void {
  const registry = useShortcutRegistry();
  // A layout effect: the listener is attached in the commit that paints the shell, before the browser paints it, so a
  // key pressed as the shell appears reaches the scope (issue 2266). Layout effects of one commit run in tree order, as
  // passive ones did, so scopes that are active together keep their order.
  useLayoutEffect(() => {
    const listener = (event: KeyboardEvent) => registry.dispatch(event, scope);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [registry, scope]);
}
