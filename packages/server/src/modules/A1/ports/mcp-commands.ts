import { McpCommandsPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { McpCommandsService } from "../mcp-commands/service";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createMcpCommandsRegistration(context: A1PortContext): PortRegistration {
  const service = new McpCommandsService(context.ompCommandGateway);
  return createA1PortRegistration(
    McpCommandsPort,
    {
      servers: (args, handlerContext) => service.servers(args, { signal: handlerContext.signal }),
      prompts: (args, handlerContext) => service.prompts(args, { signal: handlerContext.signal }),
      resources: (args, handlerContext) =>
        service.resources(args, { signal: handlerContext.signal }),
      action: (args, handlerContext) => service.action(args, { signal: handlerContext.signal }),
      help: (args, handlerContext) => service.help(args, { signal: handlerContext.signal }),
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
