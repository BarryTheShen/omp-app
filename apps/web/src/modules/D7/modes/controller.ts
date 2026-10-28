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
import type { ExecutionModePort, ModeCommandGateway, ModeRpc } from "../contract";
import {
  type ExecutionMode,
  FastModeState,
  type FastModeState as FastModeStateValue,
  type GetStateResult,
  type ModeCommandResult,
  ModeRequest,
  type ModeRequest as ModeRequestValue,
  type ModeScope,
  ModeSnapshot,
  ModeState,
  type ModeStateKind,
  modeState,
  resolveModePrecedence,
  toolAvailability,
  type UsageLimitStage,
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
import { SLOW_UNSUPPORTED_TEXT } from "./slow";

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
  readonly rpc?: ModeRpc;
  readonly session?: ModeSessionSource;
  readonly signal?: PortCallOptions["signal"];
  /** Told when omp refuses a Fast mode change, so the surface can let go of omp's own notice about it. */
  readonly onFastRefused?: () => void;
}

/** The source omp gives the info notice it sends with a refused service-tier change (`setFastMode`). */
export const FAST_REFUSAL_NOTICE_SOURCE = "priority";

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
  (mode): mode is Exclude<D73Mode, "default" | "fast" | "slow"> =>
    mode !== "default" && mode !== "fast" && mode !== "slow",
);

const TOOL_CAPABILITIES: Readonly<
  Partial<Record<Exclude<D73Mode, "default" | "fast">, CapabilityKey>>
> = {
  browser: "host.command-gateway",
  computer: "host.command-gateway",
};

/** The capability that turns Slow mode on or off; its state is read under the same name. */
const SLOW_CAPABILITY: CapabilityKey = "omp.cmd.set_slow_mode";

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

