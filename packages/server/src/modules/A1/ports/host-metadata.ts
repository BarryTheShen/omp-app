import { HostMetadataPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import { readHostMetadata } from "../host";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createHostMetadataRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    HostMetadataPort,
    {
      read: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return (context.readHostMetadata ?? readHostMetadata)(args.folder);
      },
    },
    context.publish,
  );
}
