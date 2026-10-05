import { PlanChanged, PlanDocumentStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Registers the app-owned plan store; omp session files are never part of this handler. */
export function createPlanDocumentRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.planDocumentStore.subscribe(null, listener as (change: PlanChanged) => void),
      scope: (payload: unknown) => PlanChanged.parse(payload).threadId,
    },
  ];
  return createA1PortRegistration(
    PlanDocumentStore,
    {
      load: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.planDocumentStore.load(args);
      },
      save: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.planDocumentStore.save(args);
      },
      export: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.planDocumentStore.export(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
