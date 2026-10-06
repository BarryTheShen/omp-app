import {
  AppFailure,
  type CapabilityKey,
  CapabilityKey as CapabilityKeySchema,
  type SessionPinSetResult,
} from "@omp-app/contracts";
import type { SessionActionOutcome } from "../../R1/actions";
import type {
  SessionActionAvailability,
  SessionActionCommand,
  SessionActionSeam,
  SessionCommandOutcome,
  SessionCommandPort,
  SessionCommandPortOptions,
  SessionDeleteRequest,
  SessionInfoMetadata,
  SessionInfoSnapshot,
  SessionInfoSource,
  SessionPinRequest,
  SessionRenameRequest,
} from "../contract";
import {
  D5_COMMAND_CAPABILITIES,
  SessionDeleteRequest as SessionDeleteRequestSchema,
  SessionPinRequest as SessionPinRequestSchema,
  SessionRenameRequest as SessionRenameRequestSchema,
} from "../contract";

const UNAVAILABLE_REASONS: Readonly<Record<Exclude<SessionActionCommand, "pin">, string>> = {
  info: "Session details aren't available for this connection.",
  rename: "Renaming isn't available for this connection.",
  delete: "Deleting sessions isn't available for this connection.",
};

/**
 * D5's action adapter is intentionally thin: the R1.7 controller remains the only owner of
 * session-metadata mutation. This adapter only validates browser DTOs and maps AppFailure to the
 * browser result model.
 */
export class SessionCommandController implements SessionCommandPort {
  private readonly actions: SessionActionSeam;
  private readonly selectedSession: SessionCommandPortOptions["selectedSession"];
  private readonly info: SessionInfoSource;
  private readonly capabilities: SessionCommandPortOptions["capabilities"];

  public constructor(options: SessionCommandPortOptions) {
    this.actions = options.actions;
    this.selectedSession = options.selectedSession;
    this.info = options.info;
    this.capabilities = options.capabilities;
  }

  public getSnapshot(): SessionInfoSnapshot {
    return this.info.getSnapshot();
  }

  public subscribe(listener: (snapshot: SessionInfoSnapshot) => void): () => void {
    return this.info.subscribe(listener);
  }

  public getAvailability(command: SessionActionCommand): SessionActionAvailability {
    if (command === "pin") {
      const availability = this.actions.getPinAvailability();
      if (availability.state === "available") {
        const capability = CapabilityKeySchema.safeParse(availability.capability);
        if (capability.success) return { state: "available", capability: capability.data };
      }
      return {
        state: "unavailable",
        capability: "host.session-pins",
        reason: availability.reason ?? "Pinning is unavailable for this connection.",
      };
    }
    const capability = D5_COMMAND_CAPABILITIES[command];
    const status = this.capabilities.getSnapshot()[capability];
    if (status?.state === "available" || status?.state === "fallback") {
      return { state: "available", capability };
    }
    return {
      state: "unavailable",
      capability,
      reason: status?.detail?.trim() || UNAVAILABLE_REASONS[command],
    };
  }

  public async rename(request: SessionRenameRequest): Promise<SessionCommandOutcome<void>> {
    const parsed = SessionRenameRequestSchema.safeParse(request);
    if (!parsed.success) return invalidArgs("The session title must not be empty.");
    const blocked = blockedByAvailability(this.getAvailability("rename"));
    if (blocked) return blocked;
    const session = this.currentSession();
    if (session.status !== "ok") return session.result;
    try {
      return toOutcome(await this.actions.rename(session.value, parsed.data.title));
    } catch (error) {
      return failure(error, "Renaming the session failed.");
    }
  }

  public async pin(
    request: SessionPinRequest,
  ): Promise<SessionCommandOutcome<SessionPinSetResult>> {
    const parsed = SessionPinRequestSchema.safeParse(request);
    if (!parsed.success) return invalidArgs("The session pin request is invalid.");
    const blocked = blockedByAvailability(this.getAvailability("pin"));
    if (blocked) return blocked;
    const session = this.currentSession();
    if (session.status !== "ok") return session.result;
    try {
      return toOutcome(
        await this.actions.setPinned(
          session.value.id,
          parsed.data.pinned,
          parsed.data.expectedRevision,
        ),
      );
    } catch (error) {
      return failure(error, "Updating the session pin failed.");
    }
  }

  public async delete(request: SessionDeleteRequest = {}): Promise<SessionCommandOutcome<void>> {
    const parsed = SessionDeleteRequestSchema.safeParse(request);
    if (!parsed.success) return invalidArgs("The session delete request is invalid.");
    const blocked = blockedByAvailability(this.getAvailability("delete"));
    if (blocked) return blocked;
    const session = this.currentSession();
    if (session.status !== "ok") return session.result;
    try {
      return toOutcome(await this.actions.delete(session.value, parsed.data.confirmationId));
    } catch (error) {
      return failure(error, "Deleting the session failed.");
    }
  }

  private currentSession():
    | { readonly status: "ok"; readonly value: SessionInfoMetadata }
    | { readonly status: "error"; readonly result: SessionCommandOutcome<never> } {
    const selected = this.selectedSession.getSnapshot();
    if (selected === null) return { status: "error", result: notFound("No session is selected.") };
    if (selected.id !== this.info.getSnapshot().id) {
      return {
        status: "error",
        result: conflict("The selected session changed; refresh before trying again."),
      };
    }
    return { status: "ok", value: selected };
  }
}

function blockedByAvailability(
  availability: SessionActionAvailability,
): SessionCommandOutcome<never> | undefined {
  if (availability.state === "available") return undefined;
  return capabilityUnavailable(availability.capability, availability.reason);
}

function capabilityUnavailable(
  capability: CapabilityKey,
  message: string,
): SessionCommandOutcome<never> {
  return {
    status: "unavailable",
    error: new AppFailure({
      code: "unavailable",
      message,
      retryable: false,
      capability,
    }).appError,
  };
}

function toOutcome<Value>(result: SessionActionOutcome<Value>): SessionCommandOutcome<Value> {
  if (result.status === "completed") return result;
  if (result.status === "cancelled") return result;
  return {
    status: result.status,
    error: result.error.appError,
  };
}

function invalidArgs(message: string): SessionCommandOutcome<never> {
  return {
    status: "error",
    error: { code: "invalid_args", message, retryable: false },
  };
}

function notFound(message: string): SessionCommandOutcome<never> {
  return {
    status: "error",
    error: { code: "not_found", message, retryable: false },
  };
}

function conflict(message: string): SessionCommandOutcome<never> {
  return {
    status: "error",
    error: { code: "conflict", message, retryable: true },
  };
}

function failure(error: unknown, fallback: string): SessionCommandOutcome<never> {
  if (error instanceof AppFailure) {
    return {
      status: error.appError.code === "unavailable" ? "unavailable" : "error",
      error: error.appError,
    };
  }
  return {
    status: "error",
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
  };
}
