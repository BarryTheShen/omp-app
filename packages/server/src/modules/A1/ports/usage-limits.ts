import { UsageLimitStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createUsageLimitStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    UsageLimitStore,
    {
      read: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.usageLimitStore.read();
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
