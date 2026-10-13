import type { ThreadId } from "@omp-app/contracts";
import type { RpcSession } from "@omp-app/omp-rpc";
import type { PortRegistration } from "../../registry/ports";
import { createAppPortRegistration } from "./app";
import {
  type A0PortContext,
  createRpcSessionPortRuntime,
  type RpcSessionPortRegistration,
  type ThreadBootstrap,
} from "./rpc-session";

export * from "./app";
export * from "./rpc-session";

/**
 * Main's registry composition seam. Add the returned registrations to `createPortRegistry([...])`
 * in `packages/server/src/registry/ports.ts`; no central registry edit belongs in this part.
 */
export interface A0Runtime {
  readonly registrations: readonly PortRegistration[];
  sessionFor(threadId: ThreadId): RpcSession | undefined;
  /** The views each connection holds on the chats this runtime runs: a delete of a chat lets its own views go. */
  readonly views: {
    viewsOf(threadId: ThreadId, connectionId: string): number;
    releaseViews(threadId: ThreadId, connectionId: string): Promise<void>;
  };
}

export function createA0Runtime(context: A0PortContext): A0Runtime {
  const rpc = createRpcSessionPortRuntime(context);
  return {
    registrations: [
      {
        port: rpc.port,
        handlers: rpc.runtime.handlers,
        context: rpc.runtime,
        onConnectionClosed: (connectionId) => rpc.runtime.releaseConnection(connectionId),
      },
      createAppPortRegistration(context),
    ],
    sessionFor: (threadId) => rpc.runtime.sessionFor(threadId),
    views: {
      viewsOf: (threadId, connectionId) => rpc.runtime.viewsOf(threadId, connectionId),
      releaseViews: (threadId, connectionId) => rpc.runtime.releaseViews(threadId, connectionId),
    },
  };
}

export function createA0PortRegistrations(context: A0PortContext): readonly PortRegistration[] {
  return createA0Runtime(context).registrations;
}

export type { A0PortContext, RpcSessionPortRegistration, ThreadBootstrap };
