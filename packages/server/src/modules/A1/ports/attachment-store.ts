import { AttachmentBlobStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createAttachmentStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    AttachmentBlobStore,
    {
      put: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.attachmentStore.put(args);
      },
      get: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.attachmentStore.get(args);
      },
      delete: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.attachmentStore.delete(args);
      },
      list: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.attachmentStore.list();
      },
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
