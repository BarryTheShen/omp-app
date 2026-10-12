import type {
  AbortSignalLike,
  CapabilityMap,
  ModeChangeArgs,
  ModeChangeResult,
  OmpCommandMap,
  PortCallOptions,
  ThreadId,
} from "@omp-app/contracts";
import type { ModeCommandResult, ModeRequest, ModeSnapshot, ToolAvailability } from "./models";

/** AP4 gateway seam: the server reads omp's reply into a typed outcome; D7 never matches command text. */
export interface ModeCommandGateway {
  readonly change: (args: ModeChangeArgs, options?: PortCallOptions) => Promise<ModeChangeResult>;
}

/** A0.8 direct RPC seam for the modes omp reports and changes over RPC; params and results stay owned by @omp-app/contracts. */
export interface ModeRpc {
  readonly getState: (options?: PortCallOptions) => Promise<OmpCommandMap["get_state"]["result"]>;
  readonly setFastMode: (
    args: OmpCommandMap["set_fast_mode"]["params"],
    options?: PortCallOptions,
  ) => Promise<OmpCommandMap["set_fast_mode"]["result"]>;
  readonly setSlowMode: (
    args: OmpCommandMap["set_slow_mode"]["params"],
    options?: PortCallOptions,
  ) => Promise<OmpCommandMap["set_slow_mode"]["result"]>;
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
  readonly rpc?: ModeRpc;
  readonly signal?: AbortSignalLike;
}
