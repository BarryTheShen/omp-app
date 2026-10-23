import {
  AppFailure,
  type CapabilityKey,
  type CommandRunResult,
  type OmpCommandGateway,
  type OpenThreadResult,
  type PortClient,
  type ThreadId,
  UiRequestId as UiRequestIdSchema,
} from "@omp-app/contracts";
import type { DialogHost } from "../../U4/contract/dialog-host";
import type {
  SessionActionAvailability,
  SessionCapabilitiesSource,
  SessionCommand,
  SessionCommandOutcome,
  SessionInfoSource,
} from "../contract";

export type SessionLifecycleCommand = Extract<SessionCommand, "new" | "clear" | "fresh">;

/** Native capabilities required by the supported session lifecycle actions. */
export const SESSION_LIFECYCLE_CAPABILITIES = Object.freeze({
  new: "omp.cmd.new_session",
  clear: "upstream.session-clear",
  fresh: "host.command-gateway",
} as const satisfies Readonly<Record<SessionLifecycleCommand, CapabilityKey>>);

export type SessionLifecycleGateway = Pick<PortClient<typeof OmpCommandGateway>, "run">;

/** R1's New chat start: omp starts the chat once, and the caller takes that chat over (`adopt`) to show it. */
export interface NewSessionStart {
  startNew(): Promise<OpenThreadResult>;
  adopt(threadId: ThreadId): boolean;
}

export interface SessionLifecycleOptions {
  /** The page's New chat start (R1): omp starts the chat once, and the caller takes it over to show it, with no second open. */
  readonly remote: NewSessionStart;
  readonly gateway: SessionLifecycleGateway;
  readonly dialogs: Pick<DialogHost, "confirm">;
  readonly capabilities: SessionCapabilitiesSource;
  readonly session: SessionInfoSource;
}

/** Lifecycle actions for one selected session; session-file and omp-wire effects stay behind R1/A0/A1. */
export class SessionLifecycleController {
  private readonly remote: SessionLifecycleOptions["remote"];
  private readonly gateway: SessionLifecycleGateway;
  private readonly dialogs: SessionLifecycleOptions["dialogs"];
  private readonly capabilities: SessionCapabilitiesSource;
  private readonly session: SessionInfoSource;

  public constructor(options: SessionLifecycleOptions) {
    this.remote = options.remote;
    this.gateway = options.gateway;
    this.dialogs = options.dialogs;
    this.capabilities = options.capabilities;
    this.session = options.session;
  }

  public getAvailability(
    command: "clear",
  ): Extract<SessionActionAvailability, { readonly state: "unavailable" }>;
  public getAvailability(
    command: Exclude<SessionLifecycleCommand, "clear">,
  ): SessionActionAvailability;
  public getAvailability(command: SessionLifecycleCommand): SessionActionAvailability {
    const capability = SESSION_LIFECYCLE_CAPABILITIES[command];
    if (command === "clear") {
      return {
        state: "unavailable",
        capability,
        reason: "Clearing the conversation only works in the omp terminal for now.",
      };
    }

    const status = this.capabilities.getSnapshot()[capability];
    if (status?.state === "available" || status?.state === "fallback") {
      return { state: "available", capability };
    }
    return {
      state: "unavailable",
      capability,
      reason:
        status?.detail?.trim() ||
        (command === "new"
          ? "Starting a new session is unavailable for this connection."
          : "Refreshing provider state is unavailable for this connection."),
    };
  }

  /**
   * Starts a New chat the way the sidebar's New chat does: omp starts it once, and the caller shows the chat it returns.
   * A chat that a later open let go before this one took it over is cancelled: nothing opens for it.
   */
  public async newSession(): Promise<SessionCommandOutcome<OpenThreadResult>> {
    const blocked = blockedByAvailability(this.getAvailability("new"));
    if (blocked) return blocked;
    try {
      const started = await this.remote.startNew();
      if (!this.remote.adopt(started.threadId)) return { status: "cancelled" };
      return { status: "completed", value: started };
    } catch (error) {
      return failureOutcome(error, "Starting a new session failed.");
    }
  }

  public clear(): Promise<SessionCommandOutcome<never>> {
    return Promise.resolve(unavailableOutcome(this.getAvailability("clear")));
  }

  public async fresh(signal?: AbortSignal): Promise<SessionCommandOutcome<CommandRunResult>> {
    try {
      const blocked = blockedByAvailability(this.getAvailability("fresh"));
      if (blocked) return blocked;

      const threadId = this.session.getSnapshot().id;
      const confirmationOptions =
        signal === undefined
          ? { threadId, origin: "app" as const }
          : { threadId, signal, origin: "app" as const };
      const confirmed = await this.dialogs.confirm(
        {
          kind: "confirm",
          id: UiRequestIdSchema.parse(`app-d5-fresh-${crypto.randomUUID()}`),
          title: "Start a fresh connection to the model?",
          message:
            "This can fix a stuck or confused reply. Your conversation stays exactly as it is.",
        },
        confirmationOptions,
      );
      if (!confirmed) return { status: "cancelled" };
      if (this.session.getSnapshot().id !== threadId) {
        return {
          status: "error",
          error: {
            code: "conflict",
            message: "You switched sessions before the connection could be refreshed.",
            retryable: true,
          },
        };
      }

      const latestGate = blockedByAvailability(this.getAvailability("fresh"));
      if (latestGate) return latestGate;
      const callOptions = signal === undefined ? undefined : { signal };
      const result = await this.gateway.run({ threadId, command: "/fresh" }, callOptions);
      // omp ends an idle `/fresh` with a prompt_result marked "aborted" (observed on omp 18.7.0)
      // after printing its own message, so that marker does not mean the user cancelled. The
      // user's own cancellation arrives as an AppFailure("cancelled") from the call itself.
      return { status: "completed", value: result };
    } catch (error) {
      return failureOutcome(error, "Refreshing provider state failed.");
    }
  }
}

function blockedByAvailability(
  availability: SessionActionAvailability,
): SessionCommandOutcome<never> | undefined {
  if (availability.state === "available") return undefined;
  return unavailableOutcome(availability);
}

function unavailableOutcome(
  availability: Extract<SessionActionAvailability, { readonly state: "unavailable" }>,
): SessionCommandOutcome<never> {
  return {
    status: "unavailable",
    error: new AppFailure({
      code: "unavailable",
      message: availability.reason,
      retryable: false,
      capability: availability.capability,
    }).appError,
  };
}

function failureOutcome<Value>(error: unknown, fallback: string): SessionCommandOutcome<Value> {
  if (error instanceof AppFailure) {
    if (error.appError.code === "cancelled") return { status: "cancelled" };
    return {
      status: error.appError.code === "unavailable" ? "unavailable" : "error",
      error: error.appError,
    };
  }
  return {
    status: "error",
    error: { code: "internal", message: fallback, retryable: true },
  };
}
