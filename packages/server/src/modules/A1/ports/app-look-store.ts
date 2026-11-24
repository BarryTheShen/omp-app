import { AppLookStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** The app's look for every device; every saved change goes to every connected page as `changed`. */
export function createAppLookStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    AppLookStore,
    {
      read: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.appLookStore.read();
      },
      set: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.appLookStore.set(args);
      },
    },
    context.publish,
    [{ event: "changed", subscribe: (listener) => context.appLookStore.subscribe(listener) }],
    context.watchStreamActivity,
  );
}
