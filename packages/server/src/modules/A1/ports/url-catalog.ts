import { UrlCatalogChanged, UrlCatalogPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Registers the cached, metadata-only URL catalog with A1.9's replay helper. */
export function createUrlCatalogRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.urlCatalog.subscribe((revision) => listener(UrlCatalogChanged.parse({ revision }))),
      scope: () => undefined,
    },
  ];
  return createA1PortRegistration(
    UrlCatalogPort,
    {
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.urlCatalog.list(args, handlerContext.signal);
      },
      refresh: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.urlCatalog.refresh(args, handlerContext.signal);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
