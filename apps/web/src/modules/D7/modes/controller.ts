import {
  type AppError,
  AppError as AppErrorSchema,
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  modeChangeCommand,
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
  modeChangeRequest,
} from "./commands";
import { modeOutcomeRetryable, modeOutcomeText } from "./outcomes";

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

/** A cancelled change says so in the app's words, whichever layer raised the cancellation. */
function changeFailure(cause: unknown, capability: CapabilityKey): AppError {
  const error = errorFrom(cause, "The app could not reach omp. Try again.", capability);
  return error.code === "cancelled"
    ? { code: "cancelled", message: "The change was cancelled.", retryable: false, capability }
    : error;
}

function unavailableError(capability: CapabilityKey | undefined, message: string): AppError {
  return {
    code: "unavailable",
    message,
    retryable: false,
    ...(capability ? { capability } : {}),
  };
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

function initialFastState(
  capabilities: CapabilityMap,
  fastRpc: FastModeRpc | undefined,
): FastModeStateValue {
  const capability: CapabilityKey = "omp.cmd.set_fast_mode";
  if (!isCapabilityUsable(capabilities, capability) || fastRpc === undefined) {
    const error = unavailableError(
      capability,
      fastRpc === undefined
        ? "Fast mode is not available until the app is connected to omp."
        : "Fast mode is not available in this chat.",
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
    const error = unavailableError(capability, "These settings are not available here.");
    return stateWithError(mode, "session", "omp-command", error);
  }
  if (!isCapabilityUsable(capabilities, capability)) {
    return unavailableMode(
      mode,
      "session",
      "omp-command",
      "These settings are not available in this chat.",
    );
  }
  return modeState(mode, "session", "omp-command", "fallback", capabilities, {
    reason: "omp has not reported this setting yet.",
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
  /** The last Fast mode value omp reported; a failed change falls back to it. */
  private reportedFast: { readonly enabled: boolean; readonly active: boolean } | null = null;
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
      const error = unavailableError(capability, "omp cannot report these settings in this chat.");
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
          "omp did not say whether Fast mode is on.",
        );
      } else {
        this.reportFast(enabled, active);
      }
      this.commit();
      return this.snapshot;
    } catch (cause) {
      const error = errorFrom(cause, "The app could not reach omp. Try again.", capability);
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
        "Force execution applies only to omp's next reply, so this dialog does not offer it.",
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
        "This setting is changed somewhere else in the app.",
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
        "Standard execution is always on, so there is nothing to change.",
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
          ? "Fast mode is not available until the app is connected to omp."
          : "Fast mode is not available in this chat.",
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
    // The request is shown as chosen; the last value omp reported stays under it until omp answers.
    this.fast = this.fastFromValues(
      this.reportedFast?.enabled ?? false,
      this.reportedFast?.active ?? false,
      "requested",
      undefined,
      undefined,
      requested,
    );
    this.commit();
    try {
      const result = await this.fastRpc.setFastMode(
        { enabled: requested },
        commandOptions(options?.signal ?? this.signal),
      );
      this.reportFast(result.enabled, result.active);
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
      const error = errorFrom(cause, "The app could not reach omp. Try again.", capability);
      this.restoreFast();
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
  }

  private async requestCommand(
    action: ModeAction,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    const request = modeChangeRequest(action);
    if (request === null) {
      const error = unavailableError(undefined, "This setting cannot be changed in this chat.");
      return modeCommandResult(action, "mode command", false, "unavailable", error, error.message);
    }
    const command = modeChangeCommand(request);
    const capability: CapabilityKey = "host.command-gateway";
    if (this.gateway === undefined || !isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(
        capability,
        this.gateway === undefined
          ? "These settings are not available until the app is connected to omp."
          : "These settings are not available in this chat.",
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
    // The value omp last left this mode as: a change that omp does not complete goes back to it.
    const previous =
      this.modeStates[action.mode] ??
      initialModeState(action.mode, this.capabilities, this.gateway);
    this.modeStates[action.mode] = pending;
    const previousVisibility = this.browserVisibility;
    if (action.mode === "browser") this.browserVisibility = action.visibility;
    this.commit();
    try {
      const outcome = await this.gateway.change(
        { threadId: this.threadId, request },
        commandOptions(options?.signal ?? this.signal),
      );
      switch (outcome.outcome) {
        case "applied": {
          // omp made the change. A toggle reads as the value omp confirmed; a browser window reads as set, because
          // omp does not report which window is showing.
          if (outcome.mode === "browser") {
            this.browserVisibility = outcome.visibility;
            this.modeStates[action.mode] = modeState(
              action.mode,
              "command",
              "omp-command",
              "fallback",
              this.capabilities,
              { requested: true },
            );
            this.commit();
            return modeCommandResult(
              action,
              command,
              true,
              "fallback",
              undefined,
              undefined,
              capability,
            );
          }
          // A limited host link cannot claim omp's value, so the change reads as set, as the other states do.
          const state: ModeStateKind =
            this.capabilities[capability]?.state === "fallback" ? "fallback" : "known";
          this.modeStates[action.mode] = modeState(
            action.mode,
            "command",
            "omp-command",
            state,
            this.capabilities,
            { requested: outcome.on, enabled: outcome.on },
          );
          this.commit();
          return modeCommandResult(action, command, true, state, undefined, undefined, capability);
        }
        case "refused":
        case "unsupported": {
          // omp did not make the change: the mode goes back to the value omp last left it at, and the reason is said.
          const error: AppError = {
            code: "unavailable",
            message: modeOutcomeText(outcome),
            retryable: modeOutcomeRetryable(outcome),
            capability,
          };
          this.modeStates[action.mode] = previous;
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
        case "unknown": {
          // omp's reply is one the app does not recognise. It is shown as omp wrote it, as before, and the change is
          // not claimed as made.
          const reply = outcome.outputs
            .map((text) => text.trim())
            .filter((text) => text.length > 0)
            .join("\n");
          const capabilityState = this.capabilities[capability]?.state;
          const state: ModeStateKind = capabilityState === "fallback" ? "fallback" : "requested";
          const reason =
            capabilityState === "fallback"
              ? "The app can only partly change these settings right now."
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
        }
      }
    } catch (cause) {
      const error = changeFailure(cause, capability);
      this.modeStates[action.mode] = previous;
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
    this.reportFast(projection.fastModeEnabled, projection.fastModeActive);
    this.commit();
  }

  /** Keeps what omp reported for Fast mode, so a failed change can fall back to it. */
  private reportFast(enabled: boolean, active: boolean): void {
    this.reportedFast = { enabled, active };
    this.fast = this.fastFromValues(enabled, active, "known");
  }

  /**
   * After a failed Fast change the control shows the last value omp reported, and stays enabled.
   * Until omp has reported one, it shows neither value.
   */
  private restoreFast(): void {
    const reported = this.reportedFast;
    this.fast = reported
      ? this.fastFromValues(reported.enabled, reported.active, "known")
      : this.fastFromValues(false, false, "fallback");
  }

  private fastFromValues(
    enabled: boolean,
    active: boolean,
    state: ModeStateKind,
    reason?: string,
    error?: AppError,
    requested?: boolean,
  ): FastModeStateValue {
    return FastModeState.parse({
      enabled,
      active,
      state,
      scope: "session",
      source: "omp-rpc",
      capability: "omp.cmd.set_fast_mode",
      ...(requested === undefined ? {} : { requested }),
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
