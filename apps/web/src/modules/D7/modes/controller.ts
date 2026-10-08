import {
  type AppError,
  AppError as AppErrorSchema,
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type PortCallOptions,
  type ThreadId,
} from "@omp-app/contracts";
import type { ExecutionModePort, FastModeRpc, ModeCommandGateway } from "../contract";
import {
  type ExecutionMode,
  FastModeState,
  type FastModeState as FastModeStateValue,
  type ModeCommandResult,
  ModeRequest,
  type ModeRequest as ModeRequestValue,
  ModeSnapshot,
  ModeState,
  type ModeStateKind,
  modeState,
  resolveModePrecedence,
  toolAvailability,
  unavailableMode,
} from "../contract";
import {
  type BrowserVisibility,
  D73_MODES,
  type D73Mode,
  isD73Mode,
  type ModeAction,
  modeCommand,
} from "./commands";

/** The subset of R0's projection needed by mode controls. */
export interface ModeSessionProjection {
  readonly fastModeEnabled: boolean | null;
  readonly fastModeActive: boolean | null;
  readonly revision: number;
}

/** R0.1's store can be adapted to this source without creating a second event reducer. */
export interface ModeSessionSource {
  readonly getSnapshot: () => ModeSessionProjection;
  readonly subscribe: (listener: (snapshot: ModeSessionProjection) => void) => () => void;
}

export interface ModeControllerOptions {
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly gateway?: ModeCommandGateway;
  readonly fastRpc?: FastModeRpc;
  readonly session?: ModeSessionSource;
  readonly signal?: PortCallOptions["signal"];
}

export type ModeControllerListener = (snapshot: ModeSnapshot) => void;

export interface ModeRequestOptions {
  readonly signal?: PortCallOptions["signal"];
}

export interface ModeControllerPort extends ExecutionModePort {
  readonly getBrowserVisibility: () => BrowserVisibility | null;
  readonly requestBrowserVisibility: (
    visibility: BrowserVisibility,
    options?: ModeRequestOptions,
  ) => Promise<ModeCommandResult>;
  readonly setCapabilities: (capabilities: CapabilityMap) => void;
  readonly dispose: () => void;
}

const COMMAND_MODES = D73_MODES.filter(
  (mode): mode is Exclude<D73Mode, "default" | "fast"> => mode !== "default" && mode !== "fast",
);

const TOOL_CAPABILITIES: Readonly<
  Partial<Record<Exclude<D73Mode, "default" | "fast">, CapabilityKey>>
> = {
  browser: "host.command-gateway",
  computer: "host.command-gateway",
};

function isCapabilityUsable(capabilities: CapabilityMap, capability: CapabilityKey): boolean {
  const state = capabilities[capability]?.state;
  return state === "available" || state === "fallback";
}

function errorFrom(cause: unknown, fallback: string, capability?: CapabilityKey): AppError {
  if (cause instanceof AppFailure) return cause.appError;
  const parsed = AppErrorSchema.safeParse(cause);
  if (parsed.success) return parsed.data;
  return {
    code: "internal",
    message: fallback,
    retryable: true,
    ...(capability ? { capability } : {}),
  };
}

function unavailableError(capability: CapabilityKey | undefined, message: string): AppError {
  return {
    code: "unavailable",
    message,
    retryable: false,
    ...(capability ? { capability } : {}),
  };
}

function cancelledError(message: string): AppError {
  return { code: "cancelled", message, retryable: false };
}

function stateWithError(
  mode: ExecutionMode,
  scope: ModeState["scope"],
  source: ModeState["source"],
  error: AppError,
): ModeState {
  return ModeState.parse({
    mode,
    scope,
    source,
    state: "unavailable",
    capability: error.capability,
    reason: error.message,
    error,
  });
}

function modeCommandResult(
  action: { readonly mode: ExecutionMode; readonly requested?: boolean },
  command: string,
  ok: boolean,
  state: ModeStateKind,
  error?: AppError,
  reason?: string,
  capability?: CapabilityKey,
): ModeCommandResult {
  return {
    ok,
    command,
    mode: action.mode,
    state,
    ...(reason ? { reason } : {}),
    ...(capability ? { capability } : {}),
    ...(error ? { error } : {}),
  };
}

function stateReason(capabilities: CapabilityMap, capability: CapabilityKey): string | undefined {
  return capabilities[capability]?.detail;
}

