import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import {
  AppFailure,
  type CapabilityKey,
  type CommandRunResult,
  type OmpCommandGateway,
  type PortClient,
  type ThreadId,
  ThreadId as ThreadIdSchema,
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

export interface SessionLifecycleOptions {
  /** Reuses R1's existing folder-scoped new-session path through A0. */
  readonly remote: Pick<RemoteThreadListAdapter, "initialize">;
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

  public async newSession(): Promise<SessionCommandOutcome<ThreadId>> {
    const blocked = blockedByAvailability(this.getAvailability("new"));
    if (blocked) return blocked;
    try {
      const initialized = await this.remote.initialize("new");
      return { status: "completed", value: ThreadIdSchema.parse(initialized.remoteId) };
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
      // omp 18.12.6 answers an idle `/fresh` with its own message and `data.agentInvoked: false`, and sends no
      // prompt_result for it (rpc-mode.ts:1913-1916). omp 18.7.0 sent a prompt_result marked "aborted" after the
      // message, a marker that never meant the user cancelled. The user's own cancellation arrives as an
      // AppFailure("cancelled") from the call itself.
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
