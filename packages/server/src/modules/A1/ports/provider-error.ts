import { ProviderErrorPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { providerErrorDetails } from "../sessions/worker-reason";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createProviderErrorRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    ProviderErrorPort,
    {
      parse: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return providerErrorDetails(args.text);
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
