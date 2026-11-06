import { UsageLimitStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/**
 * The usage limits omp reports; every fresh read, a page's or the server's own watch, goes to every page as `changed`.
 * `pace` gives each window's burn rate and forecast from the server's own readings (#2836).
 */
export function createUsageLimitStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    UsageLimitStore,
    {
      read: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.usageLimitStore.read();
      },
      pace: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.usageReadings.pace();
      },
    },
    context.publish,
    [
      {
        event: "changed",
        subscribe: (listener) => context.usageLimitStore.subscribe(listener),
      },
    ],
    context.watchStreamActivity,
  );
}
