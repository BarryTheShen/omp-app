import type { AppClient } from "@omp-app/client";
import {
  OmpCommandGateway,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import type { FastModeRpc, ModeCommandGateway } from "../contract";

/** A0.8 typed RPC adapter for the two released fast-mode commands. */
export function createFastModeRpc(client: AppClient, threadId: ThreadId): FastModeRpc {
  const rpc = client.port(RpcSessionPort) as RpcSessionClient;
  return {
    getState: (options) => rpc.send({ threadId, command: { type: "get_state" } }, options),
    setFastMode: (args, options) =>
      rpc.send({ threadId, command: { type: "set_fast_mode", ...args } }, options),
  };
}

/** A1.9 typed command-gateway adapter; D7 never talks to omp JSONL directly. */
export function createModeCommandGateway(client: AppClient): ModeCommandGateway {
  const gateway = client.port(OmpCommandGateway);
  return { change: (args, options) => gateway.modeChange(args, options) };
}
