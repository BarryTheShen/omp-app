import { ConfigChanged, ConfigStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createConfigStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.configStore.subscribe(null, listener as (change: ConfigChanged) => void),
      scope: (payload: unknown) => {
        const change = ConfigChanged.parse(payload);
        return change.folder ?? "global";
      },
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
  );
}
