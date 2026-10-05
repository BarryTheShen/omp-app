import { FileSearchPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { searchWorkspaceFiles } from "../file-search";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createFileSearchRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    FileSearchPort,
    {
      search: (args, handlerContext) =>
        (context.searchWorkspaceFiles ?? searchWorkspaceFiles)(args, {
          signal: handlerContext.signal,
        }),
    },
    context.publish,
  );
}
