import { AppHealth, AppPort, AppServerInfo, CapabilityMap } from "@omp-app/contracts";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";
import type { A0PortContext } from "./rpc-session";

export function createAppPortRegistration(context: A0PortContext): PortRegistration {
  return {
    port: AppPort,
    context,
    handlers: {
      serverInfo: (_args: unknown, _call: PortHandlerContext): AppServerInfo =>
        AppServerInfo.parse(context.serverInfo),
      capabilities: (_args: unknown, _call: PortHandlerContext) =>
        CapabilityMap.parse(context.capabilities),
      health: (_args: unknown, _call: PortHandlerContext): AppHealth =>
        AppHealth.parse(context.health),
    },
  };
}