/** A failed Slow mode change is said in the app's words: omp's own error text is not shown. */
function slowChangeFailure(cause: unknown): AppError {
  if (cause instanceof AppFailure && cause.appError.code === "cancelled") {
    return {
      code: "cancelled",
      message: "The change was cancelled.",
      retryable: false,
      capability: SLOW_CAPABILITY,
    };
  }
  return {
    code: "internal",
    message: "omp did not make the change. Try again.",
    retryable: true,
    capability: SLOW_CAPABILITY,
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
  rpc: ModeRpc | undefined,
): FastModeStateValue {
  const capability: CapabilityKey = "omp.cmd.set_fast_mode";
  if (!isCapabilityUsable(capabilities, capability) || rpc === undefined) {
    const error = unavailableError(
      capability,
      rpc === undefined
        ? "Fast mode is not available until the app is connected to omp."
        : "Fast mode is not available in this chat.",
    );
    return FastModeState.parse({
      enabled: false,
      active: false,
      state: "unavailable",
      scope: "session",
      source: "omp-session",
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
    source: "omp-session",
    capability,
  });
}

function initialModeState(
  mode: Exclude<D73Mode, "fast" | "slow">,
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

/** Slow mode before omp has answered: the line says it is being checked, and neither choice is set. */
function initialSlowState(capabilities: CapabilityMap, rpc: ModeRpc | undefined): ModeState {
  if (rpc === undefined) {
    const error = unavailableError(
      SLOW_CAPABILITY,
      "Slow mode is not available until the app is connected to omp.",
    );
    return stateWithError("slow", "session", "omp-session", error);
  }
  if (!isCapabilityUsable(capabilities, SLOW_CAPABILITY)) {
    const error = unavailableError(SLOW_CAPABILITY, "Slow mode is not available in this chat.");
    return stateWithError("slow", "session", "omp-session", error);
  }
  return ModeState.parse({
    mode: "slow",
    state: "requested",
    scope: "session",
    source: "omp-session",
    capability: SLOW_CAPABILITY,
  });
}

/** Slow mode omp reported on or off: both buttons show that choice, with its scope and any usage-limit stage. */
function slowKnownState(
  enabled: boolean,
  scope: ModeScope,
  usageLimit: UsageLimitStage | undefined,
): ModeState {
  return ModeState.parse({
    mode: "slow",
    state: "known",
    scope,
    source: "omp-session",
    capability: SLOW_CAPABILITY,
    requested: enabled,
    enabled,
    ...(usageLimit ? { usageLimit } : {}),
  });
}

function commandOptions(
  signal: PortCallOptions["signal"] | undefined,
): ModeRequestOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

/**
 * Browser-side mode controller. It owns no omp state: Fast and Slow mode come from the injected mode RPC port,
 * and the other slash commands go through A1's typed gateway, which returns typed outcomes.
 */
export class ModeController implements ModeControllerPort {
  private capabilities: CapabilityMap;
  private readonly threadId: ThreadId;
  private readonly gateway: ModeCommandGateway | undefined;
  private readonly rpc: ModeRpc | undefined;
  private readonly session: ModeSessionSource | undefined;
  private readonly signal: PortCallOptions["signal"] | undefined;
  private readonly onFastRefused: (() => void) | undefined;
  private readonly listeners = new Set<ModeControllerListener>();
  private readonly unsubscribeSession: (() => void) | undefined;
  private snapshot: ModeSnapshot;
  private fast: FastModeStateValue;
  /** The last Fast mode value omp reported; a failed change falls back to it. */
  private reportedFast: { readonly enabled: boolean; readonly active: boolean } | null = null;
  /** Whether omp last said Slow mode is offered on this model; null until it has said. */
  private slowSupported: boolean | null = null;
  /** omp's last get_state answer, so a change in the host's capabilities re-reads it without a refresh. */
  private reportedSlow: GetStateResult | null = null;
  private browserVisibility: BrowserVisibility | null = null;
  private revision = 0;
  private modeStates: Partial<Record<ExecutionMode, ModeState>>;

  constructor(options: ModeControllerOptions) {
    this.capabilities = options.capabilities;
    this.threadId = options.threadId;
    this.gateway = options.gateway;
    this.rpc = options.rpc;
    this.session = options.session;
    this.signal = options.signal;
    this.onFastRefused = options.onFastRefused;
    this.fast = initialFastState(this.capabilities, this.rpc);
    this.modeStates = Object.fromEntries(
      D73_MODES.filter(
        (mode): mode is Exclude<D73Mode, "fast" | "slow"> => mode !== "fast" && mode !== "slow",
      ).map((mode) => [mode, initialModeState(mode, this.capabilities, this.gateway)]),
    ) as Partial<Record<ExecutionMode, ModeState>>;
    this.modeStates.slow = initialSlowState(this.capabilities, this.rpc);
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
      this.fast = initialFastState(capabilities, this.rpc);
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
    if (this.reportedSlow !== null) {
      this.reportSlow(this.reportedSlow);
    } else if (
      !isCapabilityUsable(capabilities, SLOW_CAPABILITY) ||
      this.modeStates.slow?.state === "unavailable"
    ) {
      this.modeStates.slow = initialSlowState(capabilities, this.rpc);
    }
    this.commit();
  }

  public async refresh(options?: ModeRequestOptions): Promise<ModeSnapshot> {
    if (this.rpc === undefined) {
      this.commit();
      return this.snapshot;
    }
    const capability: CapabilityKey = "omp.cmd.get_state";
    if (!isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(capability, "omp cannot report these settings in this chat.");
      this.fast = this.fastFromValues(false, false, "unavailable", error.message, error);
      this.failSlowRead("omp cannot report these settings in this chat.");
      this.commit();
      throw new AppFailure(error);
    }
    try {
      const state = await this.rpc.getState(commandOptions(options?.signal ?? this.signal));
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
      this.reportSlow(state);
      this.commit();
      return this.snapshot;
    } catch (cause) {
      const error = errorFrom(cause, "The app could not reach omp. Try again.", capability);
      this.fast = this.fastFromValues(false, false, "unavailable", error.message, error);
      this.failSlowRead("The app could not reach omp. Try again.");
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
    if (parsed.mode === "slow") return this.requestSlow(parsed.requested, options);
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
        mode: parsed.mode as Exclude<D73Mode, "default" | "fast" | "browser" | "slow">,
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
    if (this.rpc === undefined || !isCapabilityUsable(this.capabilities, capability)) {
      const error = unavailableError(
        capability,
        this.rpc === undefined
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
      const result = await this.rpc.setFastMode(
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
      if (cause instanceof AppFailure && cause.appError.code === "omp_error") {
        this.onFastRefused?.();
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

  private async requestSlow(
    requested: boolean,
    options?: ModeRequestOptions,
  ): Promise<ModeCommandResult> {
    const command = "set_slow_mode";
    if (this.rpc === undefined || !isCapabilityUsable(this.capabilities, SLOW_CAPABILITY)) {
      const error = unavailableError(
        SLOW_CAPABILITY,
        this.rpc === undefined
          ? "Slow mode is not available until the app is connected to omp."
          : "Slow mode is not available in this chat.",
      );
      this.modeStates.slow = stateWithError("slow", "session", "omp-session", error);
      this.commit();
      return modeCommandResult(
        { mode: "slow", requested },
        command,
        false,
        "unavailable",
        error,
        error.message,
        SLOW_CAPABILITY,
      );
    }
    // The choice is shown as made until omp answers; the value omp last left stays underneath.
    const previous = this.modeStates.slow ?? initialSlowState(this.capabilities, this.rpc);
    // get_state confirms scope; set_slow_mode only confirms the toggle.
    const reportedScope =
      this.reportedSlow?.slowModeSupported === true ? previous.scope : "default";
    const reportedUsageLimit =
      this.reportedSlow?.slowModeSupported === true ? previous.usageLimit : undefined;
    this.modeStates.slow = ModeState.parse({
      mode: "slow",
      state: "requested",
      scope: reportedScope,
      source: "omp-session",
      capability: SLOW_CAPABILITY,
      requested,
      ...(reportedUsageLimit ? { usageLimit: reportedUsageLimit } : {}),
    });
    this.commit();
    try {
      const result = await this.rpc.setSlowMode(
        { enabled: requested },
        commandOptions(options?.signal ?? this.signal),
      );
      this.modeStates.slow = slowKnownState(result.enabled, reportedScope, reportedUsageLimit);
      this.commit();
      // omp announces no event for a change, so the usage-limit stage is read again from get_state.
      await this.refresh(options).catch(() => undefined);
      return modeCommandResult(
        { mode: "slow", requested },
        command,
        true,
        this.modeStates.slow?.state ?? "known",
        undefined,
        undefined,
        SLOW_CAPABILITY,
      );
    } catch (cause) {
      this.modeStates.slow = previous;
      this.commit();
      // omp's own reply is not shown: its typed state says whether the model has slow mode at all.
      await this.refresh(options).catch(() => undefined);
      const error =
        this.slowSupported === false
          ? unavailableError(SLOW_CAPABILITY, SLOW_UNSUPPORTED_TEXT)
          : slowChangeFailure(cause);
      return modeCommandResult(
        { mode: "slow", requested },
        command,
        false,
        "unavailable",
        error,
        error.message,
        SLOW_CAPABILITY,
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

  /** Slow mode as omp's get_state reports it: not offered on this model, or on or off with its scope and stage. */
  private reportSlow(state: GetStateResult): void {
    this.reportedSlow = state;
    const supported = state.slowModeSupported;
    if (supported === undefined) {
      this.slowSupported = null;
      this.modeStates.slow = ModeState.parse({
        mode: "slow",
        state: "fallback",
        scope: "session",
        source: "omp-session",
        capability: SLOW_CAPABILITY,
        reason: "omp has not reported Slow mode yet.",
      });
      return;
    }
    this.slowSupported = supported;
    if (!supported) {
      this.modeStates.slow = ModeState.parse({
        mode: "slow",
        state: "unavailable",
        scope: "session",
        source: "omp-session",
        reason: SLOW_UNSUPPORTED_TEXT,
      });
      return;
    }
    if (!isCapabilityUsable(this.capabilities, SLOW_CAPABILITY)) {
      this.modeStates.slow = initialSlowState(this.capabilities, this.rpc);
      return;
    }
    this.modeStates.slow = slowKnownState(
      state.slowModeEnabled ?? false,
      state.slowModeScope === "global" ? "settings" : "session",
      state.usageLimit,
    );
  }

  /** A failed read leaves Slow mode unavailable, in the app's words, with no claim about omp's value. */
  private failSlowRead(message: string): void {
    this.slowSupported = null;
    this.reportedSlow = null;
    const error = unavailableError("omp.cmd.get_state", message);
    this.modeStates.slow = stateWithError("slow", "session", "omp-session", error);
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
      source: "omp-session",
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
