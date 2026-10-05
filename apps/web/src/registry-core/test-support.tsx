/** Shared by this folder's `*.test.tsx` files; not itself a test (no `*.test.` in its name). */
import type { CapabilityMap } from "@omp-app/contracts";
import type { ReactNode } from "react";
import { type Registry, RegistryProvider, type RendererMap } from "./index";

/** Wraps `children` in a `RegistryProvider` for one render; renderers default to empty. */
export function withRegistry(
  registry: Registry,
  capabilities: CapabilityMap,
  children: ReactNode,
  renderers: RendererMap = {},
) {
  return (
    <RegistryProvider registry={registry} renderers={renderers} capabilities={capabilities}>
      {children}
    </RegistryProvider>
  );
}
