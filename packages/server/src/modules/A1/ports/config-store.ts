import { type ConfigChanged, ConfigStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createConfigStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribeScoped: (scope: string, listener: (payload: unknown) => void) =>
        context.configStore.subscribe(
          scope === "global" ? null : scope,
          listener as (change: ConfigChanged) => void,
        ),
    },
  ];
  return createA1PortRegistration(
    ConfigStore,
    {
      read: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.configStore.read(args);
      },
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.configStore.list(args);
      },
      write: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.configStore.write(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
