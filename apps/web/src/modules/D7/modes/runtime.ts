import type { AppClient } from "@omp-app/client";
import {
  OmpCommandGateway,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import type { ModeCommandGateway, ModeRpc } from "../contract";

/** A0.8 typed RPC adapter for the released fast- and slow-mode commands. */
export function createModeRpc(client: AppClient, threadId: ThreadId): ModeRpc {
  const rpc = client.port(RpcSessionPort) as RpcSessionClient;
  return {
    getState: (options) => rpc.send({ threadId, command: { type: "get_state" } }, options),
    setFastMode: (args, options) =>
      rpc.send({ threadId, command: { type: "set_fast_mode", ...args } }, options),
    setSlowMode: (args, options) =>
      rpc.send({ threadId, command: { type: "set_slow_mode", ...args } }, options),
  };
}

/** A1.9 typed command-gateway adapter; D7 never talks to omp JSONL directly. */
export function createModeCommandGateway(client: AppClient): ModeCommandGateway {
  const gateway = client.port(OmpCommandGateway);
  return { change: (args, options) => gateway.modeChange(args, options) };
}
