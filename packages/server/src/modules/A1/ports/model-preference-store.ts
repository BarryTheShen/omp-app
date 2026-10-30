import { ModelPreferenceStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** The model menu's stars and hidden models; every saved change goes to every connected page as `changed`. */
export function createModelPreferenceStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    ModelPreferenceStore,
    {
      read: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.modelPreferenceStore.read();
      },
      set: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.modelPreferenceStore.set(args);
      },
    },
    context.publish,
    [
      {
        event: "changed",
        subscribe: (listener) => context.modelPreferenceStore.subscribe(listener),
      },
    ],
    context.watchStreamActivity,
  );
}
