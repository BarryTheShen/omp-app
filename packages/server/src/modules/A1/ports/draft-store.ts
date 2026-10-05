import { DraftStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createDraftStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribeScoped: (scope: string, listener: (payload: unknown) => void) => {
        if (scope.startsWith("thread:") && scope.length > "thread:".length) {
          return context.draftStore.subscribe(
            { kind: "thread", threadId: scope.slice("thread:".length) },
            listener,
          );
        }
        if (scope.startsWith("folder:") && scope.length > "folder:".length) {
          return context.draftStore.subscribe(
            { kind: "folder", folder: scope.slice("folder:".length) },
            listener,
          );
        }
        return () => undefined;
      },
    },
  ];
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
    bindings,
    context.watchStreamActivity,
  );
}
