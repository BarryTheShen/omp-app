import { DraftStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createDraftStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    DraftStore,
    {
      get: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.draftStore.get(args);
      },
      save: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.draftStore.save(args);
      },
      clear: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.draftStore.clear(args);
      },
    },
    context.publish,
  );
}
