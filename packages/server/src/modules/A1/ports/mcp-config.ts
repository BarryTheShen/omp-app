import { McpConfigPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { McpConfigService } from "../mcp-config/service";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

/** omp's MCP config files, the user's and a folder's, read and written with omp's own code (#16). */
export function createMcpConfigRegistration(context: A1PortContext): PortRegistration {
  const service = new McpConfigService(context.agentDir);
  return createA1PortRegistration(
    McpConfigPort,
    {
      servers: (args) => service.servers(args.folder),
      save: async (args) => {
        await service.save(args);
        return null;
      },
      remove: async (args) => {
        await service.remove(args);
        return null;
      },
      setEnabled: async (args) => {
        await service.setEnabled(args);
        return null;
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
