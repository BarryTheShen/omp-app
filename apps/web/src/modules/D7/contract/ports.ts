import type {
  AbortSignalLike,
  CapabilityMap,
  CommandRunArgs,
  CommandRunResult,
  OmpCommandMap,
  PortCallOptions,
  ThreadId,
} from "@omp-app/contracts";
import type { ModeCommandResult, ModeRequest, ModeSnapshot, ToolAvailability } from "./models";

/** AP4 gateway seam; D7 never matches command_output text or sends raw wire frames. */
export interface ModeCommandGateway {
  readonly run: (args: CommandRunArgs, options?: PortCallOptions) => Promise<CommandRunResult>;
}

/** A0.8 direct RPC seam used by fast mode; params/results stay owned by @omp-app/contracts. */
export interface FastModeRpc {
  readonly getState: (options?: PortCallOptions) => Promise<OmpCommandMap["get_state"]["result"]>;
  readonly setFastMode: (
    args: OmpCommandMap["set_fast_mode"]["params"],
    options?: PortCallOptions,
  ) => Promise<OmpCommandMap["set_fast_mode"]["result"]>;
}

export interface ExecutionModePort {
  readonly getSnapshot: () => ModeSnapshot;
  readonly request: (request: ModeRequest, options?: PortCallOptions) => Promise<ModeCommandResult>;
  readonly refresh: (options?: PortCallOptions) => Promise<ModeSnapshot>;
  readonly subscribe: (listener: (snapshot: ModeSnapshot) => void) => () => void;
}

export interface ToolAvailabilityPort {
  readonly list: () => readonly ToolAvailability[];
  readonly get: (tool: string) => ToolAvailability | undefined;
  readonly refresh: (options?: PortCallOptions) => Promise<readonly ToolAvailability[]>;
  readonly subscribe: (listener: (tools: readonly ToolAvailability[]) => void) => () => void;
}

export interface ModeContractContext {
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly gateway?: ModeCommandGateway;
  readonly fastRpc?: FastModeRpc;
  readonly signal?: AbortSignalLike;
}
