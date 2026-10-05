import { MemoryChanged, MemoryStore as MemoryStorePort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** A1.14 registers its own memory handler through A1.9's shared registration helper. */
export function createMemoryStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.memoryStore.subscribe((change) => listener(MemoryChanged.parse(change))),
      scope: (payload: unknown): string | undefined => {
        const parsed = MemoryChanged.safeParse(payload);
        if (!parsed.success) return undefined;
        return `${parsed.data.scope}:${parsed.data.folder ?? "global"}`;
      },
    },
  ];
  return createA1PortRegistration(
    MemoryStorePort,
    {
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.memoryStore.list(args);
      },
      get: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.memoryStore.get(args);
      },
      write: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.memoryStore.write(args);
      },
      delete: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.memoryStore.delete(args);
      },
      clear: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.memoryStore.clear(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
