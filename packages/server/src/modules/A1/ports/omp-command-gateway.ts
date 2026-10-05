import { CommandOutputEvent, OmpCommandGateway } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createOmpCommandGatewayRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "output",
      subscribe: (listener: (payload: unknown) => void) =>
        context.ompCommandGateway.onOutput(listener as (event: CommandOutputEvent) => void),
      scope: (payload: unknown) => CommandOutputEvent.parse(payload).threadId,
    },
  ];
  return createA1PortRegistration(
    OmpCommandGateway,
    {
      run: (args, handlerContext) =>
        context.ompCommandGateway.run(args, { signal: handlerContext.signal }),
    },
    context.publish,
    bindings,
  );
}
