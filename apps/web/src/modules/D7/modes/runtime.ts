import type { AppClient } from "@omp-app/client";
import {
  type ChatSessionClient,
  ChatSessionPort,
  OmpCommandGateway,
  type ThreadId,
} from "@omp-app/contracts";
import type { ModeCommandGateway, ModeHost } from "../contract";

/** The fast- and slow-mode requests on the chat session port. */
export function createModeHost(client: AppClient, threadId: ThreadId): ModeHost {
  const session = client.port(ChatSessionPort) as ChatSessionClient;
  return {
    getState: (options) => session.request({ threadId, method: "get_state", params: {} }, options),
    setFastMode: (args, options) =>
      session.request({ threadId, method: "set_fast_mode", params: args }, options),
    setSlowMode: (args, options) =>
      session.request({ threadId, method: "set_slow_mode", params: args }, options),
  };
}

/** A1.9 typed command-gateway adapter; D7 never talks to omp JSONL directly. */
export function createModeCommandGateway(client: AppClient): ModeCommandGateway {
  const gateway = client.port(OmpCommandGateway);
  return { change: (args, options) => gateway.modeChange(args, options) };
}