function initialFastState(
  capabilities: CapabilityMap,
  fastRpc: FastModeRpc | undefined,
): FastModeStateValue {
  const capability: CapabilityKey = "omp.cmd.set_fast_mode";
  if (!isCapabilityUsable(capabilities, capability) || fastRpc === undefined) {
    const error = unavailableError(
      capability,
      fastRpc === undefined
        ? "Fast mode is unavailable until the session RPC is connected."
        : (stateReason(capabilities, capability) ??
            "Fast mode is unavailable in this omp session."),
    );
    return FastModeState.parse({
      enabled: false,
      active: false,
      state: "unavailable",
      scope: "session",
      source: "omp-rpc",
      capability,
      reason: error.message,
      error,
    });
  }
  return FastModeState.parse({
    enabled: false,
    active: false,
    state: "requested",
    scope: "session",
    source: "omp-rpc",
    capability,
  });
}

function initialModeState(
  mode: Exclude<D73Mode, "fast">,
  capabilities: CapabilityMap,
  gateway: ModeCommandGateway | undefined,
): ModeState {
  if (mode === "default") {
    return modeState(mode, "default", "client", "known", capabilities, {
      enabled: true,
      active: true,
      requested: true,
    });
  }
  const capability = TOOL_CAPABILITIES[mode] ?? "host.command-gateway";
  if (gateway === undefined) {
    const error = unavailableError(capability, "Execution controls are unavailable in this view.");
    return stateWithError(mode, "session", "omp-command", error);
  }
  if (!isCapabilityUsable(capabilities, capability)) {
    return unavailableMode(mode, "session", "omp-command", stateReason(capabilities, capability));
  }
  return modeState(mode, "session", "omp-command", "fallback", capabilities, {
    requested: false,
    enabled: false,
    active: false,
    reason: "omp has not reported a live status for this mode; this request is waiting.",
  });
}

function commandOptions(
  signal: PortCallOptions["signal"] | undefined,
): ModeRequestOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

/**
 * Browser-side mode controller. It owns no omp state: released RPC fields come from the injected
 * fast-mode port, and slash commands go through A1's typed gateway without reading their output.
 */
export class ModeController implements ModeControllerPort {
  private capabilities: CapabilityMap;
  private readonly threadId: ThreadId;
  private readonly gateway: ModeCommandGateway | undefined;
  private readonly fastRpc: FastModeRpc | undefined;
  private readonly session: ModeSessionSource | undefined;
  private readonly signal: PortCallOptions["signal"] | undefined;
  private readonly listeners = new Set<ModeControllerListener>();
  private readonly unsubscribeSession: (() => void) | undefined;
  private snapshot: ModeSnapshot;
  private fast: FastModeStateValue;
  private browserVisibility: BrowserVisibility | null = null;
  private revision = 0;
  private modeStates: Partial<Record<ExecutionMode, ModeState>>;

  constructor(options: ModeControllerOptions) {
    this.capabilities = options.capabilities;
    this.threadId = options.threadId;
    this.gateway = options.gateway;
    this.fastRpc = options.fastRpc;
    this.session = options.session;
    this.signal = options.signal;
    this.fast = initialFastState(this.capabilities, this.fastRpc);
    this.modeStates = Object.fromEntries(
      D73_MODES.filter((mode): mode is Exclude<D73Mode, "fast"> => mode !== "fast").map((mode) => [
        mode,
        initialModeState(mode, this.capabilities, this.gateway),
      ]),
    ) as Partial<Record<ExecutionMode, ModeState>>;
    this.snapshot = this.buildSnapshot();
    this.unsubscribeSession = this.session?.subscribe((projection) => {
      this.applySessionProjection(projection);
    });
  }

  public getSnapshot(): ModeSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: ModeControllerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getBrowserVisibility(): BrowserVisibility | null {
    return this.browserVisibility;
  }

  public setCapabilities(capabilities: CapabilityMap): void {
    this.capabilities = capabilities;
    const fastCapability: CapabilityKey = "omp.cmd.set_fast_mode";
    if (!isCapabilityUsable(capabilities, fastCapability) || this.fast.state === "unavailable") {
      this.fast = initialFastState(capabilities, this.fastRpc);
    }
    for (const mode of COMMAND_MODES) {
      const current = this.modeStates[mode];
      const capability = TOOL_CAPABILITIES[mode] ?? "host.command-gateway";
      if (
        current === undefined ||
        current.state === "unavailable" ||
        !isCapabilityUsable(capabilities, capability)
      ) {
        this.modeStates[mode] = initialModeState(mode, capabilities, this.gateway);
      }
    }
    this.commit();
  }

