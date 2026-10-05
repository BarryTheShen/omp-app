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
export function createA0PortRegistrations(context: A0PortContext): readonly PortRegistration[] {
  const rpc = createRpcSessionPortRuntime(context);
  return [
    { port: rpc.port, handlers: rpc.runtime.handlers, context: rpc.runtime },
    createAppPortRegistration(context),
  ];
}

export type { A0PortContext, RpcSessionPortRegistration, ThreadBootstrap };
