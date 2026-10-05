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
}

export function createA0Runtime(context: A0PortContext): A0Runtime {
  const rpc = createRpcSessionPortRuntime(context);
  return {
    registrations: [
      { port: rpc.port, handlers: rpc.runtime.handlers, context: rpc.runtime },
      createAppPortRegistration(context),
    ],
    sessionFor: (threadId) => rpc.runtime.sessionFor(threadId),
  };
}

export function createA0PortRegistrations(context: A0PortContext): readonly PortRegistration[] {
  return createA0Runtime(context).registrations;
}

export type { A0PortContext, RpcSessionPortRegistration, ThreadBootstrap };
