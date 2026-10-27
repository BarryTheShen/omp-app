import type {
  AbortSignalLike,
  CapabilityMap,
  ModeChangeArgs,
  ModeChangeResult,
  PortCallOptions,
  ThreadId,
} from "@omp-app/contracts";
import type { ChatHostMethodMap } from "@omp-app/contracts/chat-host";
import type {
  GetStateResult,
  ModeCommandResult,
  ModeRequest,
  ModeSnapshot,
  ToolAvailability,
} from "./models";

/** AP4 gateway seam: the server reads omp's reply into a typed outcome; D7 never matches command text. */
export interface ModeCommandGateway {
  readonly change: (args: ModeChangeArgs, options?: PortCallOptions) => Promise<ModeChangeResult>;
}

/** The chat host's requests for the modes omp reports and changes; params and results are the host's (`@omp-app/contracts`). */
export interface ModeRpc {
  readonly getState: (options?: PortCallOptions) => Promise<GetStateResult>;
  readonly setFastMode: (
    args: ChatHostMethodMap["set_fast_mode"]["params"],
    options?: PortCallOptions,
  ) => Promise<ChatHostMethodMap["set_fast_mode"]["result"]>;
  readonly setSlowMode: (
    args: ChatHostMethodMap["set_slow_mode"]["params"],
    options?: PortCallOptions,
  ) => Promise<ChatHostMethodMap["set_slow_mode"]["result"]>;
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
