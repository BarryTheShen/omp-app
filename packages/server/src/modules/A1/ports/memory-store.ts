import { MemoryChanged, MemoryStore as MemoryStorePort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { MemoryStoreService } from "../memory";
import { type A1EventPublisher, assertNotAborted, createA1PortRegistration } from "./helper";

/** A1.14 registers its own memory handler through A1.9's shared registration helper. */
export function createMemoryStoreRegistration(
  memoryStore: MemoryStoreService,
  publish?: A1EventPublisher,
): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        memoryStore.subscribe((change) => listener(change)),
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
      list: async (args, context) => {
        assertNotAborted(context);
        return memoryStore.list(args);
      },
      get: async (args, context) => {
        assertNotAborted(context);
        return memoryStore.get(args);
      },
      write: async (args, context) => {
        assertNotAborted(context);
        return memoryStore.write(args);
      },
      delete: async (args, context) => {
        assertNotAborted(context);
        return memoryStore.delete(args);
      },
      clear: async (args, context) => {
        assertNotAborted(context);
        return memoryStore.clear(args);
      },
    },
    publish,
    bindings,
  );
}
