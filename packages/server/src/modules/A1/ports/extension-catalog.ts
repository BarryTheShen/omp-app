import { ExtensionCatalog, type ExtensionCatalogChanged } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createExtensionCatalogRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.extensionCatalog.subscribe(
          null,
          listener as (change: ExtensionCatalogChanged) => void,
        ),
    },
  ];
  return createA1PortRegistration(
    ExtensionCatalog,
    {
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.extensionCatalog.list(args);
      },
      reload: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.extensionCatalog.reload(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
