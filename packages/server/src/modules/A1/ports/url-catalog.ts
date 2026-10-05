import { UrlCatalogChanged, UrlCatalogPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { createUrlCatalog, type UrlCatalogService } from "../url-catalog";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Registers the cached, metadata-only URL catalog with A1.9's replay helper. */
export function createUrlCatalogRegistration(
  context: A1PortContext,
  catalog: UrlCatalogService = createUrlCatalog(),
): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        catalog.subscribe((revision) => listener(UrlCatalogChanged.parse({ revision }))),
      scope: () => undefined,
    },
  ];
  return createA1PortRegistration(
    UrlCatalogPort,
    {
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return catalog.list(args, handlerContext.signal);
      },
      refresh: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return catalog.refresh(args, handlerContext.signal);
      },
    },
    context.publish,
    bindings,
  );
}
