import { PlanChanged, PlanDocumentStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { createPlanDocumentStore, type PlanDocumentStoreService } from "../plans";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Registers the app-owned plan store; omp session files are never part of this handler. */
export function createPlanDocumentRegistration(
  context: A1PortContext,
  store: PlanDocumentStoreService = createPlanDocumentStore(),
): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        store.subscribe(null, listener as (change: PlanChanged) => void),
      scope: (payload: unknown) => PlanChanged.parse(payload).threadId,
    },
  ];
  return createA1PortRegistration(
    PlanDocumentStore,
    {
      load: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return store.load(args);
      },
      save: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return store.save(args);
      },
      export: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return store.export(args);
      },
    },
    context.publish,
    bindings,
  );
}