  public async refresh(options?: ModeRequestOptions): Promise<ModeSnapshot> {
    if (this.fastRpc === undefined) {
      this.commit();
      return this.snapshot;
    }
    const capability: CapabilityKey = "omp.cmd.get_state";
    if (!isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(
        capability,
        stateReason(this.capabilities, capability) ?? "The session state command is unavailable.",
      );
      this.fast = this.fastFromValues(false, false, "unavailable", error.message, error);
      this.commit();
      throw new AppFailure(error);
    }
    try {
      const state = await this.fastRpc.getState(commandOptions(options?.signal ?? this.signal));
      const enabled = state.fastModeEnabled;
      const active = state.fastModeActive;
      if (enabled === undefined || active === undefined) {
        this.fast = this.fastFromValues(
          this.fast.enabled,
          this.fast.active,
          "requested",
          "omp did not include fast-mode state in its response.",
        );
      } else {
        this.fast = this.fastFromValues(enabled, active, "known");
      }
      this.commit();
      return this.snapshot;
    } catch (cause) {
      const error = errorFrom(cause, "The session state could not be refreshed.", capability);
      this.fast = this.fastFromValues(false, false, "unavailable", error.message, error);
      this.commit();
      throw new AppFailure(error, { cause });
    }
  }

  public async request(
    request: ModeRequestValue,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    const parsed = ModeRequest.parse(request);
    if (parsed.mode === "force") {
      const error = unavailableError(
        undefined,
        "Force execution is omp's one-shot choice for its next turn, not a mode, so this panel does not offer it.",
      );
      return modeCommandResult(
        { mode: parsed.mode, requested: true },
        "mode request",
        false,
        "unavailable",
        error,
        error.message,
      );
    }
    if (!isD73Mode(parsed.mode)) {
      const error = unavailableError(
        "host.command-gateway",
        "This execution mode is handled by another part of the app.",
      );
      return modeCommandResult(
        { mode: parsed.mode, requested: true },
        "mode request",
        false,
        "unavailable",
        error,
        error.message,
        error.capability,
      );
    }
    if (parsed.mode === "fast") return this.requestFast(parsed.requested, options);
    if (parsed.mode === "default") {
      const error = unavailableError(
        undefined,
        "Standard execution is the baseline and has no command to run.",
      );
      return modeCommandResult(
        { mode: parsed.mode, requested: parsed.requested },
        "standard execution",
        false,
        "unavailable",
        error,
        error.message,
      );
    }
    if (parsed.mode === "browser") {
      return this.requestBrowserVisibility(parsed.requested ? "visible" : "headless", options);
    }
    return this.requestCommand(
      {
        mode: parsed.mode as Exclude<D73Mode, "default" | "fast" | "browser">,
        requested: parsed.requested,
      },
      options,
    );
  }

  public async requestBrowserVisibility(
    visibility: BrowserVisibility,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    return this.requestCommand({ mode: "browser", visibility }, options);
  }

  public dispose(): void {
    this.unsubscribeSession?.();
    this.listeners.clear();
  }

  private async requestFast(
    requested: boolean,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    const command = "set_fast_mode";
    const capability: CapabilityKey = "omp.cmd.set_fast_mode";
    if (this.fastRpc === undefined || !isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(
        capability,
        this.fastRpc === undefined
          ? "Fast mode is unavailable until the session RPC is connected."
          : (stateReason(this.capabilities, capability) ?? "Fast mode is unavailable."),
      );
      this.fast = this.fastFromValues(false, false, "unavailable", error.message, error);
      this.commit();
      return modeCommandResult(
        { mode: "fast", requested },
        command,
        false,
        "unavailable",
        error,
        error.message,
        capability,
      );
    }
    this.fast = this.fastFromValues(requested, this.fast.active, "requested");
    this.commit();
    try {
      const result = await this.fastRpc.setFastMode(
        { enabled: requested },
        commandOptions(options?.signal ?? this.signal),
      );
      this.fast = this.fastFromValues(result.enabled, result.active, "known");
      this.commit();
      return modeCommandResult(
        { mode: "fast", requested },
        command,
        true,
        "known",
        undefined,
        undefined,
        capability,
      );
    } catch (cause) {
      const error = errorFrom(cause, "Fast mode could not be changed.", capability);
      this.fast = this.fastFromValues(requested, false, "unavailable", error.message, error);
      this.commit();
      if (error.code === "cancelled") {
        return modeCommandResult(
          { mode: "fast", requested },
          command,
          false,
          "unavailable",
          error,
          error.message,
          capability,
        );
      }
      return modeCommandResult(
        { mode: "fast", requested },
        command,
        false,
        "unavailable",
        error,
        error.message,
        capability,
      );
    }
  }

