import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type MemoryChanged,
  type MemoryClearArgs,
  type MemoryClearResult,
  type MemoryDeleteArgs,
  type MemoryDeleteResult,
  type MemoryGetArgs,
  type MemoryGetResult,
  MemoryId as MemoryIdSchema,
  type MemoryListArgs,
  type MemoryListResult,
  type MemoryScope,
  MemoryStore,
  type MemoryWriteArgs,
  type MemoryWriteResult,
  type PortCallOptions,
  type PortClient,
} from "@omp-app/contracts";

export const MEMORY_EDIT_CAPABILITY = "upstream.memory-edit" as const;
export const MEMORY_EDIT_UNAVAILABLE_REASON =
  "Memory editing is unavailable until omp exposes a typed memory-edit capability." as const;

type MemoryPortClient = PortClient<typeof MemoryStore>;
type MemoryCallOptions = Pick<PortCallOptions, "signal">;

export interface MemoryScopeSelection {
  readonly scope: MemoryScope;
  readonly folder: MemoryListArgs["folder"];
}

export interface MemoryStoreAdapter {
  readonly list: (args: MemoryListArgs, options?: MemoryCallOptions) => Promise<MemoryListResult>;
  readonly get: (args: MemoryGetArgs, options?: MemoryCallOptions) => Promise<MemoryGetResult>;
  readonly write: (
    args: MemoryWriteArgs,
    options?: MemoryCallOptions,
  ) => Promise<MemoryWriteResult>;
  readonly delete: (
    args: MemoryDeleteArgs,
    options?: MemoryCallOptions,
  ) => Promise<MemoryDeleteResult>;
  readonly clear: (
    args: MemoryClearArgs,
    options?: MemoryCallOptions,
  ) => Promise<MemoryClearResult>;
  readonly subscribeChanged: (
    scope: MemoryScopeSelection,
    listener: (change: MemoryChanged) => void,
  ) => () => void;
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function memoryId(value: string): MemoryGetArgs["id"] {
  const parsed = MemoryIdSchema.safeParse(value);
  if (!parsed.success) throw invalidArgs("The memory id is invalid.");
  return parsed.data;
}

function requireConfirmation(confirmed: boolean | undefined, operation: string): void {
  if (confirmed === true) return;
  throw invalidArgs(`Memory ${operation} requires explicit confirmation.`);
}

function memoryScopeKey(scope: MemoryScopeSelection): string {
  return `${scope.scope}:${scope.folder ?? "global"}`;
}

function subscribeScoped(
  client: AppClient,
  scope: string,
  listener: (change: MemoryChanged) => void,
): () => void {
  let active = true;
  let removeListener: (() => void) | undefined;
  let subscription:
    | {
        readonly onEvent: (listener: (payload: MemoryChanged) => void) => () => void;
        readonly unsubscribe: () => Promise<void>;
      }
    | undefined;
  const pending = client
    .subscribe(MemoryStore, "changed", { scope })
    .then((next) => {
      subscription = next;
      if (!active) {
        void next.unsubscribe();
        return;
      }
      removeListener = next.onEvent((payload) => listener(payload));
    })
    .catch(() => undefined);
  return () => {
    active = false;
    removeListener?.();
    void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
  };
}

/** Adapts A0.8's typed AppClient to the browser MemoryStore seam without changing failures. */
export function createMemoryStoreAdapter(client: AppClient): MemoryStoreAdapter {
  const port: MemoryPortClient = client.port(MemoryStore);
  return {
    list: (args, options) => port.list(args, options),
    get: async (args, options) => port.get({ ...args, id: memoryId(args.id) }, options),
    write: async (args, options) =>
      port.write(args.id === undefined ? args : { ...args, id: memoryId(args.id) }, options),
    delete: async (args, options) => {
      requireConfirmation(args.confirmed, "delete");
      return port.delete({ ...args, id: memoryId(args.id) }, options);
    },
    clear: async (args, options) => {
      requireConfirmation(args.confirmed, "clear");
      return port.clear(args, options);
    },
    subscribeChanged: (scope, listener) => subscribeScoped(client, memoryScopeKey(scope), listener),
  };
}
