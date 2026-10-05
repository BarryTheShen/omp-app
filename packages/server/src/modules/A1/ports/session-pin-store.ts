import { SessionPinChanged, SessionPinStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createSessionPinStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.sessionPinStore.subscribe(listener as (change: SessionPinChanged) => void),
      scope: (payload: unknown) => SessionPinChanged.parse(payload).sessionId,
    },
  ];
  return createA1PortRegistration(
    SessionPinStore,
    {
      list: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.sessionPinStore.list();
      },
      set: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.sessionPinStore.set(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