  private async requestCommand(
    action: ModeAction,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    const command = modeCommand(action);
    if (command === null) {
      const error = unavailableError(
        undefined,
        "This mode does not expose a command through the connected omp session.",
      );
      return modeCommandResult(action, "mode command", false, "unavailable", error, error.message);
    }
    const capability: CapabilityKey = "host.command-gateway";
    if (this.gateway === undefined || !isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(
        capability,
        this.gateway === undefined
          ? "Execution controls are unavailable until the command gateway is connected."
          : (stateReason(this.capabilities, capability) ?? "Execution controls are unavailable."),
      );
      this.modeStates[action.mode] = stateWithError(action.mode, "command", "omp-command", error);
      this.commit();
      return modeCommandResult(
        action,
        command,
        false,
        "unavailable",
        error,
        error.message,
        capability,
      );
    }
    // Only what was asked is recorded; omp's live state is not claimed until omp reports it.
    const requested = action.mode === "browser" ? true : action.requested;
    const pending = modeState(
      action.mode,
      "command",
      "omp-command",
      "requested",
      this.capabilities,
      {
        requested,
      },
    );
    this.modeStates[action.mode] = pending;
    const previousVisibility = this.browserVisibility;
    if (action.mode === "browser") this.browserVisibility = action.visibility;
    this.commit();
    try {
      const result = await this.gateway.run(
        { threadId: this.threadId, command },
        commandOptions(options?.signal ?? this.signal),
      );
      if (result.status === "aborted") {
        const error = cancelledError("The execution-mode command was cancelled.");
        this.modeStates[action.mode] = stateWithError(action.mode, "command", "omp-command", error);
        if (action.mode === "browser") this.browserVisibility = previousVisibility;
        this.commit();
        return modeCommandResult(
          action,
          command,
          false,
          "unavailable",
          error,
          error.message,
          capability,
        );
      }
      const capabilityState = this.capabilities[capability]?.state;
      const state: ModeStateKind = capabilityState === "fallback" ? "fallback" : "requested";
      const reply = result.outputs
        .map((output) => output.text.trim())
        .filter((text) => text.length > 0)
        .join("\n");
      const reason =
        capabilityState === "fallback"
          ? (stateReason(this.capabilities, capability) ?? "The host command gateway is limited.")
          : reply || undefined;
      this.modeStates[action.mode] = modeState(
        action.mode,
        "command",
        "omp-command",
        state,
        this.capabilities,
        { requested, reason },
      );
      this.commit();
      return modeCommandResult(action, command, true, state, undefined, reason, capability);
    } catch (cause) {
      const error = errorFrom(cause, "The execution-mode command could not finish.", capability);
      this.modeStates[action.mode] = stateWithError(action.mode, "command", "omp-command", error);
      if (action.mode === "browser") this.browserVisibility = previousVisibility;
      this.commit();
      return modeCommandResult(
        action,
        command,
        false,
        "unavailable",
        error,
        error.message,
        capability,
      );
    }
  }

  private applySessionProjection(projection: ModeSessionProjection): void {
    if (projection.fastModeEnabled === null || projection.fastModeActive === null) return;
    this.fast = this.fastFromValues(
      projection.fastModeEnabled,
      projection.fastModeActive,
      "known",
      undefined,
      undefined,
    );
    this.commit();
  }

  private fastFromValues(
    enabled: boolean,
    active: boolean,
    state: ModeStateKind,
    reason?: string,
    error?: AppError,
  ): FastModeStateValue {
    return FastModeState.parse({
      enabled,
      active,
      state,
      scope: "session",
      source: "omp-rpc",
      capability: "omp.cmd.set_fast_mode",
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
    });
  }

  private buildSnapshot(): ModeSnapshot {
    const modes = { ...this.modeStates };
    const states = Object.values(modes).filter((state): state is ModeState => state !== undefined);
    const tools = (
      Object.keys(TOOL_CAPABILITIES) as Array<Exclude<D73Mode, "default" | "fast">>
    ).map((mode) =>
      toolAvailability(mode, this.capabilities, {
        mode,
        capability: TOOL_CAPABILITIES[mode],
      }),
    );
    const snapshot = {
      modes,
      fast: this.fast,
      precedence: resolveModePrecedence(states),
      tools,
      revision: this.revision,
    };
    return ModeSnapshot.parse(snapshot) as ModeSnapshot;
  }

  private commit(): void {
    this.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export function createModeController(options: ModeControllerOptions): ModeController {
  return new ModeController(options);
}
