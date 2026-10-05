import { SessionImportPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Registers the A1.12 import seam; the store owns upstream capability gating and validation. */
export function createSessionImportRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    SessionImportPort,
    {
      import: (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.sessionImportStore.import(args, handlerContext.signal);
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
