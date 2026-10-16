import type { SessionFilePath, ThreadId } from "@omp-app/contracts";
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
  sessionFileOf(threadId: ThreadId): SessionFilePath | undefined;
  /**
   * The views each connection holds on the chats this runtime runs. A delete of a chat counts them; omp's exit takes the
   * views of a chat with it, since its entry goes.
   */
  readonly views: {
    viewsOf(threadId: ThreadId, connectionId: string): number;
    watcherCount(threadId: ThreadId): number;
    releaseViews(threadId: ThreadId, connectionId: string): Promise<void>;
    /** Gives the connection back the views a delete's stop took, joined to the chat's running omp (see the rpc runtime). */
    restoreViews(threadId: ThreadId, connectionId: string, count: number): void;
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
    sessionFileOf: (threadId) => rpc.runtime.sessionFileOf(threadId),
    views: {
      viewsOf: (threadId, connectionId) => rpc.runtime.viewsOf(threadId, connectionId),
      watcherCount: (threadId) => rpc.runtime.watcherCount(threadId),
      releaseViews: (threadId, connectionId) => rpc.runtime.releaseViews(threadId, connectionId),
      restoreViews: (threadId, connectionId, count) =>
        rpc.runtime.restoreViews(threadId, connectionId, count),
    },
  };
}

export function createA0PortRegistrations(context: A0PortContext): readonly PortRegistration[] {
  return createA0Runtime(context).registrations;
}

export type { A0PortContext, RpcSessionPortRegistration, ThreadBootstrap };
